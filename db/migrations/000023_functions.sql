CREATE TABLE control.functions (
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  principal_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES control.runs(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,name),
  UNIQUE (workspace_id,name,principal_id),
  FOREIGN KEY (workspace_id,principal_id)
    REFERENCES control.principals(workspace_id,id)
);

CREATE TABLE control.deployments (
  workspace_id uuid NOT NULL,
  function_name text NOT NULL,
  id uuid NOT NULL,
  bundle bytea NOT NULL
    CHECK (octet_length(bundle) BETWEEN 1 AND 4194304),
  bundle_hash bytea GENERATED ALWAYS AS (sha256(bundle)) STORED,
  size integer GENERATED ALWAYS AS (octet_length(bundle)) STORED,
  entry_point text NOT NULL CHECK (entry_point='default'),
  compatibility_date date NOT NULL,
  outbound_urls text[] NOT NULL CHECK (cardinality(outbound_urls)<=16),
  config_hash bytea NOT NULL CHECK (octet_length(config_hash)=32),
  runtime_digest text NOT NULL CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  principal_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES control.runs(id),
  created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered','active','retired')),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,function_name,principal_id)
    REFERENCES control.functions(workspace_id,name,principal_id),
  FOREIGN KEY (workspace_id,principal_id)
    REFERENCES control.principal_keys(workspace_id,principal_id)
);
CREATE UNIQUE INDEX deployment_active
  ON control.deployments(workspace_id,function_name)
  WHERE status='active';

CREATE FUNCTION control.guard_function_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context;
BEGIN
  SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid()
      AND xid=pg_current_xact_id()
      AND workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_missing'; END IF;
  IF TG_OP='INSERT' THEN
    IF TG_TABLE_NAME='deployments' THEN
      IF NEW.status IS DISTINCT FROM 'registered' THEN RAISE EXCEPTION 'deployment_immutable'; END IF;
    END IF;
    IF c.principal_id IS NULL OR c.run_id IS NULL THEN
      RAISE EXCEPTION 'run_required';
    END IF;
    NEW.principal_id:=c.principal_id;
    NEW.run_id:=c.run_id;
    NEW.created_at:=clock_timestamp();
  ELSE
    IF c.user_id IS NULL
      AND c.principal_id IS DISTINCT FROM OLD.principal_id THEN
      RAISE EXCEPTION 'function_forbidden';
    END IF;
    -- Generated values are unavailable before the row update; bundle remains immutable.
    IF (to_jsonb(NEW)-ARRAY['status','bundle_hash','size'])
      <>(to_jsonb(OLD)-ARRAY['status','bundle_hash','size'])
      OR NOT ((OLD.status,NEW.status) IN
        (('registered','active'),('active','retired'))) THEN
      RAISE EXCEPTION 'deployment_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION control.guard_function_write() OWNER TO bp_audit;
REVOKE ALL ON FUNCTION control.guard_function_write()
  FROM PUBLIC,bp_executor,bp_server;
CREATE TRIGGER function_context BEFORE INSERT ON control.functions
  FOR EACH ROW EXECUTE FUNCTION control.guard_function_write();
CREATE TRIGGER deployment_context BEFORE INSERT OR UPDATE
  ON control.deployments FOR EACH ROW
  EXECUTE FUNCTION control.guard_function_write();
REVOKE ALL ON control.functions,control.deployments
  FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT,INSERT ON control.functions,control.deployments TO bp_server;
GRANT UPDATE(status) ON control.deployments TO bp_server;
