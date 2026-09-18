-- The migration runner supplies the transaction; Receipts fence each consumer attempt.
SET LOCAL ROLE bp_queue;

CREATE TABLE queue.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  queue text NOT NULL,
  message_id uuid NOT NULL,
  pgmq_msg_id bigint NOT NULL,
  chain_id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_id uuid,
  attempt int NOT NULL DEFAULT 1,
  max_attempts int NOT NULL DEFAULT 5,
  current boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'ready'
    CHECK (state IN ('scheduled','ready','leased','held','ambiguous',
                     'succeeded','dead-lettered','cancelled')),
  receipt_token_hash bytea
    CHECK (octet_length(receipt_token_hash)=32),
  consumer_principal_id uuid,
  consumer_run_id uuid REFERENCES control.runs(id),
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  next_attempt_at timestamptz,
  held_by uuid,
  held_at timestamptz,
  effect_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (attempt BETWEEN 1 AND max_attempts),
  CHECK ((state='leased')=(receipt_token_hash IS NOT NULL)),
  FOREIGN KEY (workspace_id,queue,message_id)
    REFERENCES queue.messages(workspace_id,queue,id),
  FOREIGN KEY (workspace_id,consumer_principal_id)
    REFERENCES control.principals(workspace_id,id),
  FOREIGN KEY (workspace_id,held_by)
    REFERENCES control.principals(workspace_id,id),
  UNIQUE(workspace_id,queue,message_id,id),
  FOREIGN KEY (workspace_id,queue,message_id,parent_id)
    REFERENCES queue.deliveries(workspace_id,queue,message_id,id),
  UNIQUE(message_id,chain_id,attempt)
);
CREATE UNIQUE INDEX delivery_current
  ON queue.deliveries(message_id) WHERE current;
CREATE UNIQUE INDEX delivery_dispatch
  ON queue.deliveries(workspace_id,queue,pgmq_msg_id) WHERE current;

CREATE FUNCTION queue.result(delivery queue.deliveries,verb text)
RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('data',to_jsonb(delivery),'events',
    jsonb_build_array(jsonb_build_object(
      'kind',verb,'objects',jsonb_build_array(delivery.queue,delivery.message_id,delivery.id),
      'metadata',jsonb_build_object('attempt',delivery.attempt,'state',delivery.state))))
$$;

CREATE FUNCTION queue.settle(delivery queue.deliveries,verb text)
RETURNS queue.deliveries LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE physical_queue text;
BEGIN
  SELECT pgmq_queue INTO STRICT physical_queue FROM queue.queues q
    WHERE q.workspace_id=delivery.workspace_id AND q.name=delivery.queue;
  delivery.state:=CASE
    WHEN verb='ack' THEN 'succeeded'
    WHEN delivery.effect_started_at IS NOT NULL THEN 'ambiguous'
    WHEN delivery.attempt>=delivery.max_attempts THEN 'dead-lettered'
    ELSE 'scheduled' END;
  delivery.next_attempt_at:=CASE WHEN delivery.state='scheduled' THEN
    (CASE WHEN verb='expire' THEN delivery.lease_expires_at
      ELSE clock_timestamp() END)+interval '5 seconds' END;
  IF delivery.state='scheduled' THEN
    PERFORM pgmq.set_vt(physical_queue,delivery.pgmq_msg_id,delivery.next_attempt_at);
    IF NOT FOUND THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
  ELSIF NOT pgmq.archive(physical_queue,delivery.pgmq_msg_id) THEN
    RAISE EXCEPTION 'queue_unavailable';
  END IF;
  UPDATE queue.deliveries SET state=delivery.state,
    next_attempt_at=delivery.next_attempt_at,receipt_token_hash=NULL,
    completed_at=clock_timestamp(),
    failure_code=CASE WHEN verb='ack' THEN NULL ELSE verb END
    WHERE id=delivery.id RETURNING * INTO delivery;
  RETURN delivery;
END $$;

CREATE FUNCTION queue.receipt_verb(workspace_id uuid,delivery_id uuid,receipt_hash bytea,verb text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; delivery queue.deliveries; physical_queue text;
BEGIN
  context:=queue.context(workspace_id);
  SELECT * INTO delivery FROM queue.deliveries d
    WHERE d.workspace_id=receipt_verb.workspace_id AND d.id=delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
  IF NOT delivery.current OR delivery.state<>'leased' THEN
    RAISE EXCEPTION 'receipt_stale';
  END IF;
  IF receipt_hash IS DISTINCT FROM delivery.receipt_token_hash THEN
    RAISE EXCEPTION 'receipt_stale';
  END IF;
  IF delivery.consumer_principal_id IS DISTINCT FROM context.principal_id
     OR delivery.consumer_run_id IS DISTINCT FROM context.run_id THEN
    RAISE EXCEPTION 'receipt_foreign';
  END IF;
  IF delivery.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'receipt_expired';
  END IF;
  IF verb='renew' THEN
    SELECT pgmq_queue INTO STRICT physical_queue FROM queue.queues q
      WHERE q.workspace_id=receipt_verb.workspace_id AND q.name=delivery.queue;
    delivery.lease_expires_at:=clock_timestamp()+interval '30 seconds';
    PERFORM pgmq.set_vt(physical_queue,delivery.pgmq_msg_id,delivery.lease_expires_at);
    IF NOT FOUND THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
    UPDATE queue.deliveries SET lease_expires_at=delivery.lease_expires_at
      WHERE id=delivery_id RETURNING * INTO delivery;
  ELSE
    delivery:=queue.settle(delivery,verb);
  END IF;
  RETURN queue.result(delivery,'queue.'||verb);
END $$;

CREATE FUNCTION queue.renew(workspace_id uuid,delivery_id uuid,receipt_hash bytea)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
  SELECT queue.receipt_verb(workspace_id,delivery_id,receipt_hash,'renew')
$$;
CREATE FUNCTION queue.ack(workspace_id uuid,delivery_id uuid,receipt_hash bytea)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
  SELECT queue.receipt_verb(workspace_id,delivery_id,receipt_hash,'ack')
$$;
CREATE FUNCTION queue.nack(workspace_id uuid,delivery_id uuid,receipt_hash bytea)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
  SELECT queue.receipt_verb(workspace_id,delivery_id,receipt_hash,'nack')
$$;

CREATE FUNCTION queue.claim(workspace_id uuid,queue_name text,receipt_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE
  context audit.bound_context; physical_queue text; message record;
  delivery queue.deliveries; previous_delivery queue.deliveries; claimed_message_id uuid;
  events jsonb:='[]'; result jsonb;
BEGIN
  context:=queue.context(workspace_id);
  IF receipt_hash IS NULL OR octet_length(receipt_hash)<>32 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT pgmq_queue INTO physical_queue FROM queue.queues q
    WHERE q.workspace_id=claim.workspace_id AND q.name=queue_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'queue_not_found'; END IF;
  FOR scan IN 1..32 LOOP
    SELECT * INTO message FROM pgmq.read(physical_queue,30,1);
    EXIT WHEN NOT FOUND;
    SELECT * INTO delivery FROM queue.deliveries d
      WHERE d.workspace_id=claim.workspace_id AND d.queue=queue_name
        AND d.pgmq_msg_id=message.msg_id AND d.current FOR UPDATE;
    IF delivery.id IS NULL THEN
      SELECT m.id INTO claimed_message_id FROM queue.messages m
        WHERE m.workspace_id=claim.workspace_id AND m.queue=queue_name
          AND m.pgmq_msg_id=message.msg_id
          AND NOT EXISTS (
            SELECT FROM queue.deliveries x WHERE x.message_id=m.id);
      IF claimed_message_id IS NULL THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
      INSERT INTO queue.deliveries(workspace_id,queue,message_id,pgmq_msg_id)
        VALUES(workspace_id,queue_name,claimed_message_id,message.msg_id) RETURNING * INTO delivery;
    END IF;
    IF delivery.state='leased' THEN
      IF delivery.lease_expires_at>clock_timestamp() THEN
        RAISE EXCEPTION 'queue_unavailable';
      END IF;
      delivery:=queue.settle(delivery,'expire');
      events:=events||(queue.result(delivery,'queue.expire')->'events');
      IF delivery.state<>'scheduled' THEN CONTINUE; END IF;
    END IF;
    IF delivery.state NOT IN ('ready','scheduled') THEN
      RAISE EXCEPTION 'queue_unavailable';
    END IF;
    IF delivery.next_attempt_at>clock_timestamp() THEN
      PERFORM pgmq.set_vt(physical_queue,message.msg_id,delivery.next_attempt_at);
      CONTINUE;
    END IF;
    IF delivery.completed_at IS NOT NULL THEN
      previous_delivery:=delivery;
      UPDATE queue.deliveries SET current=false WHERE id=previous_delivery.id;
      INSERT INTO queue.deliveries(
        workspace_id,queue,message_id,pgmq_msg_id,chain_id,
        parent_id,attempt,max_attempts)
      VALUES(workspace_id,queue_name,previous_delivery.message_id,message.msg_id,previous_delivery.chain_id,
             previous_delivery.id,previous_delivery.attempt+1,previous_delivery.max_attempts) RETURNING * INTO delivery;
    END IF;
    delivery.lease_expires_at:=clock_timestamp()+interval '30 seconds';
    PERFORM pgmq.set_vt(physical_queue,message.msg_id,delivery.lease_expires_at);
    IF NOT FOUND THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
    UPDATE queue.deliveries SET state='leased',receipt_token_hash=receipt_hash,
      consumer_principal_id=context.principal_id,consumer_run_id=context.run_id,
      claimed_at=clock_timestamp(),lease_expires_at=delivery.lease_expires_at,
      next_attempt_at=NULL WHERE id=delivery.id RETURNING * INTO delivery;
    result:=queue.result(delivery,'queue.claim');
    RETURN result||jsonb_build_object(
      'events',events||(result->'events'),'payload',message.message);
  END LOOP;
  RETURN jsonb_build_object('data',NULL,'events',events);
END $$;

REVOKE ALL ON queue.deliveries FROM PUBLIC,bp_server,bp_executor;
GRANT EXECUTE ON FUNCTION queue.claim(uuid,text,bytea),
  queue.renew(uuid,uuid,bytea),queue.ack(uuid,uuid,bytea),
  queue.nack(uuid,uuid,bytea) TO bp_server;
RESET ROLE;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname='pgmq') THEN
    GRANT EXECUTE ON FUNCTION pgmq.read(text,integer,integer,jsonb),
      pgmq.set_vt(text,bigint,timestamptz),
      pgmq.archive(text,bigint) TO bp_queue;
  END IF;
END $$;
