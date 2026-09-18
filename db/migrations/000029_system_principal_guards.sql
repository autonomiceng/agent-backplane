-- Workers retain bp_server privileges; ordinary mutation guards must reject system Principals.
GRANT SELECT (workspace_id,id,system) ON control.principals TO bp_schema_admin;

CREATE OR REPLACE FUNCTION queue.context(w uuid)
RETURNS audit.bound_context LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id()
      AND workspace_id=w;
  IF c.principal_id IS NULL OR c.run_id IS NULL OR EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL) THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION control.prepare_sql_roles()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET createrole_self_grant = ''
AS $$
DECLARE r record; g text;
BEGIN
  SELECT p.role_name, c.workspace_id INTO r
  FROM audit.bound_context c JOIN control.principals p
    ON (p.workspace_id,p.id)=(c.workspace_id,c.principal_id)
  WHERE c.backend_pid=pg_backend_pid() AND c.xid=pg_current_xact_id()
    AND c.run_id IS NOT NULL AND p.status='active' AND p.system IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='context_missing';
  END IF;
  g := 'bp_ws_' || replace(r.workspace_id::text, '-', '');
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=g) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS', g);
  END IF;
  EXECUTE format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT TRUE, SET FALSE',
    g, r.role_name);
  EXECUTE format('GRANT %I TO bp_server
    WITH ADMIN FALSE, INHERIT FALSE, SET TRUE', r.role_name);
  RETURN r.role_name;
END $$;

CREATE OR REPLACE FUNCTION control.prepare_workspace_schema()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE w uuid; n text;
BEGIN
  SELECT c.workspace_id INTO w FROM audit.bound_context c
    WHERE backend_pid = pg_backend_pid()
      AND xid = pg_current_xact_id()
      AND principal_id IS NOT NULL AND run_id IS NOT NULL
      AND NOT EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'context_missing'; END IF;
  n := 'ws_' || replace(w::text, '-', '');
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = n) THEN
    IF NOT EXISTS (
      SELECT FROM pg_namespace
      WHERE nspname = n AND nspowner = 'bp_executor'::regrole
    ) THEN
      RAISE EXCEPTION 'workspace_contract_invalid';
    END IF;
  ELSE
    EXECUTE format('CREATE SCHEMA %I AUTHORIZATION bp_executor', n);
  END IF;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION audit.stamp_workspace_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE c audit.bound_context%ROWTYPE;
BEGIN
  SELECT * INTO c FROM audit.bound_context
  WHERE backend_pid = pg_backend_pid()
    AND xid = pg_current_xact_id();
  IF NOT FOUND OR c.principal_id IS NULL OR c.run_id IS NULL
     OR EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL)
     OR TG_TABLE_SCHEMA <> 'ws_' || replace(c.workspace_id::text, '-', '')
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='context_missing';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.principal_id := c.principal_id;
  NEW.run_id := c.run_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION control.check_transaction_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.xid = pg_current_xact_id()
      AND NOT EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL)
      AND c.workspace_id = NEW.workspace_id
      AND c.principal_id = NEW.principal_id
      AND c.run_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION control.check_approval_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.xid = pg_current_xact_id()
      AND NOT EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL)
      AND c.workspace_id = coalesce(NEW.workspace_id, OLD.workspace_id)
      AND (TG_TABLE_NAME = 'approvals' OR c.user_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION control.check_quota_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.xid = pg_current_xact_id()
      AND NOT EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL)
      AND c.workspace_id = NEW.workspace_id
      AND CASE WHEN TG_TABLE_NAME = 'workspace_quotas'
        THEN c.user_id IS NOT NULL
        ELSE c.principal_id =
          (to_jsonb(NEW)->>'principal_id')::uuid
          AND c.run_id IS NOT NULL
      END
  ) THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION control.guard_function_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid()
      AND xid=pg_current_xact_id()
      AND workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_missing'; END IF;
  IF EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL) THEN RAISE EXCEPTION 'function_forbidden'; END IF;
  IF TG_OP='INSERT' THEN
    IF TG_TABLE_NAME='deployments' THEN
      IF NEW.status IS DISTINCT FROM 'registered' THEN RAISE EXCEPTION 'deployment_immutable'; END IF;
    END IF;
    IF c.principal_id IS NULL OR c.run_id IS NULL THEN
      RAISE EXCEPTION 'run_required';
    END IF;
    NEW.principal_id:=c.principal_id;
    NEW.run_id:=c.run_id;
    NEW.created_at:=clock_timestamp();
  ELSE
    IF c.user_id IS NULL
      AND c.principal_id IS DISTINCT FROM OLD.principal_id THEN
      RAISE EXCEPTION 'function_forbidden';
    END IF;
    -- Generated values are unavailable before the row update; bundle remains immutable.
    IF (to_jsonb(NEW)-ARRAY['status','bundle_hash','size'])
      <>(to_jsonb(OLD)-ARRAY['status','bundle_hash','size'])
      OR NOT ((OLD.status,NEW.status) IN
        (('registered','active'),('active','retired'))) THEN
      RAISE EXCEPTION 'deployment_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

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
    IF c.principal_id IS NULL OR c.run_id IS NULL OR EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL) THEN
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
    IF (c.principal_id IS DISTINCT FROM OLD.principal_id OR EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL)) AND NOT (OLD.expires_at<=clock_timestamp() AND EXISTS (SELECT FROM control.principals WHERE workspace_id=w AND id=c.principal_id AND system='retention')) THEN
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

CREATE OR REPLACE FUNCTION queue.reconciliation_actor(target_workspace_id uuid)
RETURNS audit.bound_context LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context;
BEGIN
  SELECT * INTO context FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id() AND workspace_id=target_workspace_id;
  IF context.user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM control.member m JOIN control.workspaces w ON w.organization_id=m."organizationId"
      WHERE w.id=target_workspace_id AND m."userId"=context.user_id) THEN
      RAISE EXCEPTION 'workspace_forbidden';
    END IF;
  ELSIF context.principal_id IS NOT NULL THEN
    IF EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=context.workspace_id AND p.id=context.principal_id AND p.system IS NOT NULL) OR NOT EXISTS (SELECT FROM control.reconciliation_delegations d
      JOIN control.workspaces w ON w.id=d.workspace_id
      JOIN control.member m ON m.id=d.member_id AND m."userId"=d.granted_by AND m."organizationId"=w.organization_id
      WHERE d.workspace_id=target_workspace_id AND d.principal_id=context.principal_id) THEN
      RAISE EXCEPTION 'reconciliation_forbidden';
    END IF;
  ELSE RAISE EXCEPTION 'context_missing'; END IF;
  RETURN context;
END $$;

CREATE OR REPLACE FUNCTION queue.redispatch(target_workspace_id uuid,target_delivery_id uuid,expected_state text,event_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; n queue.deliveries;
  physical text; payload jsonb; mid bigint; result jsonb;
BEGIN
  IF event_kind='queue.release' THEN
    IF NOT EXISTS (
      SELECT FROM audit.bound_context c
      WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id()
        AND workspace_id=target_workspace_id AND NOT EXISTS (SELECT FROM control.principals p WHERE p.workspace_id=c.workspace_id AND p.id=c.principal_id AND p.system IS NOT NULL)
    ) THEN RAISE EXCEPTION 'context_missing'; END IF;
    SELECT * INTO d FROM queue.deliveries
      WHERE workspace_id=target_workspace_id AND id=target_delivery_id
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
    IF NOT d.current THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
  ELSE
    d:=queue.locked_delivery(target_workspace_id,target_delivery_id,true);
  END IF;
  IF d.state<>expected_state OR d.effect_started_at IS NOT NULL
    OR EXISTS (SELECT FROM queue.effects e WHERE e.message_id=d.message_id AND NOT e.reset) THEN
    RAISE EXCEPTION 'delivery_conflict';
  END IF;
  payload:=queue.payload(target_workspace_id,d.queue,d.message_id);
  IF payload IS NULL THEN RAISE EXCEPTION 'payload_expired'; END IF;
  SELECT pgmq_queue INTO STRICT physical FROM queue.queues
    WHERE workspace_id=target_workspace_id AND name=d.queue;
  SELECT x INTO STRICT mid FROM pgmq.send(physical,payload) x;
  UPDATE queue.deliveries SET current=false WHERE id=target_delivery_id;
  INSERT INTO queue.deliveries
    (workspace_id,queue,message_id,pgmq_msg_id,parent_id,attempt,max_attempts)
  VALUES(target_workspace_id,d.queue,d.message_id,mid,target_delivery_id,1,5) RETURNING * INTO n;
  result:=queue.result(n,event_kind);
  IF event_kind='queue.replay' THEN
    result:=jsonb_set(result,'{events,0,metadata,parentDeliveryId}',to_jsonb(target_delivery_id));
  END IF;
  RETURN result;
END $$;
