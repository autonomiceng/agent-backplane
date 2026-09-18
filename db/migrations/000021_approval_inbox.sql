CREATE INDEX approvals_inbox ON control.approvals
(workspace_id, (decision IS NOT NULL), created_at, id);
