CREATE TABLE control.workspace_quotas (
  workspace_id uuid PRIMARY KEY REFERENCES control.workspaces(id),
  sql_statement_bytes integer NOT NULL DEFAULT 1048576
    CHECK (sql_statement_bytes BETWEEN 0 AND 1073741824),
  sql_rows integer NOT NULL DEFAULT 10000
    CHECK (sql_rows BETWEEN 0 AND 1000000000),
  transaction_operations integer NOT NULL DEFAULT 600
    CHECK (transaction_operations BETWEEN 0 AND 1000000000),
  queue_sends integer NOT NULL DEFAULT 600
    CHECK (queue_sends BETWEEN 0 AND 1000000000),
  open_sse_streams integer NOT NULL DEFAULT 16
    CHECK (open_sse_streams BETWEEN 0 AND 16)
);

CREATE TABLE control.quota_usage (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  resource text NOT NULL CHECK (resource IN (
    'sql_statement_bytes', 'sql_rows',
    'transaction_operations', 'queue_sends'
  )),
  window_start timestamptz NOT NULL,
  used bigint NOT NULL CHECK (used >= 0),
  PRIMARY KEY (workspace_id, principal_id, resource),
  FOREIGN KEY (workspace_id, principal_id)
    REFERENCES control.principals(workspace_id, id),
  CHECK (mod(extract(epoch FROM window_start), 60) = 0)
);

CREATE FUNCTION control.check_quota_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.xid = pg_current_xact_id()
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

ALTER FUNCTION control.check_quota_context() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION control.check_quota_context()
  FROM PUBLIC, bp_executor, bp_server;

CREATE TRIGGER quota_context
BEFORE INSERT OR UPDATE ON control.workspace_quotas
FOR EACH ROW EXECUTE FUNCTION control.check_quota_context();

CREATE TRIGGER quota_context
BEFORE INSERT OR UPDATE ON control.quota_usage
FOR EACH ROW EXECUTE FUNCTION control.check_quota_context();

REVOKE ALL ON control.workspace_quotas, control.quota_usage
  FROM PUBLIC, bp_executor, bp_server;
GRANT SELECT, INSERT ON control.workspace_quotas,
  control.quota_usage TO bp_server;
GRANT UPDATE (sql_statement_bytes, sql_rows,
  transaction_operations, queue_sends, open_sse_streams)
  ON control.workspace_quotas TO bp_server;
GRANT UPDATE (window_start, used)
  ON control.quota_usage TO bp_server;
