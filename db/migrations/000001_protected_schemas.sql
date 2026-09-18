-- Protected schemas owned by the backplane. Principals never receive grants here.
CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS queue;
CREATE SCHEMA IF NOT EXISTS audit;

-- One row per applied repository migration. Forward-only; rows are never deleted.
CREATE TABLE IF NOT EXISTS control.schema_version (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
