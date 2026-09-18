-- The migration runner supplies the transaction.
CREATE TABLE control.approval_settings (
  workspace_id uuid PRIMARY KEY REFERENCES control.workspaces(id),
  allow_self_approval boolean NOT NULL DEFAULT false
);

CREATE TABLE control.approval_delegations (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  granted_by text NOT NULL REFERENCES control."user"(id),
  member_id text NOT NULL,
  PRIMARY KEY (workspace_id, principal_id),
  FOREIGN KEY (workspace_id, principal_id)
    REFERENCES control.principals(workspace_id, id)
);

CREATE TABLE control.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  target_kind text NOT NULL CHECK (target_kind = 'message'),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
  target_version text NOT NULL CHECK (length(target_version) BETWEEN 1 AND 128),
  requested_by uuid NOT NULL,
  requested_run_id uuid NOT NULL REFERENCES control.runs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('approve', 'reject')),
  reason text CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  decision_position bigint,
  released_delivery_id uuid,
  FOREIGN KEY (workspace_id, requested_by)
    REFERENCES control.principals(workspace_id, id),
  FOREIGN KEY (workspace_id, decision_position)
    REFERENCES audit.events(workspace_id, position),
  CONSTRAINT approvals_target_unique UNIQUE (workspace_id, target_kind, target_id, target_version),
  CHECK (expires_at > created_at
    AND expires_at <= created_at + interval '24 hours'),
  CHECK (
    (decision IS NULL AND
      num_nonnulls(reason, decision_position, released_delivery_id) = 0)
    OR
    (decision IS NOT NULL AND reason IS NOT NULL
      AND decision_position IS NOT NULL
      AND ((decision = 'approve') = (released_delivery_id IS NOT NULL)))
  )
);

CREATE FUNCTION control.check_approval_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.xid = pg_current_xact_id()
      AND c.workspace_id = coalesce(NEW.workspace_id, OLD.workspace_id)
      AND (TG_TABLE_NAME = 'approvals' OR c.user_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'context_missing';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION control.check_approval_context() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION control.check_approval_context()
  FROM PUBLIC, bp_executor, bp_server;

CREATE TRIGGER approval_context
BEFORE INSERT OR UPDATE OR DELETE ON control.approvals
FOR EACH ROW EXECUTE FUNCTION control.check_approval_context();
CREATE TRIGGER approval_context
BEFORE INSERT OR UPDATE OR DELETE ON control.approval_settings
FOR EACH ROW EXECUTE FUNCTION control.check_approval_context();
CREATE TRIGGER approval_context
BEFORE INSERT OR UPDATE OR DELETE ON control.approval_delegations
FOR EACH ROW EXECUTE FUNCTION control.check_approval_context();

REVOKE ALL ON control.approvals, control.approval_settings,
  control.approval_delegations FROM PUBLIC, bp_executor, bp_server;
GRANT SELECT, INSERT, UPDATE ON control.approvals,
  control.approval_settings TO bp_server;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON control.approval_delegations TO bp_server;

SET LOCAL ROLE bp_queue;
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

RESET ROLE;
