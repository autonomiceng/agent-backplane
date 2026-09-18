-- The migration runner supplies the transaction; bp_queue owns ledger and dispatch storage.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bp_queue') THEN
    CREATE ROLE bp_queue NOLOGIN NOSUPERUSER NOCREATEROLE
      NOCREATEDB NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

ALTER SCHEMA queue OWNER TO bp_queue;
REVOKE ALL ON SCHEMA queue FROM PUBLIC, bp_executor;

GRANT USAGE ON SCHEMA control, audit TO bp_queue;
GRANT SELECT ON audit.bound_context TO bp_queue;
GRANT REFERENCES ON control.workspaces, control.principals,
  control.runs TO bp_queue;
-- Empty-database migration checks omit PGMQ; readiness still requires it.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'pgmq') THEN
    REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, bp_executor;
    REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC, bp_executor;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgmq FROM PUBLIC, bp_executor;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq
      FROM PUBLIC, bp_executor, bp_server;
    GRANT USAGE, CREATE ON SCHEMA pgmq TO bp_queue;
    GRANT SELECT, INSERT ON pgmq.meta TO bp_queue;
    GRANT EXECUTE ON FUNCTION
      pgmq.create(text), pgmq.create_non_partitioned(text),
      pgmq.validate_queue_name(text), pgmq.acquire_queue_lock(text),
      pgmq.format_table_name(text,text), pgmq.send(text,jsonb),
      pgmq.send(text,jsonb,jsonb,timestamptz) TO bp_queue;
  END IF;
END $$;
-- Deny by default for every function bp_queue creates, with or without PGMQ present.
ALTER DEFAULT PRIVILEGES FOR ROLE bp_queue REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SET LOCAL ROLE bp_queue;

CREATE TABLE queue.queues (
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,62}$'),
  pgmq_queue text NOT NULL UNIQUE
    CHECK (pgmq_queue ~ '^bp_[0-9a-f]{44}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,name)
);

CREATE TABLE queue.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  queue text NOT NULL,
  pgmq_msg_id bigint NOT NULL,
  idempotency_key text NOT NULL
    CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash)=32),
  producer_principal_id uuid NOT NULL,
  producer_run_id uuid NOT NULL REFERENCES control.runs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id,queue)
    REFERENCES queue.queues(workspace_id,name),
  FOREIGN KEY (workspace_id,producer_principal_id)
    REFERENCES control.principals(workspace_id,id),
  UNIQUE (workspace_id,queue,idempotency_key),
  UNIQUE (workspace_id,queue,pgmq_msg_id),
  UNIQUE (workspace_id,queue,id)
);

CREATE FUNCTION queue.context(w uuid)
RETURNS audit.bound_context LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id()
      AND workspace_id=w;
  IF c.principal_id IS NULL OR c.run_id IS NULL THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  RETURN c;
END $$;

CREATE FUNCTION queue.create_queue(w uuid,n text)
RETURNS queue.queues LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE q queue.queues;
BEGIN
  PERFORM queue.context(w);
  IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'pgmq') THEN
    RAISE EXCEPTION 'pgmq_missing';
  END IF;
  INSERT INTO queue.queues(workspace_id,name,pgmq_queue)
    VALUES(w,n,'bp_' || substr(encode(
      sha256(convert_to(w::text || ':' || n,'UTF8')),'hex'),1,44))
    RETURNING * INTO q;
  PERFORM pgmq.create(q.pgmq_queue);
  RETURN q;
END $$;

CREATE FUNCTION queue.send_message(w uuid,n text,k text,p jsonb)
RETURNS TABLE(message queue.messages,inserted boolean,bytes integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c audit.bound_context;
  q queue.queues;
  m queue.messages;
  h bytea;
  b integer;
  mid bigint;
BEGIN
  c := queue.context(w);
  b := octet_length(convert_to(p::text,'UTF8'));
  IF p IS NULL OR k IS NULL OR octet_length(k) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF b > 262144 THEN RAISE EXCEPTION 'payload_too_large'; END IF;
  h := sha256(convert_to(p::text,'UTF8'));
  SELECT * INTO q FROM queue.queues WHERE workspace_id=w AND name=n;
  IF NOT FOUND THEN RAISE EXCEPTION 'queue_not_found'; END IF;
  SELECT * INTO m FROM queue.messages
    WHERE workspace_id=w AND queue=n AND idempotency_key=k;
  IF FOUND THEN
    IF m.payload_hash <> h THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN QUERY SELECT m,false,b;
    RETURN;
  END IF;
  SELECT s INTO STRICT mid FROM pgmq.send(q.pgmq_queue,p) s;
  INSERT INTO queue.messages(workspace_id,queue,pgmq_msg_id,
    idempotency_key,payload_hash,producer_principal_id,producer_run_id)
    VALUES(w,n,mid,k,h,c.principal_id,c.run_id) RETURNING * INTO m;
  RETURN QUERY SELECT m,true,b;
END $$;

CREATE FUNCTION queue.payload(w uuid,n text,i uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE physical text; mid bigint; p jsonb;
BEGIN
  SELECT q.pgmq_queue,m.pgmq_msg_id INTO physical,mid
    FROM queue.messages m JOIN queue.queues q
      ON (q.workspace_id,q.name)=(m.workspace_id,m.queue)
    WHERE m.workspace_id=w AND m.queue=n AND m.id=i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  EXECUTE format(
    'SELECT message FROM pgmq.%I WHERE msg_id=$1
     UNION ALL SELECT message FROM pgmq.%I WHERE msg_id=$1',
    'q_' || physical,'a_' || physical)
    INTO p USING mid;
  RETURN p;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA queue FROM PUBLIC, bp_executor, bp_server;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA queue FROM PUBLIC, bp_executor, bp_server;
GRANT USAGE ON SCHEMA queue TO bp_server;
GRANT SELECT ON queue.queues, queue.messages TO bp_server;
GRANT EXECUTE ON FUNCTION queue.create_queue(uuid,text),
  queue.send_message(uuid,text,text,jsonb),
  queue.payload(uuid,text,uuid) TO bp_server;
RESET ROLE;
