-- The migration runner supplies the transaction.
SET LOCAL ROLE bp_audit;

ALTER TABLE audit.cursor
  ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN retention_floor bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT cursor_position_bounds
    CHECK (
      retention_floor >= 0
      AND retention_floor <= last_position
    );

GRANT SELECT (
  workspace_id, last_position, generation, retention_floor
) ON audit.cursor TO bp_server;

RESET ROLE;
