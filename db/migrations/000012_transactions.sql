CREATE TABLE control.transaction_receipts (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  request_hash bytea NOT NULL
    CHECK (octet_length(request_hash) = 32),
  response jsonb NOT NULL
    CHECK (jsonb_typeof(response) = 'object'
      AND octet_length(response::text) <= 16384),
  position bigint NOT NULL CHECK (position > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, principal_id, idempotency_key),
  FOREIGN KEY (workspace_id, principal_id)
    REFERENCES control.principals(workspace_id, id)
);
REVOKE ALL ON control.transaction_receipts
  FROM PUBLIC, bp_executor, bp_server;
GRANT SELECT, INSERT ON control.transaction_receipts TO bp_server;

CREATE FUNCTION control.check_transaction_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.xid = pg_current_xact_id()
      AND c.workspace_id = NEW.workspace_id
      AND c.principal_id = NEW.principal_id
      AND c.run_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION control.check_transaction_context() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION control.check_transaction_context()
  FROM PUBLIC, bp_executor, bp_server;
CREATE TRIGGER transaction_context
BEFORE INSERT ON control.transaction_receipts
FOR EACH ROW EXECUTE FUNCTION control.check_transaction_context();

CREATE FUNCTION queue.lock_transaction_deliveries(w uuid, ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE i uuid;
BEGIN
  PERFORM queue.context(w);
  FOR i IN SELECT DISTINCT x FROM unnest(ids) AS u(x) ORDER BY x LOOP
    PERFORM 1 FROM queue.deliveries d
      WHERE d.workspace_id = w AND d.id = i FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
  END LOOP;
END $$;
ALTER FUNCTION queue.lock_transaction_deliveries(uuid,uuid[])
  OWNER TO bp_queue;
REVOKE ALL ON FUNCTION queue.lock_transaction_deliveries(uuid,uuid[])
  FROM PUBLIC, bp_executor, bp_server;
GRANT EXECUTE ON FUNCTION queue.lock_transaction_deliveries(uuid,uuid[])
  TO bp_server;
