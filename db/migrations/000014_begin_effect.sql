-- The runner supplies the transaction. Effect identity permanently fences automatic redispatch.
GRANT SELECT (id,workspace_id,status) ON control.principals TO bp_queue;
SET LOCAL ROLE bp_queue;

CREATE TABLE queue.effects (
  workspace_id uuid NOT NULL,
  queue text NOT NULL,
  message_id uuid PRIMARY KEY,
  origin_delivery_id uuid NOT NULL,
  effect_key text NOT NULL CHECK (effect_key ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (workspace_id,queue,message_id,origin_delivery_id)
    REFERENCES queue.deliveries(workspace_id,queue,message_id,id)
);

-- 000008 left the Receipt constraint unnamed; resolve its actual name from its columns.
DO $$
DECLARE receipt_constraint name;
BEGIN
  SELECT c.conname INTO STRICT receipt_constraint FROM pg_constraint c
  WHERE c.conrelid='queue.deliveries'::regclass AND c.contype='c'
    AND cardinality(c.conkey)=2
    AND c.conkey @> ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='state'),
      (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='receipt_token_hash')];
  EXECUTE format('ALTER TABLE queue.deliveries DROP CONSTRAINT %I',receipt_constraint);
END $$;

ALTER TABLE queue.deliveries
  DROP CONSTRAINT deliveries_state_check,
  ADD CONSTRAINT deliveries_state_check CHECK (
    state IN ('scheduled','ready','leased','begun','held','ambiguous','effect-paused',
              'succeeded','dead-lettered','cancelled')),
  ADD CONSTRAINT deliveries_receipt_check CHECK (
    (state IN ('leased','begun'))=(receipt_token_hash IS NOT NULL)),
  ADD CONSTRAINT deliveries_begun_check CHECK (
    state NOT IN ('begun','effect-paused','ambiguous') OR effect_started_at IS NOT NULL);
CREATE INDEX delivery_begun_expiry
  ON queue.deliveries(workspace_id,queue,lease_expires_at,id) WHERE current AND state='begun';
CREATE INDEX delivery_begun_principal
  ON queue.deliveries(workspace_id,consumer_principal_id,id) WHERE current AND state='begun';

CREATE FUNCTION queue.effect_key(workspace_id uuid,action text,destination text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog AS $$
  SELECT encode(sha256(
    uuid_send(workspace_id) ||
    int4send(octet_length(convert_to(action,'UTF8'))) ||
    convert_to(action,'UTF8') ||
    int4send(octet_length(convert_to(destination,'UTF8'))) ||
    convert_to(destination,'UTF8')
  ),'hex')
$$;

CREATE FUNCTION queue.fenced_delivery(workspace_id uuid,delivery_id uuid,receipt_hash bytea)
RETURNS queue.deliveries LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; delivery queue.deliveries;
BEGIN
  context:=queue.context(workspace_id);
  SELECT * INTO delivery FROM queue.deliveries d
    WHERE d.workspace_id=fenced_delivery.workspace_id AND d.id=delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
  IF NOT delivery.current OR delivery.state NOT IN ('leased','begun') THEN
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
  RETURN delivery;
END $$;

CREATE FUNCTION queue.begin_effect(workspace_id uuid,delivery_id uuid,receipt_hash bytea,action text,destination text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE delivery queue.deliveries; derived_key text; stored_key text; events jsonb:='[]';
BEGIN
  delivery:=queue.fenced_delivery(workspace_id,delivery_id,receipt_hash);
  IF action IS NULL OR destination IS NULL
    OR octet_length(convert_to(action,'UTF8')) NOT BETWEEN 1 AND 1024
    OR octet_length(convert_to(destination,'UTF8')) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  derived_key:=queue.effect_key(workspace_id,action,destination);
  SELECT e.effect_key INTO stored_key FROM queue.effects e WHERE e.message_id=delivery.message_id;
  IF FOUND THEN
    IF stored_key<>derived_key THEN RAISE EXCEPTION 'effect_key_conflict'; END IF;
    IF delivery.state<>'begun' THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
  ELSE
    INSERT INTO queue.effects(workspace_id,queue,message_id,origin_delivery_id,effect_key)
      VALUES(workspace_id,delivery.queue,delivery.message_id,delivery.id,derived_key);
    UPDATE queue.deliveries SET state='begun',effect_started_at=clock_timestamp()
      WHERE id=delivery_id RETURNING * INTO delivery;
    events:=queue.result(delivery,'effect.begin')->'events';
  END IF;
  RETURN jsonb_build_object('data',jsonb_build_object(
    'deliveryId',delivery.id,'messageId',delivery.message_id,'effectKey',derived_key,
    'state','begun','begunAt',delivery.effect_started_at),'events',events);
END $$;

CREATE FUNCTION queue.pause_effects(target_workspace_id uuid,target_principal_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; delivery queue.deliveries; physical_queue text;
  events jsonb:='[]'; result jsonb;
BEGIN
  SELECT * INTO context FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id()
      AND workspace_id=target_workspace_id;
  IF context.user_id IS NULL THEN RAISE EXCEPTION 'recovery_forbidden'; END IF;
  IF NOT EXISTS (SELECT FROM control.principals
    WHERE workspace_id=target_workspace_id AND id=target_principal_id AND status='revoked') THEN
    RAISE EXCEPTION 'delivery_conflict';
  END IF;
  FOR delivery IN SELECT d.* FROM queue.deliveries d
    WHERE d.workspace_id=target_workspace_id AND d.consumer_principal_id=target_principal_id
      AND d.current AND d.state='begun' ORDER BY d.id FOR UPDATE
  LOOP
    SELECT pgmq_queue INTO STRICT physical_queue FROM queue.queues
      WHERE workspace_id=target_workspace_id AND name=delivery.queue;
    IF NOT pgmq.archive(physical_queue,delivery.pgmq_msg_id) THEN
      RAISE EXCEPTION 'queue_unavailable';
    END IF;
    UPDATE queue.deliveries SET state='effect-paused',receipt_token_hash=NULL,
      next_attempt_at=NULL,completed_at=clock_timestamp(),failure_code='principal_revoked'
      WHERE id=delivery.id RETURNING * INTO delivery;
    result:=jsonb_set(queue.result(delivery,'effect.paused'),'{events,0,metadata,reason}',
      '"principal_revoked"'::jsonb);
    events:=events||(result->'events');
  END LOOP;
  RETURN jsonb_build_object('events',events);
END $$;

CREATE OR REPLACE FUNCTION queue.receipt_verb(workspace_id uuid,delivery_id uuid,receipt_hash bytea,verb text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE delivery queue.deliveries; physical_queue text; result jsonb;
BEGIN
  delivery:=queue.fenced_delivery(workspace_id,delivery_id,receipt_hash);
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
  result:=queue.result(delivery,'queue.'||verb);
  IF verb='ack' AND delivery.effect_started_at IS NOT NULL THEN
    result:=jsonb_set(result,'{events,0,metadata,effectOutcome}','"applied"'::jsonb);
  ELSIF verb='nack' AND delivery.state='ambiguous' THEN
    result:=jsonb_set(result,'{events}',(result->'events')||
      (jsonb_set(queue.result(delivery,'effect.ambiguous'),'{events,0,metadata,reason}',
        '"nack"'::jsonb)->'events'));
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION queue.hold(target_workspace_id uuid,target_delivery_id uuid,receipt_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; delivery queue.deliveries; physical_queue text;
BEGIN
  context:=queue.context(target_workspace_id);
  delivery:=queue.fenced_delivery(target_workspace_id,target_delivery_id,receipt_hash);
  IF delivery.effect_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'delivery_conflict';
  END IF;
  SELECT pgmq_queue INTO STRICT physical_queue FROM queue.queues
    WHERE workspace_id=target_workspace_id AND name=delivery.queue;
  IF NOT pgmq.archive(physical_queue,delivery.pgmq_msg_id) THEN
    RAISE EXCEPTION 'queue_unavailable';
  END IF;
  UPDATE queue.deliveries SET state='held',receipt_token_hash=NULL,
    held_by=context.principal_id,held_at=clock_timestamp(),
    completed_at=clock_timestamp(),next_attempt_at=NULL
    WHERE id=target_delivery_id RETURNING * INTO delivery;
  RETURN queue.result(delivery,'queue.hold');
END $$;

CREATE OR REPLACE FUNCTION queue.claim(workspace_id uuid,queue_name text,receipt_hash bytea)
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
  FOR delivery IN SELECT d.* FROM queue.deliveries d
    WHERE d.workspace_id=claim.workspace_id AND d.queue=queue_name AND d.current
      AND d.state='begun' AND d.lease_expires_at<=clock_timestamp()
    ORDER BY d.lease_expires_at,d.id LIMIT 32 FOR UPDATE
  LOOP
    delivery:=queue.settle(delivery,'expire');
    events:=events||(jsonb_set(queue.result(delivery,'effect.ambiguous'),
      '{events,0,metadata,reason}','"lease_expired"'::jsonb)->'events');
  END LOOP;
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
    IF delivery.state IN ('leased','begun') THEN
      IF delivery.lease_expires_at>clock_timestamp() THEN
        RAISE EXCEPTION 'queue_unavailable';
      END IF;
      delivery:=queue.settle(delivery,'expire');
      IF delivery.state='ambiguous' THEN
        events:=events||(jsonb_set(queue.result(delivery,'effect.ambiguous'),
          '{events,0,metadata,reason}','"lease_expired"'::jsonb)->'events');
      ELSE
        events:=events||(queue.result(delivery,'queue.expire')->'events');
      END IF;
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

CREATE OR REPLACE FUNCTION queue.redispatch(target_workspace_id uuid,target_delivery_id uuid,expected_state text,event_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; n queue.deliveries;
  physical text; payload jsonb; mid bigint; result jsonb;
BEGIN
  d:=queue.locked_delivery(target_workspace_id,target_delivery_id,true);
  IF d.state<>expected_state OR d.effect_started_at IS NOT NULL
    OR EXISTS (SELECT FROM queue.effects e WHERE e.message_id=d.message_id) THEN
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

CREATE OR REPLACE FUNCTION queue.cancel(target_workspace_id uuid,target_delivery_id uuid,force_cancel boolean,cancellation_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; physical text; result jsonb;
BEGIN
  d:=queue.locked_delivery(target_workspace_id,target_delivery_id,true);
  IF cancellation_reason IS NULL OR cancellation_reason!~'^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF EXISTS (SELECT FROM queue.effects e WHERE e.message_id=d.message_id)
    OR d.state NOT IN ('ready','scheduled','leased')
    OR (d.state='leased' AND force_cancel IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'delivery_conflict';
  END IF;
  SELECT pgmq_queue INTO STRICT physical FROM queue.queues
    WHERE workspace_id=target_workspace_id AND name=d.queue;
  IF NOT pgmq.archive(physical,d.pgmq_msg_id) THEN
    RAISE EXCEPTION 'queue_unavailable';
  END IF;
  UPDATE queue.deliveries SET state='cancelled',receipt_token_hash=NULL,
    next_attempt_at=NULL,completed_at=clock_timestamp()
    WHERE id=target_delivery_id RETURNING * INTO d;
  result:=queue.result(d,'queue.cancel');
  RETURN jsonb_set(result,'{events,0,metadata,reason}',to_jsonb(cancellation_reason));
END $$;

CREATE OR REPLACE FUNCTION queue.ensure_delivery(target_workspace_id uuid,target_message_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries;
BEGIN
  PERFORM queue.context(target_workspace_id);
  IF EXISTS (SELECT FROM queue.effects e
    WHERE e.workspace_id=target_workspace_id AND e.message_id=target_message_id) THEN
    RAISE EXCEPTION 'delivery_conflict';
  END IF;
  INSERT INTO queue.deliveries(workspace_id,queue,message_id,pgmq_msg_id)
  SELECT target_workspace_id,m.queue,m.id,m.pgmq_msg_id FROM queue.messages m
  WHERE m.workspace_id=target_workspace_id AND m.id=target_message_id
    AND NOT EXISTS(SELECT FROM queue.deliveries x WHERE x.message_id=target_message_id)
  RETURNING * INTO d;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('data',NULL,'events','[]'::jsonb);
  END IF;
  RETURN queue.result(d,'queue.ready');
END $$;

REVOKE ALL ON queue.effects FROM PUBLIC,bp_server,bp_executor;
REVOKE ALL ON FUNCTION queue.effect_key(uuid,text,text),
  queue.fenced_delivery(uuid,uuid,bytea),queue.begin_effect(uuid,uuid,bytea,text,text),
  queue.pause_effects(uuid,uuid) FROM PUBLIC,bp_server,bp_executor;
GRANT EXECUTE ON FUNCTION queue.begin_effect(uuid,uuid,bytea,text,text),
  queue.pause_effects(uuid,uuid) TO bp_server;
RESET ROLE;
