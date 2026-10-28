BEGIN;
-- 기억 ID는 UUID로 발급해 복원 뒤에도 재사용하지 않는다. 삭제 재적용은 id와 created_at이 둘 다 맞을 때만 한다(DATA-02).
CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('configuration','decision','incident','preference')),
  statement text NOT NULL, topic text, details jsonb NOT NULL DEFAULT '{}',
  source_refs jsonb NOT NULL, source_keys jsonb NOT NULL DEFAULT '[]', source_revision text, observed_at bigint,
  owner_id text NOT NULL, scope jsonb NOT NULL, access_channels jsonb NOT NULL,
  output_classification text NOT NULL CHECK (output_classification IN ('internal','safe_summary')),
  valid_from bigint NOT NULL, expires_at bigint, recheck_at bigint, recheck_condition text,
  status text NOT NULL CHECK (status IN ('candidate','active','superseded','deleted')),
  replaces jsonb NOT NULL DEFAULT '[]', conflicts_with jsonb NOT NULL DEFAULT '[]', correction_reason text,
  deletion_requested_at bigint, created_at bigint NOT NULL, updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_topic ON memories(topic) WHERE status IN ('candidate','active');
CREATE TABLE IF NOT EXISTS memory_terms (
  memory_id text NOT NULL REFERENCES memories(id), term text NOT NULL, PRIMARY KEY (memory_id, term)
);
CREATE INDEX IF NOT EXISTS memory_terms_term ON memory_terms(term text_pattern_ops);
CREATE TABLE IF NOT EXISTS memory_exclusions (
  source_key text NOT NULL, owner_id text NOT NULL, created_at bigint NOT NULL, PRIMARY KEY (owner_id, source_key)
);
-- 삭제 요청의 진행 상태만 둔다. 복원되면 이 표도 되돌아가므로 삭제의 근거는 외부 원장이다.
CREATE TABLE IF NOT EXISTS memory_deletions (
  memory_id text NOT NULL, memory_created_at bigint NOT NULL, requested_by text NOT NULL,
  requested_at bigint NOT NULL,
  ledger_state text NOT NULL DEFAULT 'pending' CHECK (ledger_state IN ('pending','recorded')),
  applied_at bigint, PRIMARY KEY (memory_id, memory_created_at)
);
CREATE TABLE IF NOT EXISTS briefing_runs (
  schedule_id text NOT NULL, slot_date text NOT NULL, slot_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('composing','enqueued','blocked','missed')),
  reason text, outbox_key text, memory_ids jsonb NOT NULL DEFAULT '[]',
  lease_token text, lease_until bigint, created_at bigint NOT NULL, updated_at bigint NOT NULL,
  PRIMARY KEY (schedule_id, slot_date)
);
CREATE TABLE IF NOT EXISTS briefing_observations (
  source_id text PRIMARY KEY, last_ok_at bigint, last_attempt_at bigint NOT NULL, last_status text NOT NULL
);
INSERT INTO schema_migrations VALUES (10) ON CONFLICT DO NOTHING;
COMMIT;
