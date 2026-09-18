-- The runner supplies the transaction. Captures expire independently of permanent envelopes.
CREATE TABLE control.retention_settings (
  workspace_id uuid PRIMARY KEY REFERENCES control.workspaces(id),
  seconds integer NOT NULL DEFAULT 2592000 CHECK (seconds BETWEEN 1 AND 31536000)
);
ALTER TABLE control.retention_settings OWNER TO bp_queue;
REVOKE ALL ON control.retention_settings FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.retention_settings TO bp_server;
ALTER TABLE queue.messages ADD COLUMN expires_at timestamptz;
ALTER TABLE control.workspace_migrations ADD COLUMN expires_at timestamptz, ALTER COLUMN sql DROP NOT NULL;
ALTER TABLE control.reconciliations ADD COLUMN expires_at timestamptz, ALTER COLUMN evidence DROP NOT NULL;
UPDATE queue.messages SET expires_at=created_at+interval '30 days';
UPDATE control.workspace_migrations SET expires_at=applied_at+interval '30 days';
UPDATE control.reconciliations SET expires_at=created_at+interval '30 days';
ALTER TABLE queue.messages ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE control.workspace_migrations ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE control.reconciliations ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX message_expiry ON queue.messages(workspace_id,expires_at,id);
CREATE INDEX migration_expiry ON control.workspace_migrations(workspace_id,expires_at,revision) WHERE sql IS NOT NULL;
CREATE INDEX reconciliation_expiry ON control.reconciliations(workspace_id,expires_at,id) WHERE evidence IS NOT NULL;
CREATE INDEX delivery_payload_copies ON queue.deliveries(workspace_id,queue,message_id,pgmq_msg_id);
GRANT SELECT,UPDATE(sql) ON control.workspace_migrations TO bp_queue;
SET LOCAL ROLE bp_queue;
CREATE FUNCTION queue.capture_expiry(w uuid)
RETURNS timestamptz LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT clock_timestamp()+make_interval(secs=>coalesce((SELECT seconds FROM control.retention_settings WHERE workspace_id=w),2592000))
$$;
CREATE OR REPLACE FUNCTION queue.send_message(w uuid,n text,k text,p jsonb)
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
    idempotency_key,payload_hash,producer_principal_id,producer_run_id,expires_at)
    VALUES(w,n,mid,k,h,c.principal_id,c.run_id,queue.capture_expiry(w)) RETURNING * INTO m;
  RETURN QUERY SELECT m,true,b;
END $$;
-- This reader follows the original stored PGMQ id, including after archival.
CREATE FUNCTION queue.message_body(w uuid,i uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE physical text; mid bigint; deadline timestamptz; p jsonb;
BEGIN
  SELECT q.pgmq_queue,m.pgmq_msg_id,m.expires_at INTO physical,mid,deadline
    FROM queue.messages m JOIN queue.queues q ON (q.workspace_id,q.name)=(m.workspace_id,m.queue)
    WHERE m.workspace_id=w AND m.id=i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'payload_expired'; END IF;
  EXECUTE format('SELECT message FROM pgmq.%I WHERE msg_id=$1 UNION ALL SELECT message FROM pgmq.%I WHERE msg_id=$1',
    'q_'||physical,'a_'||physical) INTO p USING mid;
  IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'payload_expired'; END IF;
  IF p IS NULL THEN RAISE EXCEPTION 'payload_read_failed'; END IF;
  RETURN p;
END $$;
CREATE OR REPLACE FUNCTION queue.payload(w uuid,n text,i uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM queue.messages WHERE workspace_id=w AND queue=n AND id=i) THEN RETURN NULL; END IF;
  RETURN queue.message_body(w,i);
END $$;
CREATE OR REPLACE FUNCTION queue.claim(workspace_id uuid,queue_name text,receipt_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE
  context audit.bound_context; physical_queue text; message record;
  delivery queue.deliveries; previous_delivery queue.deliveries; claimed_message_id uuid;
  events jsonb:='[]'; result jsonb; payload jsonb; expired_before timestamptz:=clock_timestamp();
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
CREATE OR REPLACE FUNCTION queue.reconcile(target_workspace_id uuid,target_delivery_id uuid,decision text,decision_evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; d queue.deliveries; e queue.effects; r control.reconciliations;
  successor uuid; physical text; payload jsonb; mid bigint; events jsonb:='[]';
BEGIN
  context:=queue.reconciliation_actor(target_workspace_id);
  IF decision IS NULL OR decision NOT IN ('applied','not_applied','unknown') OR decision_evidence IS NULL
    OR octet_length(convert_to(decision_evidence,'UTF8')) NOT BETWEEN 1 AND 4096 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO d FROM queue.deliveries WHERE workspace_id=target_workspace_id AND id=target_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
  SELECT * INTO r FROM control.reconciliations WHERE workspace_id=target_workspace_id AND delivery_id=target_delivery_id AND outcome=decision;
  IF NOT FOUND THEN
    IF EXISTS (SELECT FROM control.reconciliations WHERE workspace_id=target_workspace_id AND delivery_id=target_delivery_id AND outcome<>'unknown') THEN
      RAISE EXCEPTION 'reconciliation_conflict';
    END IF;
    IF NOT d.current OR d.state NOT IN ('ambiguous','effect-paused') OR d.effect_started_at IS NULL
      OR d.receipt_token_hash IS NOT NULL OR d.next_attempt_at IS NOT NULL THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
    SELECT * INTO e FROM queue.effects WHERE workspace_id=target_workspace_id AND queue=d.queue AND message_id=d.message_id FOR UPDATE;
    IF NOT FOUND OR e.reset THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
    IF decision='applied' THEN
      UPDATE queue.deliveries SET state='succeeded',completed_at=clock_timestamp(),failure_code=NULL WHERE id=d.id;
    ELSIF decision='not_applied' THEN
      payload:=queue.payload(target_workspace_id,d.queue,d.message_id);
      IF payload IS NULL THEN RAISE EXCEPTION 'payload_expired'; END IF;
      SELECT pgmq_queue INTO STRICT physical FROM queue.queues WHERE workspace_id=target_workspace_id AND name=d.queue;
      SELECT x INTO STRICT mid FROM pgmq.send(physical,payload) x;
      UPDATE queue.deliveries SET current=false,state='cancelled',failure_code='reconciled_not_applied' WHERE id=d.id;
      INSERT INTO queue.deliveries(workspace_id,queue,message_id,pgmq_msg_id,parent_id,attempt,max_attempts)
        VALUES(target_workspace_id,d.queue,d.message_id,mid,d.id,1,5) RETURNING id INTO successor;
      UPDATE queue.effects SET reset=true WHERE message_id=d.message_id;
    END IF;
    INSERT INTO control.reconciliations(workspace_id,delivery_id,outcome,evidence,principal_id,run_id,user_id,successor_delivery_id,expires_at)
      VALUES(target_workspace_id,d.id,decision,decision_evidence,context.principal_id,context.run_id,context.user_id,successor,queue.capture_expiry(target_workspace_id)) RETURNING * INTO r;
    events:=jsonb_build_array(jsonb_build_object('kind','effect.reconciled',
      'objects',jsonb_build_array(d.queue,d.message_id,d.id,r.id),
      'metadata',jsonb_build_object('outcome',decision,'effectOutcome',CASE WHEN decision='unknown' THEN NULL ELSE decision END,'successorDeliveryId',successor)));
  END IF;
  RETURN jsonb_build_object('data',jsonb_build_object('id',r.id,'deliveryId',r.delivery_id,'outcome',r.outcome,
    'successorDeliveryId',r.successor_delivery_id,'decisionPosition',r.decision_position::text),'events',events);
END $$;
CREATE FUNCTION queue.audit_payload(w uuid,p bigint)
RETURNS TABLE(kind text,value jsonb,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a audit.events; source_id uuid;
BEGIN
  SELECT * INTO a FROM audit.events WHERE workspace_id=w AND position=p;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit_event_not_found'; END IF;
  IF a.kind NOT IN ('queue.send','migration.applied','effect.reconciled') THEN RAISE EXCEPTION 'payload_not_captured'; END IF;
  IF a.kind='queue.send' THEN
    SELECT m.id,m.expires_at INTO source_id,expires_at FROM queue.messages m
      WHERE m.workspace_id=w AND a.objects=ARRAY[m.queue,m.id::text]
        AND (a.principal_id,a.run_id,a.user_id) IS NOT DISTINCT FROM (m.producer_principal_id,m.producer_run_id,NULL::text);
    kind:='message';
  ELSIF a.kind='migration.applied' THEN
    SELECT to_jsonb(m.sql),m.expires_at INTO value,expires_at FROM control.workspace_migrations m
      WHERE m.workspace_id=w AND m.revision::text=a.metadata->>'revision'
        AND (a.principal_id,a.run_id,a.user_id) IS NOT DISTINCT FROM (m.applied_by,m.run_id,NULL::text);
    kind:='migration';
  ELSIF a.kind='effect.reconciled' THEN
    SELECT to_jsonb(r.evidence),r.expires_at INTO value,expires_at FROM control.reconciliations r
      WHERE r.workspace_id=w AND r.decision_position=p AND r.id::text=a.objects[4]
        AND (a.principal_id,a.run_id,a.user_id) IS NOT DISTINCT FROM (r.principal_id,r.run_id,r.user_id);
    kind:='reconciliation';
  END IF;
  IF expires_at IS NULL THEN RAISE EXCEPTION 'payload_read_failed'; END IF;
  IF clock_timestamp()>=expires_at THEN RAISE EXCEPTION 'payload_expired'; END IF;
  IF source_id IS NOT NULL THEN value:=queue.message_body(w,source_id); END IF;
  IF value IS NULL THEN RAISE EXCEPTION 'payload_read_failed'; END IF;
  RETURN NEXT;
END $$;
CREATE FUNCTION queue.set_retention(w uuid,s integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (queue.reconciliation_actor(w)).user_id IS NULL THEN RAISE EXCEPTION 'retention_forbidden'; END IF;
  IF s IS NULL OR s NOT BETWEEN 1 AND 31536000 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  INSERT INTO control.retention_settings VALUES(w,s) ON CONFLICT(workspace_id) DO UPDATE SET seconds=EXCLUDED.seconds;
END $$;
CREATE FUNCTION queue.purge_payloads(w uuid,budget integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q queue.queues; copy record; item record; storage text; remaining integer:=budget; expired_before timestamptz:=clock_timestamp();
  scrubbed integer:=0; archived integer:=0; migrations integer:=0; reconciliations integer:=0; more boolean:=false;
BEGIN
  IF (queue.reconciliation_actor(w)).user_id IS NULL THEN RAISE EXCEPTION 'retention_forbidden'; END IF;
  IF budget IS NULL OR budget NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  <<copies>>
  FOR q IN SELECT * FROM queue.queues WHERE workspace_id=w ORDER BY name LOOP
    FOREACH storage IN ARRAY ARRAY['q_','a_'] LOOP
      FOR copy IN EXECUTE format(
        'WITH ids AS (SELECT m.pgmq_msg_id FROM queue.messages m WHERE m.workspace_id=$1 AND m.queue=$2 AND m.expires_at<=$3
          UNION SELECT d.pgmq_msg_id FROM queue.messages m JOIN queue.deliveries d
          ON (d.workspace_id,d.queue,d.message_id)=(m.workspace_id,m.queue,m.id)
          WHERE m.workspace_id=$1 AND m.queue=$2 AND m.expires_at<=$3)
        SELECT p.msg_id FROM pgmq.%I p JOIN ids ON ids.pgmq_msg_id=p.msg_id
        WHERE $4 OR p.message IS DISTINCT FROM ''null''::jsonb ORDER BY p.msg_id LIMIT $5',storage||q.pgmq_queue)
        USING w,q.name,expired_before,storage='a_',remaining+1
      LOOP
        IF remaining=0 THEN more:=true; EXIT copies; END IF;
        IF storage='q_' THEN
          EXECUTE format('UPDATE pgmq.%I SET message=''null''::jsonb WHERE msg_id=$1',storage||q.pgmq_queue) USING copy.msg_id;
          scrubbed:=scrubbed+1;
        ELSE
          EXECUTE format('DELETE FROM pgmq.%I WHERE msg_id=$1',storage||q.pgmq_queue) USING copy.msg_id;
          archived:=archived+1;
        END IF;
        remaining:=remaining-1;
      END LOOP;
    END LOOP;
  END LOOP;
  FOR item IN SELECT revision FROM control.workspace_migrations WHERE workspace_id=w
    AND expires_at<=expired_before AND sql IS NOT NULL ORDER BY expires_at,revision LIMIT remaining+1
  LOOP
    IF remaining=0 THEN more:=true; EXIT; END IF;
    UPDATE control.workspace_migrations SET sql=NULL WHERE workspace_id=w AND revision=item.revision;
    migrations:=migrations+1; remaining:=remaining-1;
  END LOOP;
  FOR item IN SELECT id FROM control.reconciliations WHERE workspace_id=w
    AND expires_at<=expired_before AND evidence IS NOT NULL ORDER BY expires_at,id LIMIT remaining+1
  LOOP
    IF remaining=0 THEN more:=true; EXIT; END IF;
    UPDATE control.reconciliations SET evidence=NULL WHERE workspace_id=w AND id=item.id;
    reconciliations:=reconciliations+1; remaining:=remaining-1;
  END LOOP;
  RETURN jsonb_build_object('counts',jsonb_build_object('queueBodies',scrubbed,'archiveRows',archived,
    'migrationSql',migrations,'reconciliationEvidence',reconciliations),'hasMore',more);
END $$;
REVOKE ALL ON FUNCTION queue.capture_expiry(uuid),queue.message_body(uuid,uuid),queue.audit_payload(uuid,bigint),
  queue.set_retention(uuid,integer),queue.purge_payloads(uuid,integer) FROM PUBLIC,bp_executor,bp_server;
GRANT EXECUTE ON FUNCTION queue.capture_expiry(uuid),queue.message_body(uuid,uuid),queue.audit_payload(uuid,bigint),
  queue.set_retention(uuid,integer),queue.purge_payloads(uuid,integer) TO bp_server;
RESET ROLE;
