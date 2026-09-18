-- The migration runner supplies the transaction. Expiry remains lazy at claim; no sweeper runs.
SET LOCAL ROLE bp_queue;

CREATE INDEX delivery_listing
ON queue.deliveries(workspace_id,queue,state,created_at,id);
CREATE INDEX delivery_listing_all
ON queue.deliveries(workspace_id,queue,created_at,id);

CREATE VIEW queue.delivery_envelopes AS
SELECT workspace_id,queue,state,created_at,id,
  to_jsonb(d)-ARRAY['receipt_token_hash','pgmq_msg_id'] AS envelope
FROM queue.deliveries d;

-- Private helper; adapters authorize Organization membership before calling.
CREATE FUNCTION queue.locked_delivery(target_workspace_id uuid,target_delivery_id uuid,require_user boolean)
RETURNS queue.deliveries LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context; d queue.deliveries;
BEGIN
  IF require_user THEN
    SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid()
      AND xid=pg_current_xact_id() AND workspace_id=target_workspace_id;
    IF c.user_id IS NULL THEN RAISE EXCEPTION 'recovery_forbidden'; END IF;
  ELSE
    c:=queue.context(target_workspace_id);
  END IF;
  SELECT * INTO d FROM queue.deliveries
    WHERE workspace_id=target_workspace_id AND id=target_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
  IF NOT d.current THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
  RETURN d;
END $$;

-- Private mechanism shared with S12.
CREATE FUNCTION queue.redispatch(target_workspace_id uuid,target_delivery_id uuid,expected_state text,event_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; n queue.deliveries;
  physical text; payload jsonb; mid bigint; result jsonb;
BEGIN
  d:=queue.locked_delivery(target_workspace_id,target_delivery_id,true);
  IF d.state<>expected_state OR d.effect_started_at IS NOT NULL THEN
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

CREATE FUNCTION queue.replay(target_workspace_id uuid,target_delivery_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
  SELECT queue.redispatch(target_workspace_id,target_delivery_id,'dead-lettered','queue.replay')
$$;

CREATE FUNCTION queue.cancel(target_workspace_id uuid,target_delivery_id uuid,force_cancel boolean,cancellation_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; physical text; result jsonb;
BEGIN
  d:=queue.locked_delivery(target_workspace_id,target_delivery_id,true);
  IF cancellation_reason IS NULL OR cancellation_reason!~'^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF d.state NOT IN ('ready','scheduled','leased')
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

CREATE FUNCTION queue.ensure_delivery(target_workspace_id uuid,target_message_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries;
BEGIN
  PERFORM queue.context(target_workspace_id);
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

GRANT SELECT ON queue.delivery_envelopes TO bp_server;
GRANT EXECUTE ON FUNCTION queue.replay(uuid,uuid),
  queue.cancel(uuid,uuid,boolean,text),
  queue.ensure_delivery(uuid,uuid) TO bp_server;
RESET ROLE;
