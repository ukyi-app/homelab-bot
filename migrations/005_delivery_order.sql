BEGIN;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS message_key text;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS page_index integer;
UPDATE outbox SET
  message_key=regexp_replace(idempotency_key, ':page:[0-9]+$', ''),
  page_index=CASE WHEN idempotency_key ~ ':page:[0-9]+$'
    THEN substring(idempotency_key FROM ':page:([0-9]+)$')::integer - 1 ELSE 0 END
  WHERE message_key IS NULL;
ALTER TABLE outbox ALTER COLUMN message_key SET NOT NULL;
ALTER TABLE outbox ALTER COLUMN page_index SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_message_page ON outbox(message_key,page_index);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS delivery_key text;
UPDATE incidents i SET delivery_key=(SELECT o.idempotency_key FROM outbox o WHERE
    o.idempotency_key LIKE 'alert:' || i.group_key || ':%'
    OR (o.idempotency_key LIKE 'incident-summary:%' AND o.conversation_id=i.conversation_id)
    OR (i.conversation_id IS NULL AND o.payload->>'kind'='thread' AND EXISTS (SELECT 1 FROM events e
      WHERE e.id=o.payload->>'content' AND e.payload->>'group'=i.group_key))
  ORDER BY o.created_at DESC,
    CASE WHEN o.idempotency_key LIKE 'alert:' || i.group_key || ':%'
      THEN substring(o.idempotency_key FROM ':([0-9]+)$')::bigint ELSE 0 END DESC LIMIT 1)
  WHERE i.delivery_key IS NULL;
UPDATE jobs j SET type='read',available_at=LEAST(j.available_at,j.created_at)
  FROM events e WHERE j.event_id=e.id AND e.payload->>'command'='read' AND j.type='chat';
INSERT INTO schema_migrations VALUES (5) ON CONFLICT DO NOTHING;
COMMIT;
