-- System Principal authority is bounded by guards, with no unused SQL roles.
CREATE OR REPLACE FUNCTION control.install_system_principals(w uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO control.principals(id,workspace_id,name,role_name,system)
    SELECT id,w,name,'bp_'||name||'_'||replace(w::text,'-',''),name
    FROM control.system_principals;
END $$;
GRANT SELECT ON control.system_principals TO bp_provisioner;
GRANT INSERT ON control.principals TO bp_provisioner;
ALTER FUNCTION control.install_system_principals(uuid) OWNER TO bp_provisioner;
ALTER FUNCTION control.workspace_system_principals() OWNER TO bp_provisioner;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT role_name FROM control.principals WHERE system IS NOT NULL LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=r.role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA control,queue FROM %I',r.role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION queue.purge_payloads(uuid,integer),control.record_disk_sample(bigint,bigint) FROM %I',r.role_name);
      EXECUTE format('DROP ROLE %I',r.role_name);
    END IF;
  END LOOP;
END $$;

-- Global telemetry has its own invocation identifier and never advances a Workspace cursor.
ALTER TABLE control.disk_samples DROP COLUMN workspace_id, DROP COLUMN principal_id;
ALTER TABLE control.disk_samples DROP CONSTRAINT disk_samples_run_id_fkey;
CREATE OR REPLACE FUNCTION control.record_disk_sample(database_bytes bigint,blob_bytes bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO control.disk_samples(database_bytes,blob_bytes,run_id)
    VALUES(database_bytes,blob_bytes,gen_random_uuid());
  DELETE FROM control.disk_samples WHERE observed_at NOT IN (SELECT observed_at FROM control.disk_samples ORDER BY observed_at DESC LIMIT 60);
END $$;
GRANT SELECT,INSERT,DELETE ON control.disk_samples TO bp_provisioner;
ALTER FUNCTION control.record_disk_sample(bigint,bigint) OWNER TO bp_provisioner;
