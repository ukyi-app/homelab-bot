BEGIN;
-- Old alert payloads contain only counts, so their service scope cannot be reconstructed safely.
WITH changed AS (
  UPDATE outbox SET state='blocked'
  WHERE state IN ('pending','sending','unknown') AND service_ids='[]'::jsonb
    AND (idempotency_key LIKE 'incident:%' OR idempotency_key LIKE 'incident-summary:%'
      OR idempotency_key LIKE 'alert:%')
  RETURNING id,created_at
)
INSERT INTO audit(kind,subject,detail,created_at)
  SELECT 'legacy_alert_scope_missing',id,'{"reason":"service_scope_unrecoverable","resend":false}'::jsonb,created_at FROM changed;
INSERT INTO schema_migrations VALUES (6) ON CONFLICT DO NOTHING;
COMMIT;
