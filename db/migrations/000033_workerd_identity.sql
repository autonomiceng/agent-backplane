-- Follows root's storage/S-identity schema migration 32; preserve historical OCI attribution.
ALTER TABLE control.deployments DROP CONSTRAINT deployments_runtime_digest_check;
ALTER TABLE control.deployments ADD CONSTRAINT deployments_runtime_digest_check
  CHECK (runtime_digest ~ '^([0-9a-f]{64}|workerd-binary-sha256:[0-9a-f]{64})$');
