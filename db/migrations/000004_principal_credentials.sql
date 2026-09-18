-- The migration runner supplies the transaction. Credentials belong to one Principal in one Workspace.
CREATE TABLE control.principal_keys (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{24}$'),
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, principal_id),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES control.principals (workspace_id, id)
);
REVOKE ALL ON control.principal_keys FROM PUBLIC, bp_executor;
GRANT SELECT, INSERT, UPDATE ON control.principal_keys TO bp_server;
GRANT UPDATE (status) ON control.principals TO bp_server;
GRANT USAGE ON SCHEMA control TO bp_audit;
GRANT SELECT (id, workspace_id, status) ON control.principals TO bp_audit;

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
END
$$;
ALTER FUNCTION audit.bind_context(uuid, uuid, uuid, text, text) OWNER TO bp_audit;

