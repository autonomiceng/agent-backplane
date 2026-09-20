-- Private installation identity. Population belongs to fenced operator adoption.
CREATE TABLE control.blob_storage_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  database_id uuid NOT NULL,
  store_id uuid NOT NULL,
  generation uuid NOT NULL,
  backend text NOT NULL CHECK (backend IN ('filesystem','s3')),
  phase text NOT NULL CHECK (phase IN ('verifying','ready'))
);
REVOKE ALL ON control.blob_storage_binding FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.blob_storage_binding TO bp_server;

ALTER TABLE control.blob_storage_binding
  ADD COLUMN intent_kind text CHECK (intent_kind IN ('initialize','adopt','reconcile')),
  ADD COLUMN checkpoint_ref text,
  ADD COLUMN retain_unreferenced boolean NOT NULL DEFAULT false,
  ADD COLUMN inventory_sha256 text CHECK (inventory_sha256 ~ '^[0-9a-f]{64}$');
CREATE TABLE control.blob_storage_retained (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  staging boolean NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 0 AND 4194304),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (workspace_id,id,staging)
);
REVOKE ALL ON control.blob_storage_retained FROM PUBLIC,bp_executor,bp_server;
GRANT SELECT ON control.blob_storage_retained TO bp_server;
