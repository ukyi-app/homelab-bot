BEGIN;
-- 사람 입력 원문 두 칸의 7일 보존(DECISIONS "T27", 사용자 2026-11-07). 칸을 더하기만 해 옛 코드가 같은 표를 써도 깨지지 않는다.

-- 요청 원문·추가 답변. 보존이 끝나면 text를 빈 값으로 두고 이 시각을 적는다. text_sha256은 그대로 남는다.
ALTER TABLE change_request_inputs ADD COLUMN IF NOT EXISTS purged_at bigint;

-- 작업 레인 질문의 답. 보존이 끝나면 answer를 NULL로 두고 이 시각을 적는다.
-- answer_sha256은 지울 때 채운다. 답을 쓰는 옛 코드가 이 칸을 모르므로 쓰는 시점이 아니라 지우는 시점에 남긴다.
ALTER TABLE codex_questions ADD COLUMN IF NOT EXISTS answer_sha256 text CHECK (answer_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE codex_questions ADD COLUMN IF NOT EXISTS answer_purged_at bigint;
CREATE INDEX IF NOT EXISTS codex_questions_answer_held ON codex_questions(job_id) WHERE answer IS NOT NULL;

INSERT INTO schema_migrations VALUES (19) ON CONFLICT DO NOTHING;
COMMIT;
