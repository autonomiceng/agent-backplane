-- The migration runner supplies the transaction. Only bp_audit can write the provenance registry and ledger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bp_audit') THEN
    CREATE ROLE bp_audit NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bp_server') THEN
    CREATE ROLE bp_server NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bp_executor') THEN
    CREATE ROLE bp_executor NOLOGIN;
  END IF;
END
$$;

ALTER SCHEMA audit OWNER TO bp_audit;
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
-- EXECUTE's PUBLIC default is global, so a schema-scoped revoke cannot remove it.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE bp_audit REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS audit.events (
  workspace_id uuid NOT NULL,
  position bigint NOT NULL,
  principal_id uuid,
  run_id uuid,
  user_id text,
  kind text NOT NULL,
  objects text[] NOT NULL DEFAULT '{}',
  row_count bigint CHECK (row_count >= 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, position),
  CHECK ((principal_id IS NOT NULL AND run_id IS NOT NULL AND user_id IS NULL)
    OR (principal_id IS NULL AND run_id IS NULL AND user_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS audit.cursor (
  workspace_id uuid PRIMARY KEY,
  last_position bigint NOT NULL DEFAULT 0
);
CREATE UNLOGGED TABLE IF NOT EXISTS audit.bound_context (
  backend_pid int NOT NULL,
  xid xid8 NOT NULL,
  token text NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid,
  run_id uuid,
  user_id text,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (backend_pid, xid),
  CHECK ((principal_id IS NOT NULL AND run_id IS NOT NULL AND user_id IS NULL)
    OR (principal_id IS NULL AND run_id IS NULL AND user_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS audit.rejections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid,
  principal_id uuid,
  run_id uuid,
  user_id text,
  kind text NOT NULL,
  objects text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  sqlstate text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE audit.events OWNER TO bp_audit;
ALTER TABLE audit.cursor OWNER TO bp_audit;
ALTER TABLE audit.bound_context OWNER TO bp_audit;
ALTER TABLE audit.rejections OWNER TO bp_audit;
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC, bp_server;

CREATE OR REPLACE FUNCTION audit.bind_context(workspace_id uuid, principal_id uuid, run_id uuid, user_id text, token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
BEGIN
  IF workspace_id IS NULL OR token IS NULL OR token = '' OR NOT (
    (principal_id IS NOT NULL AND run_id IS NOT NULL AND user_id IS NULL)
    OR (principal_id IS NULL AND run_id IS NULL AND user_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'context_invalid';
  END IF;

  -- Keep this transaction's row: removing it would allow a caller to replace the stamp.
  DELETE FROM audit.bound_context
    WHERE backend_pid = pg_backend_pid() AND xid <> pg_current_xact_id();
  BEGIN
    INSERT INTO audit.bound_context (backend_pid, xid, token, workspace_id, principal_id, run_id, user_id)
      VALUES (pg_backend_pid(), pg_current_xact_id(), token, workspace_id, principal_id, run_id, user_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'context_already_bound';
  END;

  INSERT INTO audit.cursor (workspace_id) VALUES (workspace_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM audit.cursor c WHERE c.workspace_id = bind_context.workspace_id FOR UPDATE;
END
$$;
ALTER FUNCTION audit.bind_context(uuid, uuid, uuid, text, text) OWNER TO bp_audit;

-- Metadata is a server-generated shape envelope; callers must never pass parameters or row contents (ADR-0013).
CREATE OR REPLACE FUNCTION audit.emit(token text, kind text, objects text[], row_count bigint, metadata jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
DECLARE
  context audit.bound_context%ROWTYPE;
  next_position bigint;
BEGIN
  SELECT * INTO context FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid() AND c.xid = pg_current_xact_id() AND c.token = emit.token;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'context_missing';
  END IF;
  UPDATE audit.cursor SET last_position = last_position + 1
    WHERE workspace_id = context.workspace_id RETURNING last_position INTO next_position;
  INSERT INTO audit.events (workspace_id, position, principal_id, run_id, user_id, kind, objects, row_count, metadata)
    VALUES (context.workspace_id, next_position, context.principal_id, context.run_id, context.user_id,
      kind, objects, row_count, metadata);
  RETURN next_position;
END
$$;
ALTER FUNCTION audit.emit(text, text, text[], bigint, jsonb) OWNER TO bp_audit;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA audit FROM PUBLIC;
GRANT USAGE ON SCHEMA control, audit TO bp_server;
GRANT SELECT ON control.schema_version, audit.events, audit.rejections TO bp_server;
GRANT INSERT ON audit.rejections TO bp_server;
GRANT EXECUTE ON FUNCTION audit.bind_context(uuid, uuid, uuid, text, text), audit.emit(text, text, text[], bigint, jsonb) TO bp_server;

-- Empty-database migration checks do not install PGMQ. Readiness still requires its installation.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'pgmq') THEN
    GRANT USAGE ON SCHEMA pgmq TO bp_server;
    IF to_regclass('pgmq.backplane_install') IS NOT NULL THEN
      GRANT SELECT ON pgmq.backplane_install TO bp_server;
    END IF;
  END IF;
END
$$;
