-- The migration runner supplies the transaction. Workspace rows read their stamp from the protected registry.
CREATE FUNCTION audit.stamp_workspace_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE c audit.bound_context%ROWTYPE;
BEGIN
  SELECT * INTO c FROM audit.bound_context
  WHERE backend_pid = pg_backend_pid()
    AND xid = pg_current_xact_id();
  IF NOT FOUND OR c.principal_id IS NULL OR c.run_id IS NULL
     OR TG_TABLE_SCHEMA <> 'ws_' || replace(c.workspace_id::text, '-', '')
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='context_missing';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.principal_id := c.principal_id;
  NEW.run_id := c.run_id;
  RETURN NEW;
END $$;
ALTER FUNCTION audit.stamp_workspace_row() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION audit.stamp_workspace_row() FROM PUBLIC, bp_server;
GRANT USAGE ON SCHEMA audit TO bp_executor;
GRANT EXECUTE ON FUNCTION audit.stamp_workspace_row() TO bp_executor;
ALTER DEFAULT PRIVILEGES FOR ROLE bp_executor
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT SELECT ON control.principals TO bp_provisioner;
CREATE FUNCTION control.prepare_sql_roles()
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
    AND c.run_id IS NOT NULL AND p.status='active';
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
ALTER FUNCTION control.prepare_sql_roles() OWNER TO bp_provisioner;
REVOKE ALL ON FUNCTION control.prepare_sql_roles() FROM PUBLIC, bp_executor;
GRANT EXECUTE ON FUNCTION control.prepare_sql_roles() TO bp_server;
