-- The migration runner supplies the transaction; executor enforcement owns row gates.
CREATE TABLE control.approval_gates (
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  target_kind text NOT NULL CHECK (target_kind IN ('row','migration')),
  selector text NOT NULL, enabled boolean NOT NULL, epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  declared_by text NOT NULL REFERENCES control."user"(id),
  PRIMARY KEY (workspace_id,target_kind,selector),
  CHECK (target_kind <> 'migration' OR selector = 'migration')
);
CREATE TRIGGER approval_context BEFORE INSERT OR UPDATE OR DELETE ON control.approval_gates
  FOR EACH ROW EXECUTE FUNCTION control.check_approval_context();
REVOKE ALL ON control.approval_gates FROM PUBLIC, bp_executor, bp_server;
GRANT SELECT, INSERT, UPDATE ON control.approval_gates TO bp_server;
ALTER TABLE control.approvals DROP CONSTRAINT approvals_target_kind_check,
  ADD CONSTRAINT approvals_target_kind_check CHECK (target_kind IN ('message','row','migration')),
  DROP CONSTRAINT approvals_target_unique,
  ADD COLUMN gate_epoch uuid, ADD COLUMN action_hash bytea CHECK (octet_length(action_hash)=32),
  ADD COLUMN row_table text, ADD COLUMN row_key jsonb,
  ADD COLUMN consumed_position bigint,
  ADD FOREIGN KEY (workspace_id,consumed_position) REFERENCES audit.events(workspace_id,position),
  ADD CHECK (consumed_position IS NULL OR (target_kind IN ('row','migration') AND decision IS NOT DISTINCT FROM 'approve'));
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid='control.approvals'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%released_delivery_id%';
  EXECUTE format('ALTER TABLE control.approvals DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE control.approvals ADD CONSTRAINT approvals_outcome_check CHECK (
  (decision IS NULL AND num_nonnulls(reason,decision_position,released_delivery_id)=0) OR
  (decision IS NOT NULL AND reason IS NOT NULL AND decision_position IS NOT NULL AND
    ((target_kind='message' AND decision='approve')=(released_delivery_id IS NOT NULL))));
CREATE UNIQUE INDEX approvals_target_unique ON control.approvals(workspace_id,target_kind,target_id,target_version)
  WHERE target_kind='message';
CREATE INDEX approvals_row_consumptions ON control.approvals(workspace_id,target_id,consumed_position DESC)
  WHERE target_kind='row' AND consumed_position IS NOT NULL;
GRANT USAGE ON SCHEMA control TO bp_executor;
GRANT SELECT (backend_pid,xid,workspace_id) ON audit.bound_context TO bp_executor;
GRANT SELECT ON control.approval_gates TO bp_executor;
GRANT SELECT (workspace_id,target_kind,target_id,consumed_position) ON control.approvals TO bp_executor;
GRANT SELECT (workspace_id,revision) ON control.workspace_migrations TO bp_executor;
CREATE FUNCTION control.lock_approval_row(workspace uuid, table_name text, key jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO, YMD' SET bytea_output='hex' AS $$
DECLARE schema_name text := 'ws_' || replace(workspace::text,'-','');
  rel oid; pk text[]; predicate text; typed_key jsonb; version text; target text;
  gate uuid; revision int; consumed bigint; temporal text[];
BEGIN
  IF NOT EXISTS (SELECT FROM audit.bound_context WHERE backend_pid=pg_backend_pid()
    AND xid=pg_current_xact_id() AND workspace_id=workspace) THEN RAISE EXCEPTION 'context_missing'; END IF;
  SELECT c.oid INTO rel FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=schema_name AND c.relname=table_name AND c.relkind='r' AND c.relpersistence='p'
      AND c.relowner='bp_executor'::regrole AND NOT c.relispartition;
  IF rel IS NULL OR EXISTS (SELECT FROM pg_inherits WHERE inhparent=rel OR inhrelid=rel)
    OR EXISTS (SELECT FROM pg_rewrite WHERE ev_class=rel)
    OR EXISTS (SELECT FROM pg_policy WHERE polrelid=rel)
    OR EXISTS (SELECT FROM pg_attribute WHERE attrelid=rel AND NOT attisdropped AND (attgenerated<>'' OR attidentity<>''))
    OR EXISTS (SELECT FROM pg_trigger WHERE tgrelid=rel AND NOT tgisinternal AND
      NOT (tgname='bp_stamp' AND tgfoid='audit.stamp_workspace_row()'::regprocedure AND tgenabled='A'
        AND tgtype=31 AND tgnargs=0 AND tgqual IS NULL AND tgattr=''::int2vector))
    OR EXISTS (SELECT FROM pg_constraint WHERE contype='f' AND (conrelid=rel OR confrelid=rel)
      AND (confupdtype NOT IN ('a','r') OR confdeltype NOT IN ('a','r')))
    THEN RAISE EXCEPTION 'approval_target_unsupported'; END IF;
  SELECT array_agg(a.attname ORDER BY k.n), string_agg(format('r.%I = k.%I',a.attname,a.attname),' AND ' ORDER BY k.n)
    INTO pk,predicate FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,n)
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
    WHERE i.indrelid=rel AND i.indisprimary AND i.indisvalid AND i.indimmediate;
  IF pk IS NULL OR NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid=rel AND tgname='bp_stamp'
    AND tgfoid='audit.stamp_workspace_row()'::regprocedure AND tgenabled='A') THEN RAISE EXCEPTION 'approval_target_unsupported'; END IF;
  SELECT coalesce(array_agg(attname),ARRAY[]::name[]) INTO temporal FROM pg_attribute WHERE attrelid=rel
    AND NOT attisdropped AND atttypid IN ('date'::regtype,'timestamptz'::regtype);
  IF key IS NULL THEN RETURN jsonb_build_object('oid',rel::text,'columns',pk,'temporal',temporal); END IF;
  IF jsonb_typeof(key)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(key) x)
    IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(pk) x)
    THEN RAISE EXCEPTION 'approval_mismatch'; END IF;
  EXECUTE format('SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_populate_record(NULL::%I.%I,$1) k,
    LATERAL jsonb_each(to_jsonb(k)) e WHERE e.key=ANY($2)',schema_name,table_name) INTO typed_key USING key,pk;
  IF EXISTS (SELECT FROM jsonb_each(typed_key) WHERE value='null'::jsonb) THEN RAISE EXCEPTION 'approval_mismatch'; END IF;
  SELECT epoch INTO gate FROM control.approval_gates WHERE workspace_id=workspace AND target_kind='row'
    AND selector=schema_name || '.' || table_name AND enabled;
  IF gate IS NULL THEN RAISE EXCEPTION 'approval_gate_not_found'; END IF;
  SELECT coalesce(max(m.revision),0) INTO revision FROM control.workspace_migrations m WHERE workspace_id=workspace;
  target := encode(sha256(convert_to(jsonb_build_array(1,schema_name,table_name,typed_key)::text,'UTF8')),'hex');
  SELECT max(consumed_position) INTO consumed FROM control.approvals
    WHERE workspace_id=workspace AND target_kind='row' AND target_id=target;
  EXECUTE format('SELECT encode(sha256(convert_to(jsonb_build_array(1,$1,$2,$3,$4,$5,to_jsonb(r))::text,''UTF8'')),''hex'')
    FROM ONLY %I.%I r CROSS JOIN jsonb_populate_record(NULL::%I.%I,$1) k WHERE %s FOR UPDATE OF r',
    schema_name,table_name,schema_name,table_name,predicate)
    INTO version USING typed_key,revision,rel,gate,consumed;
  IF version IS NULL THEN RAISE EXCEPTION 'approval_target_not_found'; END IF;
  RETURN jsonb_build_object('targetKind','row','targetId',target,'targetVersion',version,
    'table',schema_name || '.' || table_name,'primaryKey',typed_key::text,'epoch',gate,'oid',rel::text,'columns',pk);
END $$;
ALTER FUNCTION control.lock_approval_row(uuid,text,jsonb) OWNER TO bp_executor;
REVOKE ALL ON FUNCTION control.lock_approval_row(uuid,text,jsonb) FROM PUBLIC, bp_server;
GRANT EXECUTE ON FUNCTION control.lock_approval_row(uuid,text,jsonb) TO bp_server;
