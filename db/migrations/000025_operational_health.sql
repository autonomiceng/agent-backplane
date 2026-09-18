-- Read-only aggregates; the runner supplies the migration transaction.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='bp_operations') THEN
    CREATE ROLE bp_operations NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA control,queue TO bp_operations;
GRANT SELECT ON control.workspaces,control.workspace_quotas,control.quota_usage,
  control.restore_gate,control.restore_workspaces,queue.queues,queue.messages,queue.deliveries TO bp_operations;
GRANT pg_read_all_stats TO bp_operations;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_archive_statusdir(),pg_catalog.pg_control_system() TO bp_operations;
CREATE FUNCTION queue.operational_snapshot() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH clock AS MATERIALIZED (SELECT statement_timestamp() AS now),
ws AS MATERIALIZED (SELECT id,coalesce(q.open_sse_streams,16) AS stream_limit FROM control.workspaces w
  LEFT JOIN control.workspace_quotas q ON q.workspace_id=w.id),
listed AS (SELECT * FROM ws ORDER BY id LIMIT 100),
inventory AS MATERIALIZED (
  SELECT workspace_id,queue,state,created_at,next_attempt_at,lease_expires_at FROM queue.deliveries WHERE current
  UNION ALL SELECT m.workspace_id,m.queue,'ready',m.created_at,NULL,NULL FROM queue.messages m
    WHERE NOT EXISTS (SELECT FROM queue.deliveries d WHERE d.message_id=m.id)),
states AS (SELECT q.workspace_id,q.name AS queue,i.state,count(i.state) AS count,
  min(coalesce(i.next_attempt_at,i.created_at)) FILTER (WHERE i.state IN ('ready','scheduled')
    AND coalesce(i.next_attempt_at,i.created_at)<=clock.now) AS ready,
  count(*) FILTER (WHERE i.state IN ('leased','begun') AND i.lease_expires_at<=clock.now) AS expired,
  min(i.lease_expires_at) FILTER (WHERE i.state IN ('leased','begun') AND i.lease_expires_at<=clock.now) AS expiry
  FROM queue.queues q LEFT JOIN inventory i ON i.workspace_id=q.workspace_id AND i.queue=q.name CROSS JOIN clock
  GROUP BY q.workspace_id,q.name,i.state),
rows AS MATERIALIZED (SELECT workspace_id,queue,coalesce(jsonb_object_agg(state,count::text) FILTER (WHERE state IS NOT NULL),'{}') AS counts,
  min(ready) AS ready,sum(expired)::text AS expired,min(expiry) AS expiry FROM states GROUP BY workspace_id,queue),
metrics AS (SELECT workspace_id,state,sum(count)::text AS count FROM states GROUP BY workspace_id,state),
quotas AS MATERIALIZED (SELECT w.id AS workspace_id,r.resource,
  greatest(count(u.principal_id) FILTER (WHERE u.used>=r.resource_limit),CASE WHEN r.resource_limit=0 THEN 1 ELSE 0 END)::text AS exhausted
  FROM control.workspaces w LEFT JOIN control.workspace_quotas q ON q.workspace_id=w.id
  CROSS JOIN LATERAL (VALUES ('sql_statement_bytes',coalesce(q.sql_statement_bytes,1048576)),('sql_rows',coalesce(q.sql_rows,10000)),
    ('transaction_operations',coalesce(q.transaction_operations,600)),('queue_sends',coalesce(q.queue_sends,600))) r(resource,resource_limit)
  CROSS JOIN clock LEFT JOIN control.quota_usage u ON u.workspace_id=w.id AND u.resource=r.resource
    AND u.window_start=date_trunc('minute',clock.now) GROUP BY w.id,r.resource,r.resource_limit)
SELECT jsonb_build_object('observedAt',clock.now,'workspaceCount',(SELECT count(*)::text FROM ws),
  'streamLimits',(SELECT coalesce(jsonb_agg(jsonb_build_object('workspaceId',id,'limit',stream_limit) ORDER BY id),'[]') FROM ws),
  'workspaces',(SELECT coalesce(jsonb_agg(jsonb_build_object('workspaceId',id,'limit',stream_limit) ORDER BY id),'[]') FROM listed),
  'queueCount',(SELECT count(*)::text FROM rows),
  'queues',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY workspace_id,queue),'[]') FROM
    (SELECT * FROM rows WHERE workspace_id IN (SELECT id FROM listed) ORDER BY workspace_id,queue LIMIT 1000) r),
  'global',jsonb_build_object('counts',(SELECT coalesce(jsonb_object_agg(state,count),'{}') FROM
    (SELECT state,sum(count)::text AS count FROM states WHERE state IS NOT NULL GROUP BY state) s),
    'ready',(SELECT min(ready) FROM rows),'expired',(SELECT coalesce(sum(expired::bigint),0)::text FROM rows),'expiry',(SELECT min(expiry) FROM rows)),
  'metrics',(SELECT coalesce(jsonb_agg(jsonb_build_object('workspace_id',w.id,'counts',
    (SELECT coalesce(jsonb_object_agg(state,count) FILTER (WHERE state IS NOT NULL),'{}') FROM metrics m WHERE m.workspace_id=w.id),
    'ready',(SELECT min(ready) FROM rows WHERE workspace_id=w.id),'expired',(SELECT coalesce(sum(expired::bigint),0)::text FROM rows WHERE workspace_id=w.id),
    'expiry',(SELECT min(expiry) FROM rows WHERE workspace_id=w.id)) ORDER BY w.id),'[]') FROM listed w),
  'quotas',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY workspace_id,resource),'[]') FROM quotas q WHERE workspace_id IN (SELECT id FROM listed)),
  'quotaExhausted',(SELECT coalesce(sum(exhausted::bigint),0)::text FROM quotas),
  'restore',(SELECT jsonb_build_object('active',active,'epoch',epoch,'released',
    (SELECT count(*)::text FROM control.restore_workspaces w WHERE w.epoch=g.epoch AND done),'pending',
    (SELECT count(*)::text FROM control.restore_workspaces w WHERE w.epoch=g.epoch AND NOT done)) FROM control.restore_gate g WHERE singleton)) FROM clock
$$;
CREATE FUNCTION control.operational_database() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT jsonb_build_object('observedAt',clock_timestamp(),'systemId',(pg_control_system()).system_identifier::text,
  'maxConnections',current_setting('max_connections'),
  'reservedConnections',(current_setting('superuser_reserved_connections')::int+current_setting('reserved_connections')::int)::text,
  'connections',(SELECT count(*)::text FROM pg_stat_activity WHERE backend_type='client backend'),
  'oldestTransaction', (SELECT min(xact_start) FROM pg_stat_activity WHERE pid<>pg_backend_pid()),
  'archiveEnabled',current_setting('archive_mode') IN ('on','always') AND
    (current_setting('archive_command')<>'' OR current_setting('archive_library')<>''),
  'oldestPending',min(modification),'latestPending',max(name))
FROM pg_ls_archive_statusdir() WHERE name ~ '^[0-9A-F]{24}[.]ready$'
$$;
ALTER FUNCTION queue.operational_snapshot() OWNER TO bp_operations;
ALTER FUNCTION control.operational_database() OWNER TO bp_operations;
REVOKE ALL ON FUNCTION queue.operational_snapshot(),control.operational_database() FROM PUBLIC,bp_executor;
GRANT EXECUTE ON FUNCTION queue.operational_snapshot(),control.operational_database() TO bp_server;
