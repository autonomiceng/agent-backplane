CREATE TABLE control.enrollment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id text NOT NULL REFERENCES control."user"(id) ON DELETE RESTRICT,
  capability_hash bytea CHECK (capability_hash IS NULL OR octet_length(capability_hash) = 32)
);
ALTER TABLE control.enrollment OWNER TO CURRENT_USER;

-- Seal existing installations without changing their Users or memberships.
INSERT INTO control.enrollment (user_id, capability_hash)
SELECT id, NULL FROM control."user" ORDER BY "createdAt", id LIMIT 1;
DROP TRIGGER enroll_user ON control."user";
CREATE OR REPLACE FUNCTION control.enroll_user()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO control.member (id, "organizationId", "userId", role, "createdAt")
  VALUES ('enrollment:' || NEW.user_id, 'default', NEW.user_id, 'member', clock_timestamp());
  RETURN NEW;
END
$$;
ALTER FUNCTION control.enroll_user() OWNER TO CURRENT_USER;
CREATE TRIGGER enroll_user AFTER INSERT ON control.enrollment
FOR EACH ROW WHEN (NEW.capability_hash IS NOT NULL) EXECUTE FUNCTION control.enroll_user();
REVOKE ALL ON control.enrollment FROM PUBLIC, bp_server, bp_executor, bp_provisioner;
GRANT SELECT, INSERT ON control.enrollment TO bp_server;
REVOKE ALL ON FUNCTION control.enroll_user() FROM PUBLIC;
