BEGIN;
-- 작업 세션이 어떤 모델 대기로 멈췄는지. /resume-model이 jobs.wait_reason을 비우므로 재개 요청의 resumeReason은 이 값에서 얻는다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS wait_reason text CHECK (wait_reason IN ('model_limit','auth_expired'));
INSERT INTO schema_migrations VALUES (15) ON CONFLICT DO NOTHING;
COMMIT;
