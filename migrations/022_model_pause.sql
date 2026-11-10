BEGIN;
-- 모델 멈춤 기록(COLLEAGUE_SPEC §4.7, AC-16·17). 표를 더하기만 해 옛 코드가 같은 DB를 써도 깨지지 않는다.
-- 시각은 모두 저장소 시계의 ms다. 작업자가 주는 resetsAt(unix 초)도 ms로 바꿔 둔다.

-- 한도·인증·결제로 waiting_user가 된 작업마다 한 행. 재개 예약 루프와 운영 지표(C21)가 읽는다.
-- jobs.wait_reason은 그대로 model_limit·auth_expired다. 결제는 wait_reason이 model_limit이고 여기 kind로만 가른다.
-- 행은 그 작업이 다음에 대기에 들어갈 때 덮어쓴다. 작업이 대기에서 나간 뒤 남은 행은 jobs 상태로 걸러 읽는다.
CREATE TABLE IF NOT EXISTS model_pauses (
  job_id text PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('rate_limit','auth_expired','billing')),
  resets_at bigint,
  rate_limit_type text,
  utilization double precision,
  -- NULL이면 저절로 재개하지 않는다(결제).
  retry_at bigint,
  paused_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS model_pauses_due ON model_pauses(retry_at) WHERE retry_at IS NOT NULL;

-- 계정 하나의 마지막 한도 관측과 리뷰 미루기 기한. 봇이 쓰는 계정은 한 번에 하나라 행도 하나다.
CREATE TABLE IF NOT EXISTS model_limit_state (
  id text PRIMARY KEY CHECK (id = 'account'),
  status text,
  rate_limit_type text,
  utilization double precision,
  resets_at bigint,
  observed_at bigint,
  review_deferred_until bigint
);

INSERT INTO schema_migrations VALUES (22) ON CONFLICT DO NOTHING;
COMMIT;
