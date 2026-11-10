BEGIN;
-- 변경 질문의 선택지(C28, COLLEAGUE_SPEC §4.10). 변경 작성 판(change-v2)의 needs_input이 낸 2~4개를 질문 행과 함께 둔다.
-- 선택지가 없는 질문(작업 질문, 옛 판 변경 질문)은 NULL이다. 칸을 더하기만 해 옛 코드가 같은 표를 써도 깨지지 않는다.
-- 질문 원문(prompt)과 같은 7일 정리(purgeExpiredQuestionPrompts)를 받는다: NULL로 두고 지우기 전 digest를 남긴다. 지운 시각은 prompt_purged_at이다.
ALTER TABLE codex_questions ADD COLUMN IF NOT EXISTS options jsonb CHECK (options IS NULL OR jsonb_typeof(options)='array');
ALTER TABLE codex_questions ADD COLUMN IF NOT EXISTS options_sha256 text CHECK (options_sha256 ~ '^[0-9a-f]{64}$');

INSERT INTO schema_migrations VALUES (24) ON CONFLICT DO NOTHING;
COMMIT;
