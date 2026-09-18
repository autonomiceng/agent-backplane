-- Invocation authority is separate from immutable Run provenance (ADR-0019).
ALTER TABLE control.runs ADD COLUMN parent_run_id uuid REFERENCES control.runs(id),
  ADD COLUMN invocation_deployment_id uuid,
  ADD CONSTRAINT invocation_deployment_fk FOREIGN KEY (workspace_id,invocation_deployment_id)
    REFERENCES control.deployments(workspace_id,id),
  ADD CONSTRAINT invocation_parent_required CHECK (invocation_deployment_id IS NULL OR parent_run_id IS NOT NULL);
CREATE TABLE control.invocation_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
  run_id uuid NOT NULL UNIQUE REFERENCES control.runs(id), expires_at timestamptz NOT NULL, restore_epoch uuid
);
CREATE INDEX invocation_token_expiry ON control.invocation_tokens(expires_at);
ALTER TABLE control.invocation_tokens OWNER TO bp_audit;
REVOKE ALL ON control.invocation_tokens FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.invocation_tokens TO bp_server;
GRANT SELECT,INSERT ON control.runs TO bp_audit;
GRANT SELECT ON control.deployments,control.principal_keys,control.principals,control.restore_gate TO bp_audit;
-- PostgreSQL requires UPDATE privilege for SELECT FOR SHARE; these grants are confined to the definer role.
GRANT UPDATE(status) ON control.deployments,control.principals TO bp_audit;
GRANT UPDATE(revoked_at) ON control.principal_keys TO bp_audit;
CREATE FUNCTION control.guard_invocation_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  IF NEW.parent_run_id IS NULL AND NEW.invocation_deployment_id IS NULL THEN RETURN NEW; END IF;
  IF current_user<>'bp_audit' THEN RAISE EXCEPTION 'invocation_scope_forbidden'; END IF;
  SELECT * INTO c FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
  IF c.principal_id IS NULL OR c.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR c.run_id IS DISTINCT FROM NEW.parent_run_id OR NEW.invocation_deployment_id IS NULL
    OR NOT EXISTS (SELECT FROM control.runs WHERE id=c.run_id AND workspace_id=NEW.workspace_id)
    THEN RAISE EXCEPTION 'run_forbidden'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION control.guard_invocation_run() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION control.guard_invocation_run() FROM PUBLIC,bp_executor,bp_server;
CREATE TRIGGER invocation_run_context BEFORE INSERT ON control.runs FOR EACH ROW EXECUTE FUNCTION control.guard_invocation_run();
CREATE FUNCTION control.create_invocation(deployment_id uuid,credential_hash bytea,timeout_ms integer)
RETURNS TABLE (run_id uuid,principal_id uuid,expires_at timestamptz,remaining_ms double precision)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context; d control.deployments; epoch uuid;
BEGIN
  SELECT * INTO c FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
  IF c.principal_id IS NULL OR c.run_id IS NULL THEN RAISE EXCEPTION 'run_required'; END IF;
  IF EXISTS (SELECT FROM control.runs WHERE id=c.run_id AND invocation_deployment_id IS NOT NULL)
    THEN RAISE EXCEPTION 'invocation_scope_forbidden'; END IF;
  IF timeout_ms IS NULL OR timeout_ms<1 OR credential_hash IS NULL OR octet_length(credential_hash)<>32
    THEN RAISE EXCEPTION 'invalid_input'; END IF;
  PERFORM control.assert_restore_open();
  SELECT g.epoch INTO epoch FROM control.restore_gate g WHERE singleton;
  SELECT * INTO d FROM control.deployments WHERE workspace_id=c.workspace_id AND id=deployment_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'function_not_found'; END IF;
  PERFORM 1 FROM control.principals p JOIN control.principal_keys k ON (k.workspace_id,k.principal_id)=(p.workspace_id,p.id)
    WHERE p.workspace_id=c.workspace_id AND p.id=d.principal_id AND p.status='active' AND k.revoked_at IS NULL FOR SHARE OF p,k;
  IF NOT FOUND THEN RAISE EXCEPTION 'function_not_found'; END IF;
  run_id:=gen_random_uuid(); principal_id:=d.principal_id; expires_at:=clock_timestamp()+timeout_ms*interval '1 millisecond';
  INSERT INTO control.runs(id,workspace_id,principal_id,parent_run_id,invocation_deployment_id,metadata)
    VALUES(run_id,c.workspace_id,d.principal_id,c.run_id,d.id,jsonb_build_object(
      'callerPrincipalId',c.principal_id,'callerRunId',c.run_id,'deploymentId',d.id));
  INSERT INTO control.invocation_tokens VALUES(credential_hash,run_id,expires_at,epoch);
  remaining_ms:=extract(epoch FROM expires_at-clock_timestamp())*1000;
  RETURN NEXT;
END $$;
CREATE FUNCTION control.sweep_invocation_tokens() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w uuid;
BEGIN
  SELECT workspace_id INTO w FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
  IF w IS NULL THEN RAISE EXCEPTION 'context_missing'; END IF;
  DELETE FROM control.invocation_tokens WHERE token_hash IN (
    SELECT t.token_hash FROM control.invocation_tokens t JOIN control.runs r ON r.id=t.run_id
      WHERE r.workspace_id=w AND t.expires_at<=clock_timestamp() ORDER BY t.expires_at LIMIT 100);
END $$;
CREATE FUNCTION audit.bind_context(workspace_id uuid,principal_id uuid,run_id uuid,user_id text,token text,invocation_hash bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF workspace_id IS NULL OR token IS NULL OR token='' OR NOT (
    (principal_id IS NOT NULL AND run_id IS NOT NULL AND user_id IS NULL)
    OR (principal_id IS NULL AND run_id IS NULL AND user_id IS NOT NULL)) THEN RAISE EXCEPTION 'context_invalid'; END IF;
  DELETE FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid<>pg_current_xact_id();
  BEGIN
    INSERT INTO audit.bound_context(backend_pid,xid,token,workspace_id,principal_id,run_id,user_id)
      VALUES(pg_backend_pid(),pg_current_xact_id(),token,workspace_id,principal_id,run_id,user_id);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'context_already_bound'; END;
  PERFORM audit.lock_workspace(workspace_id);
  IF principal_id IS NOT NULL THEN PERFORM control.assert_restore_open(); END IF;
  IF principal_id IS NOT NULL AND NOT EXISTS (SELECT FROM control.principals p
    WHERE p.workspace_id=bind_context.workspace_id AND p.id=bind_context.principal_id AND p.status='active')
    THEN RAISE EXCEPTION 'principal_revoked'; END IF;
  IF principal_id IS NOT NULL AND NOT EXISTS (SELECT FROM control.runs r WHERE r.id=bind_context.run_id
    AND r.workspace_id=bind_context.workspace_id AND r.principal_id=bind_context.principal_id)
    THEN RAISE EXCEPTION 'run_forbidden'; END IF;
  IF EXISTS (SELECT FROM control.runs r WHERE r.id=bind_context.run_id AND r.invocation_deployment_id IS NOT NULL)
    AND NOT EXISTS (SELECT FROM control.invocation_tokens t JOIN control.principal_keys k
      ON (k.workspace_id,k.principal_id)=(bind_context.workspace_id,bind_context.principal_id)
      JOIN control.restore_gate g ON g.singleton WHERE t.run_id=bind_context.run_id AND t.token_hash=invocation_hash
      AND t.expires_at>clock_timestamp() AND k.revoked_at IS NULL AND NOT g.active
      AND t.restore_epoch IS NOT DISTINCT FROM g.epoch) THEN RAISE EXCEPTION 'unauthorized'; END IF;
END $$;
CREATE OR REPLACE FUNCTION audit.bind_context(workspace_id uuid,principal_id uuid,run_id uuid,user_id text,token text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT audit.bind_context($1,$2,$3,$4,$5,NULL::bytea)
$$;
CREATE FUNCTION control.finish_invocation(invocation_run uuid,event_kind text,duration_ms integer,http_status integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r control.runs; token text:=gen_random_uuid()::text;
BEGIN
  IF event_kind IS NULL OR event_kind NOT IN ('function.complete','function.fail','function.timeout')
    OR duration_ms IS NULL OR duration_ms<0 OR (http_status IS NOT NULL AND http_status NOT BETWEEN 100 AND 599)
    THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO r FROM control.runs WHERE id=invocation_run AND invocation_deployment_id IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'run_forbidden'; END IF;
  BEGIN
    PERFORM audit.lock_workspace(r.workspace_id);
    IF NOT EXISTS (SELECT FROM audit.events WHERE workspace_id=r.workspace_id AND run_id=r.id
      AND kind IN ('function.complete','function.fail','function.timeout')) THEN
      DELETE FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid<>pg_current_xact_id();
      INSERT INTO audit.bound_context(backend_pid,xid,token,workspace_id,principal_id,run_id)
        VALUES(pg_backend_pid(),pg_current_xact_id(),token,r.workspace_id,r.principal_id,r.id);
      PERFORM audit.emit(token,event_kind,ARRAY[r.invocation_deployment_id::text,r.id::text],NULL,
        jsonb_build_object('durationMs',duration_ms,'status',http_status,'reason',event_kind));
    END IF;
  EXCEPTION WHEN lock_not_available OR serialization_failure OR deadlock_detected THEN
    -- A failed terminal audit lock must still revoke authority; a later call records the terminal event.
    NULL;
  END;
  DELETE FROM control.invocation_tokens WHERE run_id=r.id;
END $$;
ALTER FUNCTION audit.bind_context(uuid,uuid,uuid,text,text,bytea) OWNER TO bp_audit;
ALTER FUNCTION audit.bind_context(uuid,uuid,uuid,text,text) OWNER TO bp_audit;
ALTER FUNCTION control.create_invocation(uuid,bytea,integer) OWNER TO bp_audit;
ALTER FUNCTION control.finish_invocation(uuid,text,integer,integer) OWNER TO bp_audit;
ALTER FUNCTION control.sweep_invocation_tokens() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION audit.bind_context(uuid,uuid,uuid,text,text,bytea),control.create_invocation(uuid,bytea,integer),
  control.finish_invocation(uuid,text,integer,integer),control.sweep_invocation_tokens() FROM PUBLIC,bp_executor;
GRANT EXECUTE ON FUNCTION audit.bind_context(uuid,uuid,uuid,text,text,bytea),control.create_invocation(uuid,bytea,integer),
  control.finish_invocation(uuid,text,integer,integer),control.sweep_invocation_tokens() TO bp_server;
