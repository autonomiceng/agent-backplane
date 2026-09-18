-- The migration runner supplies the transaction. Run bootstrap holds the Workspace cursor before insertion.
CREATE TABLE control.runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  harness text,
  model text,
  label text,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES control.principals (workspace_id, id)
);
CREATE INDEX events_workspace_run_position ON audit.events (workspace_id, run_id, position);
REVOKE ALL ON control.runs FROM PUBLIC, bp_executor;
GRANT SELECT, INSERT ON control.runs TO bp_server;
GRANT UPDATE (last_seen_at) ON control.runs TO bp_server;
GRANT SELECT (id, workspace_id, principal_id) ON control.runs TO bp_audit;

CREATE FUNCTION audit.lock_workspace(workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
BEGIN
  INSERT INTO audit.cursor (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM audit.cursor c WHERE c.workspace_id = $1 FOR UPDATE;
END
$$;
ALTER FUNCTION audit.lock_workspace(uuid) OWNER TO bp_audit;
REVOKE ALL ON FUNCTION audit.lock_workspace(uuid) FROM PUBLIC, bp_executor;
GRANT EXECUTE ON FUNCTION audit.lock_workspace(uuid) TO bp_server;

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
  -- A bind waiting behind revocation must read its committed Principal status after acquiring the cursor.
  IF principal_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM control.principals p
    WHERE p.workspace_id = bind_context.workspace_id AND p.id = bind_context.principal_id AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'principal_revoked';
  END IF;
  IF principal_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM control.runs r
    WHERE r.id = bind_context.run_id AND r.workspace_id = bind_context.workspace_id
      AND r.principal_id = bind_context.principal_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'run_forbidden';
  END IF;
END
$$;
ALTER FUNCTION audit.bind_context(uuid, uuid, uuid, text, text) OWNER TO bp_audit;

