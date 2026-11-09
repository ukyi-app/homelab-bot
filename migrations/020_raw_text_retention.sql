BEGIN;
-- 원문 칸 다섯 개의 7일 보존(DECISIONS "T31", 사용자 2026-11-09). 칸을 더하기만 해 옛 코드가 같은 표를 써도 깨지지 않는다.
-- digest는 지울 때 DB가 원문에서 계산한다. 행을 쓰는 옛 코드가 이 칸을 모르므로 쓰는 시점이 아니라 지우는 시점에 남긴다.

-- Discord 입력 원문(payload.text). 보존이 끝나면 text를 빈 문자열로 두고 이 시각을 적는다. 행·semantic_key·다른 payload 칸은 남는다.
ALTER TABLE events ADD COLUMN IF NOT EXISTS text_sha256 text CHECK (text_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE events ADD COLUMN IF NOT EXISTS text_purged_at bigint;
CREATE INDEX IF NOT EXISTS events_text_held ON events(received_at) WHERE text_purged_at IS NULL;

-- 모델이 낸 질문. prompt가 NOT NULL이라 빈 문자열로 둔다.
ALTER TABLE codex_questions ADD COLUMN IF NOT EXISTS prompt_sha256 text CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE codex_questions ADD COLUMN IF NOT EXISTS prompt_purged_at bigint;

-- 작업 결과(모델 출력). result가 NOT NULL이라 빈 객체로 둔다. digest는 jsonb의 text 표현에서 계산한다. evidence·classification은 남는다.
ALTER TABLE results ADD COLUMN IF NOT EXISTS result_sha256 text CHECK (result_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE results ADD COLUMN IF NOT EXISTS result_purged_at bigint;

-- 게시한 본문(payload.content). 빈 문자열로 둔다. 상태·external_id·message_key는 남는다.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS content_purged_at bigint;
CREATE INDEX IF NOT EXISTS outbox_content_held ON outbox(available_at) WHERE content_purged_at IS NULL AND state IN ('sent','blocked');

-- 요청에서 뽑은 공개 brief의 summary·goal·acceptanceCriteria. 원래 brief의 digest는 brief_digest에 이미 있다.
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS brief_purged_at bigint;

INSERT INTO schema_migrations VALUES (20) ON CONFLICT DO NOTHING;
COMMIT;
