BEGIN;
-- 봇 소유 Codex 작업의 외부 세션 기록. 소유자·대화는 jobs 행이 기준이다(`01` §6 소유자 연결).
CREATE TABLE IF NOT EXISTS codex_sessions (
  job_id text PRIMARY KEY REFERENCES jobs(id), thread_id text, turn integer NOT NULL DEFAULT 0,
  -- 같은 스레드를 잇는 동안 쓴 도구 호출 수. 작업 budget.toolCalls와 대조한다. null은 사용량을 모름(아래 업그레이드).
  tool_calls integer DEFAULT 0,
  -- 저장소는 작업 공간 원본(D-15 압축본)을 정하는 단계(T16b·T19)부터 채운다. 지금 작업 공간은 빈 저장소다.
  host text NOT NULL, repository text, capabilities jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('running','waiting_answer','waiting_model','completed','failed','cancelled','unknown')),
  created_at bigint NOT NULL, updated_at bigint NOT NULL
);
-- 이 009의 이전판으로 이미 만든 테이블을 맞춘다(rev r2 N4). 몇 번 다시 돌려도 결과가 같다.
-- 업그레이드 전 세션의 도구 사용량은 알 수 없어 null로 남기고, 브리지는 null인 세션을 잇지 않는다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS repository text;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS tool_calls integer;
ALTER TABLE codex_sessions ALTER COLUMN tool_calls SET DEFAULT 0;
ALTER TABLE codex_sessions DROP CONSTRAINT IF EXISTS codex_sessions_state_check;
ALTER TABLE codex_sessions ADD CONSTRAINT codex_sessions_state_check
  CHECK (state IN ('running','waiting_answer','waiting_model','completed','failed','cancelled','unknown'));
-- 질문 ID = job_id + thread_id + 턴 순번. 도구 승인 질문은 이 경로에 없다(capability=false).
CREATE TABLE IF NOT EXISTS codex_questions (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES jobs(id),
  conversation_id text NOT NULL REFERENCES conversations(id),
  thread_id text NOT NULL, turn integer NOT NULL,
  kind text NOT NULL CHECK (kind = 'clarification'),
  responder_id text NOT NULL, prompt text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','answered','resumed','expired','cancelled')),
  created_at bigint NOT NULL, expires_at bigint NOT NULL,
  answer text, answered_by text, answer_event text, answered_at bigint,
  UNIQUE (job_id, thread_id, turn)
);
CREATE UNIQUE INDEX IF NOT EXISTS codex_questions_one_open ON codex_questions(job_id) WHERE state='open';
INSERT INTO schema_migrations VALUES (9) ON CONFLICT DO NOTHING;
COMMIT;
