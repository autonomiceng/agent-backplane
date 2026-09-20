-- Fenced, one-way filesystem -> local RustFS intent. Operator/admin only.
CREATE TABLE control.blob_storage_migration (
  id uuid PRIMARY KEY,
  phase text NOT NULL CHECK (phase IN ('copying','committed_pending_checkpoint','complete','aborted')),
  database_id uuid NOT NULL,
  source_store_id uuid NOT NULL,
  source_generation uuid NOT NULL,
  target_store_id uuid NOT NULL,
  target_generation uuid NOT NULL,
  checkpoint_sha256 text NOT NULL CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  artifacts_sha256 text NOT NULL CHECK (artifacts_sha256 ~ '^[0-9a-f]{64}$'),
  inventory_sha256 text NOT NULL CHECK (inventory_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK (COALESCE(jsonb_typeof(snapshot) = 'object'
    AND snapshot ?& ARRAY['systemId','timeline','postgres','schema','pgmq','heads']
    AND snapshot - ARRAY['systemId','timeline','postgres','schema','pgmq','heads'] = '{}'::jsonb
    AND snapshot->>'systemId' ~ '^[0-9]+$' AND snapshot->>'timeline' ~ '^[0-9]+$'
    AND snapshot->>'postgres' ~ '^[0-9]+$' AND snapshot->>'schema' ~ '^[0-9]+$'
    AND snapshot->>'pgmq' ~ '^[0-9]+([.][0-9]+)*$' AND jsonb_typeof(snapshot->'heads') = 'array', false)),
  target jsonb NOT NULL CHECK (COALESCE(jsonb_typeof(target) = 'object'
    AND target ?& ARRAY['project','volume','bucket','endpoint','image','credentialsSha256']
    AND target - ARRAY['project','volume','bucket','endpoint','image','credentialsSha256'] = '{}'::jsonb
    AND target->>'project' ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
    AND target->>'volume' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$'
    AND target->>'bucket' ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
    AND target->>'endpoint' = 'http://rustfs:9000'
    AND target->>'image' = 'sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
    AND target->>'credentialsSha256' ~ '^[0-9a-f]{64}$', false)),
  CHECK (source_store_id <> target_store_id AND source_generation <> target_generation)
);
CREATE UNIQUE INDEX blob_storage_migration_current ON control.blob_storage_migration ((true)) WHERE phase <> 'aborted';
CREATE UNIQUE INDEX blob_storage_migration_target_volume ON control.blob_storage_migration ((target->>'volume'));
-- Completion evidence is append-only so no existing proof is ever replaced.
CREATE TABLE control.blob_storage_migration_completion (
  migration_id uuid PRIMARY KEY REFERENCES control.blob_storage_migration(id),
  checkpoint_sha256 text NOT NULL CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  artifacts_sha256 text NOT NULL CHECK (artifacts_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE FUNCTION control.guard_blob_storage_migration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$ DECLARE head jsonb; BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'copying' THEN RAISE EXCEPTION 'migration must begin copying'; END IF;
    FOR head IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'heads') LOOP
      IF NOT COALESCE(jsonb_typeof(head) = 'object' AND head ?& ARRAY['workspaceId','head']
        AND head - ARRAY['workspaceId','head'] = '{}'::jsonb
        AND head->>'workspaceId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        AND head->>'head' ~ '^[0-9]+$', false) THEN RAISE EXCEPTION 'invalid migration audit head'; END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'blob migration evidence is immutable'; END IF;
  IF TG_TABLE_NAME = 'blob_storage_migration_completion' THEN RAISE EXCEPTION 'completion evidence is immutable'; END IF;
  IF (to_jsonb(NEW) - 'phase') IS DISTINCT FROM (to_jsonb(OLD) - 'phase') OR
     NOT ((OLD.phase = 'copying' AND NEW.phase IN ('committed_pending_checkpoint','aborted')) OR
          (OLD.phase = 'committed_pending_checkpoint' AND NEW.phase = 'complete')) THEN
    RAISE EXCEPTION 'invalid blob migration transition';
  END IF;
  IF NEW.phase = 'complete' AND NOT EXISTS (SELECT FROM control.blob_storage_migration_completion WHERE migration_id=NEW.id) THEN
    RAISE EXCEPTION 'migration completion requires checkpoint evidence';
  END IF;
  IF NEW.phase IN ('committed_pending_checkpoint','complete') AND NOT EXISTS (SELECT FROM control.blob_storage_binding
    WHERE singleton AND phase='ready' AND backend='s3' AND database_id=NEW.database_id AND store_id=NEW.target_store_id AND generation=NEW.target_generation) THEN
    RAISE EXCEPTION 'migration target binding differs';
  END IF;
  IF NEW.phase = 'aborted' AND NOT EXISTS (SELECT FROM control.blob_storage_binding
    WHERE singleton AND phase='ready' AND backend='filesystem' AND database_id=NEW.database_id AND store_id=NEW.source_store_id AND generation=NEW.source_generation) THEN
    RAISE EXCEPTION 'migration source binding differs';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER blob_storage_migration_immutable BEFORE INSERT OR UPDATE OR DELETE ON control.blob_storage_migration
FOR EACH ROW EXECUTE FUNCTION control.guard_blob_storage_migration();
CREATE TRIGGER blob_storage_migration_completion_immutable BEFORE UPDATE OR DELETE ON control.blob_storage_migration_completion
FOR EACH ROW EXECUTE FUNCTION control.guard_blob_storage_migration();
REVOKE ALL ON control.blob_storage_migration,control.blob_storage_migration_completion FROM PUBLIC,bp_server,bp_executor;
GRANT SELECT ON control.blob_storage_migration TO bp_server;
REVOKE ALL ON FUNCTION control.guard_blob_storage_migration() FROM PUBLIC,bp_server,bp_executor;
