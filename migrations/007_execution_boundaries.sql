BEGIN;
ALTER TABLE events ADD COLUMN IF NOT EXISTS buffered boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS activation_after text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subscription_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS recovery_token text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS recovery_until bigint;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dispatch_started boolean NOT NULL DEFAULT false;
UPDATE outbox SET dispatch_started=true WHERE state IN ('sending','unknown')
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=7);
CREATE INDEX IF NOT EXISTS events_buffered ON events(conversation_id,event_order) WHERE buffered=true;
INSERT INTO schema_migrations VALUES (7) ON CONFLICT DO NOTHING;
COMMIT;
