BEGIN;
-- 대화 모델의 실행 요청 제안(COLLEAGUE_SPEC §4.3, C13). 버튼에는 제안 ID만 싣고 값은 서버가 이 행에서 읽는다.
-- 상태는 pending에서 한 번만 끝 상태(confirmed·declined·expired·refused)로 바뀐다. 바꾸는 쪽은 행을 잠그고 state='pending'을 조건으로 쓴다.
-- 값: owner 원문을 쓰는 동작(작업 시작)은 source_event(원문 이벤트 참조)만 두고, 모델이 고른 값(C14 기억 진술)만 value에 둔다.
-- 끝 상태가 되면 value·source_event를 비우고 digest만 남긴다. 기억 삭제·7일 정리 뒤에도 내용이 이 표에 남지 않게 하려는 것이다.
CREATE TABLE IF NOT EXISTS proposals (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id),
  owner_id text NOT NULL,
  scope jsonb NOT NULL,
  action text NOT NULL,
  target text,
  value text,
  source_event text REFERENCES events(id),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  -- 제안을 낸 대화 job. 한 job은 제안 하나만 만든다(결과 처리를 다시 해도 둘이 되지 않는다).
  source_job text NOT NULL UNIQUE REFERENCES jobs(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','declined','expired','refused')),
  reason text,
  -- 확인 글의 outbox message_key. 확인 글의 Discord 메시지 ID는 그 outbox 행의 external_id다.
  message_key text NOT NULL,
  -- 실행으로 생긴 job(작업 시작이면 작업 job).
  result_job text REFERENCES jobs(id),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  settled_at bigint,
  settled_by text
);
CREATE INDEX IF NOT EXISTS proposals_pending ON proposals(expires_at) WHERE state='pending';

INSERT INTO schema_migrations VALUES (21) ON CONFLICT DO NOTHING;
COMMIT;
