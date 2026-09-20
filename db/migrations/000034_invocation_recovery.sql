-- Recovery scans invocation Runs by age without walking unrelated Run history.
CREATE INDEX invocation_recovery ON control.runs (created_at, id)
  WHERE invocation_deployment_id IS NOT NULL;
