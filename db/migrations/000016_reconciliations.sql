-- The runner supplies the transaction; evidence retention belongs to S24.
ALTER TABLE queue.effects ADD COLUMN reset boolean NOT NULL DEFAULT false;
CREATE TABLE control.reconciliation_delegations (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  granted_by text NOT NULL REFERENCES control."user"(id),
  member_id text NOT NULL,
  PRIMARY KEY (workspace_id,principal_id),
  FOREIGN KEY (workspace_id,principal_id) REFERENCES control.principals(workspace_id,id)
);
CREATE TABLE control.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  delivery_id uuid NOT NULL REFERENCES queue.deliveries(id),
  outcome text NOT NULL CHECK (outcome IN ('applied','not_applied','unknown')),
  evidence text NOT NULL CHECK (octet_length(convert_to(evidence,'UTF8')) BETWEEN 1 AND 4096),
  principal_id uuid,
  run_id uuid REFERENCES control.runs(id),
  user_id text,
  successor_delivery_id uuid REFERENCES queue.deliveries(id),
  decision_position bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,delivery_id,outcome),
  FOREIGN KEY (workspace_id,principal_id) REFERENCES control.principals(workspace_id,id),
  FOREIGN KEY (workspace_id,decision_position) REFERENCES audit.events(workspace_id,position),
  CHECK ((principal_id IS NOT NULL AND run_id IS NOT NULL AND user_id IS NULL)
    OR (principal_id IS NULL AND run_id IS NULL AND user_id IS NOT NULL)),
  CHECK ((outcome='not_applied')=(successor_delivery_id IS NOT NULL))
);
CREATE UNIQUE INDEX reconciliation_definitive ON control.reconciliations(workspace_id,delivery_id)
  WHERE outcome<>'unknown';
ALTER TABLE control.reconciliation_delegations OWNER TO bp_queue;
ALTER TABLE control.reconciliations OWNER TO bp_queue;
REVOKE ALL ON control.reconciliation_delegations,control.reconciliations FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.reconciliation_delegations TO bp_server;
GRANT SELECT ON control.member,control.workspaces,audit.events TO bp_queue;
SET LOCAL ROLE bp_queue;

-- Adapters lock current membership before calling; the cursor serializes delegation changes.
CREATE FUNCTION queue.reconciliation_actor(target_workspace_id uuid)
RETURNS audit.bound_context LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context;
BEGIN
  SELECT * INTO context FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id() AND workspace_id=target_workspace_id;
  IF context.user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM control.member m JOIN control.workspaces w ON w.organization_id=m."organizationId"
      WHERE w.id=target_workspace_id AND m."userId"=context.user_id) THEN
      RAISE EXCEPTION 'workspace_forbidden';
    END IF;
  ELSIF context.principal_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM control.reconciliation_delegations d
      JOIN control.workspaces w ON w.id=d.workspace_id
      JOIN control.member m ON m.id=d.member_id AND m."userId"=d.granted_by AND m."organizationId"=w.organization_id
      WHERE d.workspace_id=target_workspace_id AND d.principal_id=context.principal_id) THEN
      RAISE EXCEPTION 'reconciliation_forbidden';
    END IF;
  ELSE RAISE EXCEPTION 'context_missing'; END IF;
  RETURN context;
END $$;

CREATE FUNCTION queue.set_reconciliation_delegation(target_workspace_id uuid,target_principal_id uuid,enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context; membership_id text; changed_member text;
BEGIN
  context:=queue.reconciliation_actor(target_workspace_id);
  IF context.user_id IS NULL THEN RAISE EXCEPTION 'reconciliation_forbidden'; END IF;
  IF enabled IS NULL THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT m.id INTO STRICT membership_id FROM control.member m JOIN control.workspaces w ON w.organization_id=m."organizationId"
    WHERE w.id=target_workspace_id AND m."userId"=context.user_id ORDER BY m.id LIMIT 1;
  IF NOT EXISTS (SELECT FROM control.principals WHERE workspace_id=target_workspace_id
    AND id=target_principal_id AND (NOT enabled OR status='active')) THEN RAISE EXCEPTION 'principal_not_found'; END IF;
  IF enabled THEN
    INSERT INTO control.reconciliation_delegations(workspace_id,principal_id,granted_by,member_id)
      VALUES(target_workspace_id,target_principal_id,context.user_id,membership_id)
      ON CONFLICT (workspace_id,principal_id) DO UPDATE SET granted_by=EXCLUDED.granted_by,member_id=EXCLUDED.member_id
      WHERE (reconciliation_delegations.granted_by,reconciliation_delegations.member_id)
        IS DISTINCT FROM (EXCLUDED.granted_by,EXCLUDED.member_id) RETURNING member_id INTO changed_member;
  ELSE
    DELETE FROM control.reconciliation_delegations WHERE workspace_id=target_workspace_id AND principal_id=target_principal_id
      RETURNING member_id INTO changed_member;
  END IF;
  RETURN jsonb_build_object('changed',changed_member IS NOT NULL,'memberId',changed_member);
END $$;

CREATE FUNCTION queue.reconcile(target_workspace_id uuid,target_delivery_id uuid,decision text,decision_evidence text)
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
    INSERT INTO control.reconciliations(workspace_id,delivery_id,outcome,evidence,principal_id,run_id,user_id,successor_delivery_id)
      VALUES(target_workspace_id,d.id,decision,decision_evidence,context.principal_id,context.run_id,context.user_id,successor) RETURNING * INTO r;
    events:=jsonb_build_array(jsonb_build_object('kind','effect.reconciled',
      'objects',jsonb_build_array(d.queue,d.message_id,d.id,r.id),
      'metadata',jsonb_build_object('outcome',decision,'effectOutcome',CASE WHEN decision='unknown' THEN NULL ELSE decision END,'successorDeliveryId',successor)));
  END IF;
  RETURN jsonb_build_object('data',jsonb_build_object('id',r.id,'deliveryId',r.delivery_id,'outcome',r.outcome,
    'successorDeliveryId',r.successor_delivery_id,'decisionPosition',r.decision_position::text),'events',events);
END $$;

CREATE FUNCTION queue.finish_reconciliation(target_workspace_id uuid,reconciliation_id uuid,event_position bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE context audit.bound_context;
BEGIN
  context:=queue.reconciliation_actor(target_workspace_id);
  UPDATE control.reconciliations r SET decision_position=event_position
    FROM audit.events a,queue.deliveries d
    WHERE r.workspace_id=target_workspace_id AND r.id=reconciliation_id AND r.decision_position IS NULL
      AND d.id=r.delivery_id AND d.workspace_id=target_workspace_id
      AND a.workspace_id=target_workspace_id AND a.position=event_position AND a.kind='effect.reconciled'
      AND a.objects=ARRAY[d.queue,d.message_id::text,d.id::text,r.id::text] AND a.row_count=1
      AND a.metadata=jsonb_build_object('outcome',r.outcome,'effectOutcome',CASE WHEN r.outcome='unknown' THEN NULL ELSE r.outcome END,
        'successorDeliveryId',r.successor_delivery_id)
      AND (r.principal_id,r.run_id,r.user_id) IS NOT DISTINCT FROM (context.principal_id,context.run_id,context.user_id)
      AND (a.principal_id,a.run_id,a.user_id) IS NOT DISTINCT FROM (context.principal_id,context.run_id,context.user_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_conflict'; END IF;
END $$;

REVOKE ALL ON FUNCTION queue.reconciliation_actor(uuid),queue.reconcile(uuid,uuid,text,text),
  queue.finish_reconciliation(uuid,uuid,bigint),queue.set_reconciliation_delegation(uuid,uuid,boolean) FROM PUBLIC,bp_executor,bp_server;
GRANT EXECUTE ON FUNCTION queue.reconcile(uuid,uuid,text,text),queue.finish_reconciliation(uuid,uuid,bigint),
  queue.set_reconciliation_delegation(uuid,uuid,boolean) TO bp_server;

CREATE OR REPLACE FUNCTION queue.begin_effect(workspace_id uuid,delivery_id uuid,receipt_hash bytea,action text,destination text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE delivery queue.deliveries; derived_key text; stored_key text; stored_reset boolean; events jsonb:='[]';
BEGIN
  delivery:=queue.fenced_delivery(workspace_id,delivery_id,receipt_hash);
  IF action IS NULL OR destination IS NULL
    OR octet_length(convert_to(action,'UTF8')) NOT BETWEEN 1 AND 1024
    OR octet_length(convert_to(destination,'UTF8')) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  derived_key:=queue.effect_key(workspace_id,action,destination);
  SELECT e.effect_key,e.reset INTO stored_key,stored_reset FROM queue.effects e WHERE e.message_id=delivery.message_id FOR UPDATE;
  IF FOUND THEN
    IF stored_key<>derived_key THEN RAISE EXCEPTION 'effect_key_conflict'; END IF;
    IF stored_reset THEN
      IF delivery.state<>'leased' THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
      UPDATE queue.effects SET reset=false WHERE message_id=delivery.message_id;
      UPDATE queue.deliveries SET state='begun',effect_started_at=clock_timestamp()
        WHERE id=delivery_id RETURNING * INTO delivery;
      events:=queue.result(delivery,'effect.begin')->'events';
    ELSIF delivery.state<>'begun' THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
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

CREATE OR REPLACE FUNCTION queue.redispatch(target_workspace_id uuid,target_delivery_id uuid,expected_state text,event_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE d queue.deliveries; n queue.deliveries;
  physical text; payload jsonb; mid bigint; result jsonb;
BEGIN
  IF event_kind='queue.release' THEN
    IF NOT EXISTS (
      SELECT FROM audit.bound_context
      WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id()
        AND workspace_id=target_workspace_id
    ) THEN RAISE EXCEPTION 'context_missing'; END IF;
    SELECT * INTO d FROM queue.deliveries
      WHERE workspace_id=target_workspace_id AND id=target_delivery_id
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'delivery_not_found'; END IF;
    IF NOT d.current THEN RAISE EXCEPTION 'delivery_conflict'; END IF;
  ELSE
    d:=queue.locked_delivery(target_workspace_id,target_delivery_id,true);
  END IF;
  IF d.state<>expected_state OR d.effect_started_at IS NOT NULL
    OR EXISTS (SELECT FROM queue.effects e WHERE e.message_id=d.message_id AND NOT e.reset) THEN
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
  IF EXISTS (SELECT FROM queue.effects e WHERE e.message_id=d.message_id AND NOT e.reset)
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
RESET ROLE;
