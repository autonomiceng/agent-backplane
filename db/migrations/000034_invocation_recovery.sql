-- Deploy under the documented offline server fence. The table locks additionally
-- serialize the backfill with in-flight writers, not only other migrators.
DO $lock$
DECLARE previous_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout','5s',true);
  LOCK TABLE control.runs, control.invocation_tokens IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('lock_timeout',previous_timeout,true);
END $lock$;
CREATE TABLE control.invocation_pending (
  run_id uuid PRIMARY KEY REFERENCES control.runs(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX invocation_pending_expiry ON control.invocation_pending(expires_at,run_id);
ALTER TABLE control.invocation_pending OWNER TO bp_audit;
REVOKE ALL ON control.invocation_pending FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.invocation_pending TO bp_server;
INSERT INTO control.invocation_pending(run_id,expires_at)
  SELECT r.id,coalesce(t.expires_at,r.created_at) FROM control.runs r
  LEFT JOIN control.invocation_tokens t ON t.run_id=r.id
  WHERE r.invocation_deployment_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM audit.events e WHERE e.workspace_id=r.workspace_id AND e.run_id=r.id
      AND e.kind IN ('function.complete','function.fail','function.timeout'));

CREATE OR REPLACE FUNCTION control.create_invocation(deployment_id uuid,credential_hash bytea,timeout_ms integer)
RETURNS TABLE (run_id uuid,principal_id uuid,expires_at timestamptz,remaining_ms double precision)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context; d control.deployments; epoch uuid;
BEGIN
  SELECT * INTO c FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
  IF c.principal_id IS NULL OR c.run_id IS NULL THEN RAISE EXCEPTION 'run_required'; END IF;
  IF EXISTS (SELECT FROM control.runs WHERE id=c.run_id AND invocation_deployment_id IS NOT NULL)
    THEN RAISE EXCEPTION 'invocation_scope_forbidden'; END IF;
  IF timeout_ms IS NULL OR timeout_ms<1 OR credential_hash IS NULL OR octet_length(credential_hash)<>32
    THEN RAISE EXCEPTION 'invalid_input'; END IF;
  PERFORM control.assert_restore_open();
  SELECT g.epoch INTO epoch FROM control.restore_gate g WHERE singleton;
  SELECT * INTO d FROM control.deployments WHERE workspace_id=c.workspace_id AND id=deployment_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'function_not_found'; END IF;
  PERFORM 1 FROM control.principals p JOIN control.principal_keys k ON (k.workspace_id,k.principal_id)=(p.workspace_id,p.id)
    WHERE p.workspace_id=c.workspace_id AND p.id=d.principal_id AND p.status='active' AND k.revoked_at IS NULL FOR SHARE OF p,k;
  IF NOT FOUND THEN RAISE EXCEPTION 'function_not_found'; END IF;
  run_id:=gen_random_uuid(); principal_id:=d.principal_id; expires_at:=clock_timestamp()+timeout_ms*interval '1 millisecond';
  INSERT INTO control.runs(id,workspace_id,principal_id,parent_run_id,invocation_deployment_id,metadata)
    VALUES(run_id,c.workspace_id,d.principal_id,c.run_id,d.id,jsonb_build_object(
      'callerPrincipalId',c.principal_id,'callerRunId',c.run_id,'deploymentId',d.id));
  INSERT INTO control.invocation_tokens VALUES(credential_hash,run_id,expires_at,epoch);
  INSERT INTO control.invocation_pending VALUES(run_id,expires_at);
  remaining_ms:=extract(epoch FROM expires_at-clock_timestamp())*1000;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION control.finish_invocation(invocation_run uuid,event_kind text,duration_ms integer,http_status integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r control.runs; token text:=gen_random_uuid()::text;
BEGIN
  IF event_kind IS NULL OR event_kind NOT IN ('function.complete','function.fail','function.timeout')
    OR duration_ms IS NULL OR duration_ms<0 OR (http_status IS NOT NULL AND http_status NOT BETWEEN 100 AND 599)
    THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO r FROM control.runs WHERE id=invocation_run AND invocation_deployment_id IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'run_forbidden'; END IF;
  BEGIN
    PERFORM audit.lock_workspace(r.workspace_id);
    IF NOT EXISTS (SELECT FROM audit.events WHERE workspace_id=r.workspace_id AND run_id=r.id
      AND kind IN ('function.complete','function.fail','function.timeout')) THEN
      DELETE FROM audit.bound_context WHERE backend_pid=pg_backend_pid() AND xid<>pg_current_xact_id();
      INSERT INTO audit.bound_context(backend_pid,xid,token,workspace_id,principal_id,run_id)
        VALUES(pg_backend_pid(),pg_current_xact_id(),token,r.workspace_id,r.principal_id,r.id);
      PERFORM audit.emit(token,event_kind,ARRAY[r.invocation_deployment_id::text,r.id::text],NULL,
        jsonb_build_object('durationMs',duration_ms,'status',http_status,'reason',event_kind));
    END IF;
    DELETE FROM control.invocation_pending WHERE run_id=r.id;
  EXCEPTION WHEN lock_not_available OR serialization_failure OR deadlock_detected THEN
    -- A failed terminal audit lock must still revoke authority; a later call records the terminal event.
    NULL;
  END;
  DELETE FROM control.invocation_tokens WHERE run_id=r.id;
END $$;

ALTER FUNCTION control.create_invocation(uuid,bytea,integer) OWNER TO bp_audit;
ALTER FUNCTION control.finish_invocation(uuid,text,integer,integer) OWNER TO bp_audit;
