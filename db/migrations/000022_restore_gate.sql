-- The runner supplies the transaction. Only isolated restore bootstrap arms this gate.
CREATE TABLE control.restore_gate (
  singleton boolean PRIMARY KEY CHECK (singleton), epoch uuid, active boolean NOT NULL,
  backup_id text, target_lsn pg_lsn, CHECK (NOT active OR epoch IS NOT NULL)
);
INSERT INTO control.restore_gate VALUES (true,NULL,false,NULL,NULL);
CREATE TABLE control.restore_workspaces (
  epoch uuid NOT NULL, workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  generation uuid NOT NULL DEFAULT gen_random_uuid(), minimum_head bigint NOT NULL CHECK (minimum_head>=0),
  rotated boolean NOT NULL DEFAULT false, done boolean NOT NULL DEFAULT false,
  released_by text REFERENCES control."user"(id), PRIMARY KEY(epoch,workspace_id)
);
ALTER TABLE control.restore_gate OWNER TO bp_audit;
ALTER TABLE control.restore_workspaces OWNER TO bp_audit;
REVOKE ALL ON control.restore_gate,control.restore_workspaces FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.restore_gate,control.restore_workspaces TO bp_server,bp_queue;
GRANT USAGE ON SCHEMA queue TO bp_audit;
GRANT SELECT ON control.member,control.workspaces,queue.deliveries TO bp_audit;
CREATE FUNCTION control.assert_restore_open()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gated boolean;
BEGIN
  SELECT active INTO gated FROM control.restore_gate WHERE singleton FOR SHARE;
  IF NOT FOUND OR gated THEN RAISE EXCEPTION 'restore_gated'; END IF;
END $$;
ALTER FUNCTION control.assert_restore_open() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION control.assert_restore_open() FROM PUBLIC,bp_executor;
GRANT EXECUTE ON FUNCTION control.assert_restore_open() TO bp_server,bp_queue;
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
  IF principal_id IS NOT NULL THEN PERFORM control.assert_restore_open(); END IF;
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

CREATE OR REPLACE FUNCTION queue.claim(workspace_id uuid,queue_name text,receipt_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE
  context audit.bound_context; physical_queue text; message record;
  delivery queue.deliveries; previous_delivery queue.deliveries; claimed_message_id uuid;
  events jsonb:='[]'; result jsonb; payload jsonb; expired_before timestamptz:=clock_timestamp();
BEGIN
  context:=queue.context(workspace_id);
  PERFORM control.assert_restore_open();
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
  FOR delivery IN SELECT d.* FROM queue.deliveries d JOIN queue.messages m ON m.id=d.message_id
    WHERE d.workspace_id=claim.workspace_id AND d.queue=queue_name AND d.current
      AND d.state IN ('ready','scheduled') AND m.expires_at<=expired_before
    ORDER BY m.expires_at,d.id LIMIT 32 FOR UPDATE OF d
  LOOP
    IF NOT pgmq.archive(physical_queue,delivery.pgmq_msg_id) THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
    UPDATE queue.deliveries SET state='dead-lettered',failure_code='payload_expired',
      next_attempt_at=NULL,completed_at=clock_timestamp() WHERE id=delivery.id RETURNING * INTO delivery;
    events:=events||(jsonb_set(queue.result(delivery,'queue.dead-letter'),
      '{events,0,metadata,reason}','"payload_expired"'::jsonb)->'events');
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
    BEGIN
      payload:=queue.payload(workspace_id,queue_name,delivery.message_id);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'payload_expired' THEN RAISE; END IF;
      payload:=NULL;
    END;
    IF payload IS NULL THEN
      IF NOT pgmq.archive(physical_queue,delivery.pgmq_msg_id) THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
      UPDATE queue.deliveries SET state='dead-lettered',failure_code='payload_expired',
        next_attempt_at=NULL,completed_at=clock_timestamp() WHERE id=delivery.id RETURNING * INTO delivery;
      events:=events||(jsonb_set(queue.result(delivery,'queue.dead-letter'),
        '{events,0,metadata,reason}','"payload_expired"'::jsonb)->'events');
      CONTINUE;
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
      'events',events||(result->'events'),'payload',payload);
  END LOOP;
  RETURN jsonb_build_object('data',NULL,'events',events);
END $$;
ALTER FUNCTION queue.claim(uuid,text,bytea) OWNER TO bp_queue;
CREATE FUNCTION audit.restore_progress(e uuid,w uuid,finish boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context; g control.restore_gate; p control.restore_workspaces;
BEGIN
  SELECT * INTO c FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id() AND workspace_id=w;
  IF c.user_id IS NULL THEN RAISE EXCEPTION 'workspace_forbidden'; END IF;
  PERFORM 1 FROM control.member m JOIN control.workspaces ws ON ws.organization_id=m."organizationId"
    WHERE ws.id=w AND m."userId"=c.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace_forbidden'; END IF;
  SELECT * INTO g FROM control.restore_gate WHERE singleton FOR UPDATE;
  IF g.epoch IS DISTINCT FROM e THEN RAISE EXCEPTION 'restore_conflict'; END IF;
  SELECT * INTO p FROM control.restore_workspaces WHERE epoch=e AND workspace_id=w FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_conflict'; END IF;
  IF p.done THEN RETURN true; END IF;
  IF NOT g.active THEN RAISE EXCEPTION 'restore_conflict'; END IF;
  IF NOT p.rotated THEN
    UPDATE audit.cursor SET generation=p.generation WHERE workspace_id=w AND last_position>=p.minimum_head;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore_conflict'; END IF;
    UPDATE control.restore_workspaces SET rotated=true WHERE epoch=e AND workspace_id=w;
  END IF;
  IF finish AND NOT EXISTS (SELECT FROM queue.deliveries WHERE workspace_id=w AND current AND state IN ('leased','begun')) THEN
    UPDATE control.restore_workspaces SET done=true,released_by=c.user_id WHERE epoch=e AND workspace_id=w;
    IF NOT EXISTS (SELECT FROM control.restore_workspaces WHERE epoch=e AND NOT done) THEN
      UPDATE control.restore_gate SET active=false WHERE singleton;
    END IF;
    RETURN true;
  END IF;
  RETURN false;
END $$;
ALTER FUNCTION audit.restore_progress(uuid,uuid,boolean) OWNER TO bp_audit;
REVOKE ALL ON FUNCTION audit.restore_progress(uuid,uuid,boolean) FROM PUBLIC,bp_executor;
GRANT EXECUTE ON FUNCTION audit.restore_progress(uuid,uuid,boolean) TO bp_server;
CREATE FUNCTION queue.restore_batch(e uuid,w uuid,batch_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; effect queue.effects; physical text; events jsonb:='[]';
BEGIN
  IF (queue.reconciliation_actor(w)).user_id IS NULL THEN RAISE EXCEPTION 'workspace_forbidden'; END IF;
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  IF NOT EXISTS (SELECT FROM control.restore_gate g JOIN control.restore_workspaces p ON p.epoch=g.epoch
    WHERE g.singleton AND g.active AND g.epoch=e AND p.workspace_id=w AND p.rotated AND NOT p.done) THEN
    RAISE EXCEPTION 'restore_conflict';
  END IF;
  FOR d IN SELECT * FROM queue.deliveries WHERE workspace_id=w AND current AND state IN ('leased','begun')
    ORDER BY id LIMIT batch_limit FOR UPDATE
  LOOP
    SELECT * INTO effect FROM queue.effects WHERE message_id=d.message_id FOR UPDATE;
    IF (d.state='begun' AND (effect.message_id IS NULL OR effect.reset))
      OR (d.state='leased' AND (d.effect_started_at IS NOT NULL OR (effect.message_id IS NOT NULL AND NOT effect.reset))) THEN
      RAISE EXCEPTION 'restore_conflict';
    END IF;
    SELECT pgmq_queue INTO STRICT physical FROM queue.queues WHERE workspace_id=w AND name=d.queue;
    d.state:=CASE WHEN d.state='begun' THEN 'ambiguous' ELSE 'scheduled' END;
    d.next_attempt_at:=CASE WHEN d.state='scheduled' THEN clock_timestamp()+interval '5 seconds' END;
    IF d.state='scheduled' THEN
      PERFORM pgmq.set_vt(physical,d.pgmq_msg_id,d.next_attempt_at);
      IF NOT FOUND THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
    ELSIF NOT pgmq.archive(physical,d.pgmq_msg_id) THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
    UPDATE queue.deliveries SET state=d.state,next_attempt_at=d.next_attempt_at,receipt_token_hash=NULL,
      completed_at=CASE WHEN d.state='ambiguous' THEN clock_timestamp() END,failure_code='restore'
      WHERE id=d.id RETURNING * INTO d;
    events:=events||(queue.result(d,CASE WHEN d.state='ambiguous' THEN 'effect.ambiguous' ELSE 'queue.restore' END)->'events');
  END LOOP;
  RETURN jsonb_build_object('events',events);
END $$;
ALTER FUNCTION queue.restore_batch(uuid,uuid,integer) OWNER TO bp_queue;
REVOKE ALL ON FUNCTION queue.restore_batch(uuid,uuid,integer) FROM PUBLIC,bp_executor;
GRANT EXECUTE ON FUNCTION queue.restore_batch(uuid,uuid,integer) TO bp_server;
