BEGIN;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS service_ids jsonb NOT NULL DEFAULT '[]';
UPDATE outbox o SET service_ids=jsonb_build_array(e.payload->>'target')
  FROM jobs j JOIN events e ON e.id=j.event_id JOIN results r ON r.job_id=j.id
  WHERE o.job_id=j.id AND e.payload->>'command'='read' AND e.payload->>'target' IS NOT NULL
    AND r.result->>'status'<>'unregistered'
    AND o.idempotency_key='result:' || j.id AND o.service_ids='[]'::jsonb;
INSERT INTO schema_migrations VALUES (4) ON CONFLICT DO NOTHING;
COMMIT;
