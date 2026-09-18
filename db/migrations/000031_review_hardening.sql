-- The migration runner supplies the transaction. Existing mismatched references fail validation.
ALTER TABLE queue.deliveries
  ADD CONSTRAINT deliveries_workspace_id_id_key UNIQUE (workspace_id,id);
ALTER TABLE control.reconciliations
  DROP CONSTRAINT reconciliations_delivery_id_fkey,
  DROP CONSTRAINT reconciliations_successor_delivery_id_fkey,
  ADD CONSTRAINT reconciliations_workspace_delivery_fk
    FOREIGN KEY (workspace_id,delivery_id) REFERENCES queue.deliveries(workspace_id,id),
  ADD CONSTRAINT reconciliations_workspace_successor_fk
    FOREIGN KEY (workspace_id,successor_delivery_id) REFERENCES queue.deliveries(workspace_id,id);
ALTER TABLE control.approvals
  ADD CONSTRAINT approvals_workspace_released_delivery_fk
    FOREIGN KEY (workspace_id,released_delivery_id) REFERENCES queue.deliveries(workspace_id,id);

-- Preserve the UTC-naive Date contract of existing Better Auth rows during conversion.
ALTER TABLE control."account"
  ALTER COLUMN "accessTokenExpiresAt" TYPE timestamptz USING "accessTokenExpiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "refreshTokenExpiresAt" TYPE timestamptz USING "refreshTokenExpiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE control."invitation"
  ALTER COLUMN "expiresAt" TYPE timestamptz USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE control."member"
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE control."organization"
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE control."session"
  ALTER COLUMN "expiresAt" TYPE timestamptz USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE control."user"
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE control."verification"
  ALTER COLUMN "expiresAt" TYPE timestamptz USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt" AT TIME ZONE 'UTC';

-- Preserve the existing owner, grants and system-Principal exclusion.
CREATE OR REPLACE FUNCTION control.prepare_sql_roles()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET createrole_self_grant = ''
AS $$
DECLARE r record; g text;
BEGIN
  SELECT p.role_name, c.workspace_id, c.principal_id INTO r
  FROM audit.bound_context c JOIN control.principals p
    ON (p.workspace_id,p.id)=(c.workspace_id,c.principal_id)
  WHERE c.backend_pid=pg_backend_pid() AND c.xid=pg_current_xact_id()
    AND c.run_id IS NOT NULL AND p.status='active' AND p.system IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='context_missing';
  END IF;
  IF r.role_name IS DISTINCT FROM
    'bp_p_' || translate(encode(uuid_send(r.workspace_id), 'base64'), '+/=', '-_')
      || '_' || translate(encode(uuid_send(r.principal_id), 'base64'), '+/=', '-_') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='principal_role_invalid';
  END IF;
  g := 'bp_ws_' || replace(r.workspace_id::text, '-', '');
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=g) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS', g);
  END IF;
  EXECUTE format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT TRUE, SET FALSE',
    g, r.role_name);
  EXECUTE format('GRANT %I TO bp_server
    WITH ADMIN FALSE, INHERIT FALSE, SET TRUE', r.role_name);
  RETURN r.role_name;
END $$;
