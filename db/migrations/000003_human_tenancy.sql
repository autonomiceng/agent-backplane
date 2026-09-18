-- The migration runner supplies the transaction. Identity DDL generated from db/internal/auth.ts.
CREATE TABLE "control"."account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" text,
  "password" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp NOT NULL
);

CREATE TABLE "control"."invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organizationId" text NOT NULL,
  "email" text NOT NULL,
  "role" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "inviterId" text NOT NULL
);

CREATE TABLE "control"."member" (
  "id" text PRIMARY KEY NOT NULL,
  "organizationId" text NOT NULL,
  "userId" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "createdAt" timestamp NOT NULL
);

CREATE TABLE "control"."organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "createdAt" timestamp NOT NULL,
  "metadata" text,
  CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);

CREATE TABLE "control"."session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "token" text NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL,
  "activeOrganizationId" text,
  CONSTRAINT "session_token_unique" UNIQUE("token")
);

CREATE TABLE "control"."user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" boolean DEFAULT false NOT NULL,
  "image" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE("email")
);

CREATE TABLE "control"."verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "control"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "control"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "control"."invitation" ADD CONSTRAINT "invitation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "control"."organization"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "control"."invitation" ADD CONSTRAINT "invitation_inviterId_user_id_fk" FOREIGN KEY ("inviterId") REFERENCES "control"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "control"."member" ADD CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "control"."organization"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "control"."member" ADD CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "control"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "control"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "control"."user"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "account_userId_idx" ON "control"."account" USING btree ("userId");
CREATE INDEX "invitation_organizationId_idx" ON "control"."invitation" USING btree ("organizationId");
CREATE INDEX "invitation_email_idx" ON "control"."invitation" USING btree ("email");
CREATE INDEX "member_organizationId_idx" ON "control"."member" USING btree ("organizationId");
CREATE INDEX "member_userId_idx" ON "control"."member" USING btree ("userId");
CREATE INDEX "session_userId_idx" ON "control"."session" USING btree ("userId");
CREATE INDEX "verification_identifier_idx" ON "control"."verification" USING btree ("identifier");

CREATE UNIQUE INDEX organization_singleton ON control.organization ((true));
INSERT INTO control.organization (id, name, slug, "createdAt")
  VALUES ('default', 'Default', 'default', now());

-- Identity writes precede any Workspace and run through Better Auth without Run context.
CREATE FUNCTION control.enroll_user()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO control.member (id, "organizationId", "userId", role, "createdAt")
    VALUES ('seed:' || NEW.id, 'default', NEW.id, 'member', now());
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION control.enroll_user() FROM PUBLIC;
CREATE TRIGGER enroll_user AFTER INSERT ON control."user"
  FOR EACH ROW EXECUTE FUNCTION control.enroll_user();

CREATE TABLE control.workspaces (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES control.organization(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.principals (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES control.workspaces(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  role_name text NOT NULL UNIQUE CHECK (octet_length(role_name) <= 63),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bp_provisioner') THEN
    CREATE ROLE bp_provisioner NOLOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE bp_server NOCREATEROLE;
ALTER ROLE bp_executor NOCREATEROLE;
GRANT USAGE ON SCHEMA control, audit TO bp_provisioner;
GRANT SELECT ON audit.bound_context TO bp_provisioner;

CREATE FUNCTION control.create_principal_role(workspace_id uuid, principal_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET createrole_self_grant = ''
AS $$
DECLARE
  role_name text;
BEGIN
  IF NOT EXISTS (
    SELECT FROM audit.bound_context c
    WHERE c.backend_pid = pg_backend_pid() AND c.xid = pg_current_xact_id()
      AND c.workspace_id = create_principal_role.workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'context_missing';
  END IF;
  role_name := 'bp_p_' || translate(encode(uuid_send(workspace_id), 'base64'), '+/=', '-_')
    || '_' || translate(encode(uuid_send(principal_id), 'base64'), '+/=', '-_');
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS', role_name);
  RETURN role_name;
END
$$;
ALTER FUNCTION control.create_principal_role(uuid, uuid) OWNER TO bp_provisioner;
REVOKE ALL ON FUNCTION control.create_principal_role(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON SCHEMA control FROM PUBLIC;
REVOKE ALL ON control."user", control.session, control.account, control.verification,
  control.organization, control.member, control.invitation, control.workspaces, control.principals FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON control."user", control.session, control.account,
  control.verification, control.organization, control.member, control.invitation TO bp_server;
GRANT SELECT, INSERT ON control.workspaces, control.principals TO bp_server;
GRANT EXECUTE ON FUNCTION control.create_principal_role(uuid, uuid) TO bp_server;
