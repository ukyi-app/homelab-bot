BEGIN;
-- 발송 한 길(src/outbound.ts)이 이 행으로 보낸 최종 payload의 sha256. 같은 바이트를 다른 행으로 다시 보내지 않는 대조에 쓴다.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS sent_digest text CHECK (sent_digest ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS outbox_sent_digest ON outbox(sent_digest) WHERE sent_digest IS NOT NULL;

INSERT INTO schema_migrations VALUES (29) ON CONFLICT DO NOTHING;
COMMIT;
