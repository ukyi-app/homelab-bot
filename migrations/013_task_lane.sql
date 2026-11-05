BEGIN;
-- T18 작업 레인(Claude)의 expand다. 새 열은 모두 기본값이 있거나 비워 둘 수 있어, 이 열을 모르는 코드가 행을 넣고 읽어도 그대로 돈다.
-- 표 이름 codex_sessions·codex_questions는 내부 호환을 위해 유지한다. 실행기 구분은 executor 열이 한다.

-- 이 열 전의 세션은 모두 Codex다. Claude 재개는 executor='claude' 행만 잇는다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS executor text NOT NULL DEFAULT 'codex' CHECK (executor IN ('codex','claude'));
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS claude_session_id text
  CHECK (claude_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
-- 같은 job의 retry마다 커진다. 작업자는 옛 세대의 늦은 요청을 이 값으로 거부한다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS generation integer CHECK (generation > 0);
-- 작업자에 보낸 마지막 실행 lease. 작업이 끝나면 jobs.lease_token이 비거나 바뀌어도 cancel·status·finalize는 이 값으로 그 실행을 가리킨다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS worker_lease text;
-- 세션을 가진 작업자. 파드가 바뀌면 instance가, 저장소가 바뀌면 storage가 달라진다. 첫 응답 전에는 모른다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS worker_instance text;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS worker_storage text;
-- 재개 때 요청과 대조하는 고정값. repository 열은 009에 있다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS base_sha text CHECK (base_sha ~ '^[a-f0-9]{40}$');
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS policy_revision text;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS project_revision text;
-- 턴별 기한과 job 전체 누적 실행 예산은 따로 센다. 재개로 시간 예산이 새로 채워지면 안 된다. 턴 수는 009의 turn이다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS turn_timeout_ms integer CHECK (turn_timeout_ms > 0);
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS run_budget_ms bigint CHECK (run_budget_ms > 0);
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS run_used_ms bigint NOT NULL DEFAULT 0 CHECK (run_used_ms >= 0);
-- 정리 상태. stopped가 NULL이면 프로세스 소멸을 확인하지 못했다. 구현 방식과 무관한 사실만 적는다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS stopped boolean;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS session_retained boolean NOT NULL DEFAULT false;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS cleanup_state text NOT NULL DEFAULT 'none' CHECK (cleanup_state IN ('none','pending','cleaned'));
-- 대기 시작 시각과 기한이 지나 owner 확인을 요청한 시각. 기한이 지나도 자동으로 재개하거나 버리지 않는다.
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS waiting_since bigint;
ALTER TABLE codex_sessions ADD COLUMN IF NOT EXISTS owner_confirm_requested_at bigint;
-- Codex 행은 Claude 세션 ID를 가질 수 없고, Claude 행은 재개 대조에 쓰는 값이 모두 있어야 한다.
ALTER TABLE codex_sessions DROP CONSTRAINT IF EXISTS codex_sessions_executor_identity_check;
ALTER TABLE codex_sessions ADD CONSTRAINT codex_sessions_executor_identity_check CHECK (
  (executor = 'codex' AND claude_session_id IS NULL)
  OR (executor = 'claude' AND claude_session_id IS NOT NULL AND generation IS NOT NULL AND worker_lease IS NOT NULL
    AND repository IS NOT NULL AND base_sha IS NOT NULL AND policy_revision IS NOT NULL
    AND project_id IS NOT NULL AND project_revision IS NOT NULL
    AND turn_timeout_ms IS NOT NULL AND run_budget_ms IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS codex_sessions_claude_session ON codex_sessions(claude_session_id) WHERE claude_session_id IS NOT NULL;
-- 레인에 보존 중인 세션 수를 세는 데 쓴다.
CREATE INDEX IF NOT EXISTS codex_sessions_retained ON codex_sessions(executor) WHERE session_retained;

-- job 종류에서 정해지는 실행 슬롯. 대화·리뷰가 interactive를 함께 쓰고, read는 모델을 부르지 않아 슬롯이 없다.
-- 생성 열이라 이 열을 모르는 코드가 넣는 행도 값이 맞다. 모르는 종류는 지금처럼 interactive 슬롯을 막는 쪽으로 둔다.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_lane text GENERATED ALWAYS AS (
  CASE WHEN type = 'read' THEN NULL WHEN type = 'task' THEN 'task' ELSE 'interactive' END
) STORED;
CREATE INDEX IF NOT EXISTS jobs_execution_lane_active ON jobs(execution_lane)
  WHERE state IN ('running','verifying','cancel_requested','unknown','waiting_user');

-- 레인마다 한 행. 게시 서버 인스턴스들이 이 행을 잠가 레인당 직렬 1을 지킨다. closed_reason이 있으면 그 레인의 새 접수를 닫는다.
-- 작업 레인 개방 여부는 설정 gate가 정하고 이 행은 실행 중 생긴 막힘만 적는다.
CREATE TABLE IF NOT EXISTS execution_lanes (
  lane text PRIMARY KEY CHECK (lane IN ('interactive','task')),
  closed_reason text CHECK (closed_reason IN ('unknown','cleanup_pending','retention_full')),
  closed_at bigint,
  CHECK ((closed_reason IS NULL) = (closed_at IS NULL))
);
INSERT INTO execution_lanes(lane) VALUES ('interactive'), ('task') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations VALUES (13) ON CONFLICT DO NOTHING;
COMMIT;
