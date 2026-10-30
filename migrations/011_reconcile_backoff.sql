BEGIN;
-- external_id 없는 unknown 행의 다음 marker 검색 시각. available_at은 unknown 진입 시각(24시간 폐기 기준)이라 따로 둔다.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS reconcile_after bigint;
INSERT INTO schema_migrations VALUES (11) ON CONFLICT DO NOTHING;
COMMIT;
