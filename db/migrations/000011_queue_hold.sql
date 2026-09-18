-- The migration runner supplies the transaction; held work leaves dispatch until User release.
SET LOCAL ROLE bp_queue;

CREATE FUNCTION queue.hold(target_workspace_id uuid,target_delivery_id uuid,receipt_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; delivery queue.deliveries; physical_queue text;
BEGIN
  context:=queue.context(target_workspace_id);
  SELECT * INTO delivery FROM queue.deliveries
    WHERE workspace_id=target_workspace_id AND id=target_delivery_id FOR UPDATE;
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

CREATE FUNCTION queue.release(target_workspace_id uuid,target_delivery_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
  SELECT queue.redispatch(target_workspace_id,target_delivery_id,'held','queue.release')
$$;

GRANT EXECUTE ON FUNCTION queue.hold(uuid,uuid,bytea),
  queue.release(uuid,uuid) TO bp_server;
RESET ROLE;
