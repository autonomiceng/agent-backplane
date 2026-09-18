CREATE TABLE control.blobs (
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  id uuid NOT NULL,
  key text NOT NULL CHECK (
    octet_length(key) BETWEEN 1 AND 256
    AND key ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,3}$'
  ),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 4194304),
  sha256 bytea NOT NULL CHECK (octet_length(sha256)=32),
  content_type text NOT NULL CHECK (
    octet_length(content_type) BETWEEN 1 AND 128
    AND content_type !~ '[[:cntrl:]]'
  ),
  principal_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES control.runs(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,key),
  FOREIGN KEY (workspace_id,principal_id)
    REFERENCES control.principals(workspace_id,id),
  CHECK (expires_at>created_at)
);
CREATE INDEX blob_expiry
  ON control.blobs(workspace_id,expires_at,id);

CREATE FUNCTION control.stamp_blob()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE c audit.bound_context; w uuid;
BEGIN
  w:=CASE WHEN TG_OP='DELETE'
    THEN OLD.workspace_id ELSE NEW.workspace_id END;
  SELECT * INTO c FROM audit.bound_context
    WHERE backend_pid=pg_backend_pid()
      AND xid=pg_current_xact_id() AND workspace_id=w;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_missing'; END IF;

  IF TG_OP='INSERT' THEN
    IF c.principal_id IS NULL OR c.run_id IS NULL THEN
      RAISE EXCEPTION 'run_required';
    END IF;
    NEW.principal_id:=c.principal_id;
    NEW.run_id:=c.run_id;
    NEW.created_at:=clock_timestamp();
    NEW.expires_at:=NEW.created_at+make_interval(secs=>coalesce(
      (SELECT seconds FROM control.retention_settings
       WHERE workspace_id=w),2592000));
    RETURN NEW;
  END IF;

  IF c.user_id IS NULL THEN
    IF c.principal_id IS DISTINCT FROM OLD.principal_id THEN
      RAISE EXCEPTION 'blob_forbidden';
    END IF;
  ELSIF NOT EXISTS (
    SELECT FROM control.member m JOIN control.workspaces ws
      ON ws.organization_id=m."organizationId"
    WHERE ws.id=w AND m."userId"=c.user_id
  ) THEN RAISE EXCEPTION 'workspace_forbidden';
  END IF;
  RETURN OLD;
END $$;

ALTER FUNCTION control.stamp_blob() OWNER TO bp_audit;
GRANT SELECT ON control.retention_settings,
  control.member,control.workspaces TO bp_audit;
REVOKE ALL ON FUNCTION control.stamp_blob()
  FROM PUBLIC,bp_executor,bp_server;
CREATE TRIGGER blob_context BEFORE INSERT OR DELETE
  ON control.blobs FOR EACH ROW
  EXECUTE FUNCTION control.stamp_blob();
REVOKE ALL ON control.blobs FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT,INSERT,DELETE ON control.blobs TO bp_server;
