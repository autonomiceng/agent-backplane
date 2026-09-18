-- S17a supplied the gate and consumption columns; Migration requests require an exact preview binding.
ALTER TABLE control.approvals ADD COLUMN preview_position bigint,
  ADD FOREIGN KEY (workspace_id,preview_position) REFERENCES audit.events(workspace_id,position);
ALTER TABLE control.approvals ADD CONSTRAINT approvals_migration_target_check CHECK (
  target_kind <> 'migration' OR (gate_epoch IS NOT NULL AND action_hash IS NOT NULL
    AND target_id = encode(action_hash,'hex') AND target_version ~ '^(0|[1-9][0-9]*)$'
    AND preview_position IS NOT NULL AND row_table IS NULL AND row_key IS NULL));
