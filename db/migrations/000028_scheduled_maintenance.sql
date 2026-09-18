-- Built-in Principals have no credentials and only their maintenance function grant.
CREATE TABLE control.system_principals (
  name text PRIMARY KEY CHECK (name IN ('retention','operations')),
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  UNIQUE(name,id)
);
INSERT INTO control.system_principals(name) VALUES('retention'),('operations');
REVOKE ALL ON control.system_principals FROM PUBLIC,bp_server,bp_executor;
GRANT SELECT ON control.system_principals TO bp_server;
ALTER TABLE control.principals ADD COLUMN system text CHECK (system IN ('retention','operations'));
ALTER TABLE control.principals ADD CONSTRAINT principal_system_identity FOREIGN KEY(system,id) REFERENCES control.system_principals(name,id);
CREATE UNIQUE INDEX principal_system ON control.principals(workspace_id,system) WHERE system IS NOT NULL;
GRANT SELECT(system) ON control.principals TO bp_audit;
GRANT SELECT(id,workspace_id,system) ON control.principals TO bp_queue;
CREATE FUNCTION control.install_system_principals(w uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE purpose text; principal uuid; role_name text;
BEGIN
  FOREACH purpose IN ARRAY ARRAY['retention','operations'] LOOP
    SELECT id INTO STRICT principal FROM control.system_principals WHERE name=purpose;
    role_name:='bp_'||purpose||'_'||replace(w::text,'-','');
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    INSERT INTO control.principals(id,workspace_id,name,role_name,system) VALUES(principal,w,purpose,role_name,purpose);
    IF purpose='retention' THEN
      EXECUTE format('GRANT USAGE ON SCHEMA queue TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION queue.purge_payloads(uuid,integer) TO %I',role_name);
    ELSE
      EXECUTE format('GRANT USAGE ON SCHEMA control TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION control.record_disk_sample(bigint,bigint) TO %I',role_name);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION control.install_system_principals(uuid) FROM PUBLIC,bp_server,bp_executor;
CREATE FUNCTION control.workspace_system_principals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM control.install_system_principals(NEW.id); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION control.workspace_system_principals() FROM PUBLIC,bp_server,bp_executor;
CREATE TRIGGER workspace_system_principals AFTER INSERT ON control.workspaces
FOR EACH ROW EXECUTE FUNCTION control.workspace_system_principals();
CREATE FUNCTION control.protect_system_principal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='principal_keys' THEN
    IF EXISTS (SELECT FROM control.principals WHERE workspace_id=NEW.workspace_id AND id=NEW.principal_id AND system IS NOT NULL)
      THEN RAISE EXCEPTION 'system_principal_credential_forbidden'; END IF;
  ELSIF OLD.system IS NOT NULL OR NEW.system IS DISTINCT FROM OLD.system THEN
    RAISE EXCEPTION 'system_principal_immutable';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control.protect_system_principal() FROM PUBLIC,bp_server,bp_executor;
CREATE TRIGGER system_principal_immutable BEFORE UPDATE ON control.principals FOR EACH ROW EXECUTE FUNCTION control.protect_system_principal();
CREATE TRIGGER system_principal_credential BEFORE INSERT OR UPDATE ON control.principal_keys FOR EACH ROW EXECUTE FUNCTION control.protect_system_principal();
CREATE FUNCTION queue.retention_actor(w uuid) RETURNS audit.bound_context
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  SELECT * INTO c FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id() AND workspace_id=w;
  IF c.user_id IS NOT NULL THEN RETURN queue.reconciliation_actor(w); END IF;
  IF c.run_id IS NULL OR NOT EXISTS (SELECT FROM control.principals WHERE workspace_id=w AND id=c.principal_id AND system='retention')
    THEN RAISE EXCEPTION 'retention_forbidden'; END IF;
  PERFORM control.assert_restore_open();
  RETURN c;
END $$;
ALTER FUNCTION queue.retention_actor(uuid) OWNER TO bp_queue;
REVOKE ALL ON FUNCTION queue.retention_actor(uuid) FROM PUBLIC,bp_server,bp_executor;
CREATE OR REPLACE FUNCTION queue.purge_payloads(w uuid,budget integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q queue.queues; copy record; item record; storage text; remaining integer:=budget; expired_before timestamptz:=clock_timestamp();
  scrubbed integer:=0; archived integer:=0; migrations integer:=0; reconciliations integer:=0; more boolean:=false;
BEGIN
  PERFORM queue.retention_actor(w);
  IF budget IS NULL OR budget NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  <<copies>>
  FOR q IN SELECT * FROM queue.queues WHERE workspace_id=w ORDER BY name LOOP
    FOREACH storage IN ARRAY ARRAY['q_','a_'] LOOP
      FOR copy IN EXECUTE format(
        'WITH ids AS (SELECT m.pgmq_msg_id FROM queue.messages m WHERE m.workspace_id=$1 AND m.queue=$2 AND m.expires_at<=$3
          UNION SELECT d.pgmq_msg_id FROM queue.messages m JOIN queue.deliveries d
          ON (d.workspace_id,d.queue,d.message_id)=(m.workspace_id,m.queue,m.id)
          WHERE m.workspace_id=$1 AND m.queue=$2 AND m.expires_at<=$3)
        SELECT p.msg_id FROM pgmq.%I p JOIN ids ON ids.pgmq_msg_id=p.msg_id
        WHERE $4 OR p.message IS DISTINCT FROM ''null''::jsonb ORDER BY p.msg_id LIMIT $5',storage||q.pgmq_queue)
        USING w,q.name,expired_before,storage='a_',remaining+1
      LOOP
        IF remaining=0 THEN more:=true; EXIT copies; END IF;
        IF storage='q_' THEN
          EXECUTE format('UPDATE pgmq.%I SET message=''null''::jsonb WHERE msg_id=$1',storage||q.pgmq_queue) USING copy.msg_id;
          scrubbed:=scrubbed+1;
        ELSE
          EXECUTE format('DELETE FROM pgmq.%I WHERE msg_id=$1',storage||q.pgmq_queue) USING copy.msg_id;
          archived:=archived+1;
        END IF;
        remaining:=remaining-1;
      END LOOP;
    END LOOP;
  END LOOP;
  FOR item IN SELECT revision FROM control.workspace_migrations WHERE workspace_id=w
    AND expires_at<=expired_before AND sql IS NOT NULL ORDER BY expires_at,revision LIMIT remaining+1
  LOOP
    IF remaining=0 THEN more:=true; EXIT; END IF;
    UPDATE control.workspace_migrations SET sql=NULL WHERE workspace_id=w AND revision=item.revision;
    migrations:=migrations+1; remaining:=remaining-1;
  END LOOP;
  FOR item IN SELECT id FROM control.reconciliations WHERE workspace_id=w
    AND expires_at<=expired_before AND evidence IS NOT NULL ORDER BY expires_at,id LIMIT remaining+1
  LOOP
    IF remaining=0 THEN more:=true; EXIT; END IF;
    UPDATE control.reconciliations SET evidence=NULL WHERE workspace_id=w AND id=item.id;
    reconciliations:=reconciliations+1; remaining:=remaining-1;
  END LOOP;
  RETURN jsonb_build_object('counts',jsonb_build_object('queueBodies',scrubbed,'archiveRows',archived,
    'migrationSql',migrations,'reconciliationEvidence',reconciliations),'hasMore',more);
END $$;
ALTER FUNCTION queue.purge_payloads(uuid,integer) OWNER TO bp_queue;
CREATE OR REPLACE FUNCTION control.stamp_blob()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context; w uuid;
BEGIN
  w:=CASE WHEN TG_OP='DELETE'
    THEN OLD.workspace_id ELSE NEW.workspace_id END;
  SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid()
      AND xid=pg_current_xact_id() AND workspace_id=w;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_missing'; END IF;

  IF TG_OP='INSERT' THEN
    IF c.principal_id IS NULL OR c.run_id IS NULL THEN
      RAISE EXCEPTION 'run_required';
    END IF;
    NEW.principal_id:=c.principal_id;
    NEW.run_id:=c.run_id;
    NEW.created_at:=clock_timestamp();
    NEW.expires_at:=NEW.created_at+make_interval(secs=>coalesce(
      (SELECT seconds FROM control.retention_settings
       WHERE workspace_id=w),2592000));
    RETURN NEW;
  END IF;

  IF c.user_id IS NULL THEN
    IF c.principal_id IS DISTINCT FROM OLD.principal_id AND NOT (OLD.expires_at<=clock_timestamp() AND EXISTS (SELECT FROM control.principals WHERE workspace_id=w AND id=c.principal_id AND system='retention')) THEN
      RAISE EXCEPTION 'blob_forbidden';
    END IF;
  ELSIF NOT EXISTS (
    SELECT FROM control.member m JOIN control.workspaces ws
      ON ws.organization_id=m."organizationId"
    WHERE ws.id=w AND m."userId"=c.user_id
  ) THEN RAISE EXCEPTION 'workspace_forbidden';
  END IF;
  RETURN OLD;
END $$;

ALTER FUNCTION control.stamp_blob() OWNER TO bp_audit;
CREATE TABLE control.disk_samples (
  observed_at timestamptz PRIMARY KEY DEFAULT clock_timestamp(),
  database_bytes bigint NOT NULL CHECK (database_bytes>=0),
  blob_bytes bigint NOT NULL CHECK (blob_bytes>=0),
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  principal_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES control.runs(id),
  FOREIGN KEY(workspace_id,principal_id) REFERENCES control.principals(workspace_id,id)
);
REVOKE ALL ON control.disk_samples FROM PUBLIC,bp_server,bp_executor;
GRANT SELECT ON control.disk_samples TO bp_server;
CREATE FUNCTION control.record_disk_sample(database_bytes bigint,blob_bytes bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  SELECT * INTO c FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
  IF c.run_id IS NULL OR NOT EXISTS (SELECT FROM control.principals WHERE workspace_id=c.workspace_id AND id=c.principal_id AND system='operations')
    THEN RAISE EXCEPTION 'operations_forbidden'; END IF;
  INSERT INTO control.disk_samples(database_bytes,blob_bytes,workspace_id,principal_id,run_id)
    VALUES(database_bytes,blob_bytes,c.workspace_id,c.principal_id,c.run_id);
  DELETE FROM control.disk_samples WHERE observed_at NOT IN (SELECT observed_at FROM control.disk_samples ORDER BY observed_at DESC LIMIT 60);
END $$;
REVOKE ALL ON FUNCTION control.record_disk_sample(bigint,bigint) FROM PUBLIC,bp_executor;
GRANT EXECUTE ON FUNCTION control.record_disk_sample(bigint,bigint) TO bp_server;
SELECT control.install_system_principals(id) FROM control.workspaces;
CREATE INDEX events_latest ON audit.events(occurred_at DESC);
CREATE INDEX events_latest_purge ON audit.events(occurred_at DESC) WHERE kind='retention.purged';
