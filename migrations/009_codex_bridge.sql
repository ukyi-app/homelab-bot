BEGIN;
-- 봇 소유 Codex 작업의 외부 세션 기록. 소유자·대화는 jobs 행이 기준이다(`01` §6 소유자 연결).
CREATE TABLE IF NOT EXISTS codex_sessions (
  job_id text PRIMARY KEY REFERENCES jobs(id), thread_id text, turn integer NOT NULL DEFAULT 0,
  host text NOT NULL, capabilities jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('running','waiting_answer','completed','failed','cancelled','unknown')),
  created_at bigint NOT NULL, updated_at bigint NOT NULL
);
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
