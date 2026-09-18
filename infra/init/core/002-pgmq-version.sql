-- Records which vendored PGMQ install ran, so readiness can refuse a cluster with the wrong version.
-- Keep in step with PGMQ_VERSION in infra/postgres/versions.env and REQUIRED_PGMQ_VERSION in readiness.ts.
CREATE TABLE IF NOT EXISTS pgmq.backplane_install (version text PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now());
INSERT INTO pgmq.backplane_install (version) VALUES ('1.12.0') ON CONFLICT DO NOTHING;
