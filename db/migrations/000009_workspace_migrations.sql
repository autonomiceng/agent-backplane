-- The migration runner supplies the transaction. Workspace SQL belongs in this ledger, never audit metadata.
CREATE TABLE control.workspace_migrations (
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  revision int NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  sql text NOT NULL,
  sql_hash bytea NOT NULL CHECK (octet_length(sql_hash) = 32),
  statements int NOT NULL CHECK (statements BETWEEN 1 AND 100),
  destructive bool NOT NULL,
  applied_by uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES control.runs(id),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, revision),
  FOREIGN KEY (workspace_id, applied_by)
    REFERENCES control.principals(workspace_id, id)
);
REVOKE ALL ON control.workspace_migrations FROM PUBLIC, bp_executor;
GRANT SELECT, INSERT ON control.workspace_migrations TO bp_server;

GRANT bp_executor TO bp_server
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'bp_schema_admin'
  ) THEN
    CREATE ROLE bp_schema_admin NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT CREATE ON DATABASE %I TO bp_schema_admin',
    current_database());
END $$;

GRANT bp_executor TO bp_schema_admin
  WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA control, audit TO bp_schema_admin;
GRANT SELECT (workspace_id, principal_id, run_id, backend_pid, xid)
  ON audit.bound_context TO bp_schema_admin;

CREATE FUNCTION control.prepare_workspace_schema()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE w uuid; n text;
BEGIN
  SELECT workspace_id INTO STRICT w FROM audit.bound_context
    WHERE backend_pid = pg_backend_pid()
      AND xid = pg_current_xact_id()
      AND principal_id IS NOT NULL AND run_id IS NOT NULL;
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

ALTER FUNCTION control.prepare_workspace_schema()
  OWNER TO bp_schema_admin;
REVOKE ALL ON FUNCTION control.prepare_workspace_schema()
  FROM PUBLIC, bp_executor;
GRANT EXECUTE ON FUNCTION control.prepare_workspace_schema()
  TO bp_server;
