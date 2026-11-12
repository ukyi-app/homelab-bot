BEGIN;
-- 한도 뒤 API 사용(COLLEAGUE_SPEC §4.11, DECISIONS "C40"). 추가만 한다: 옛 게시 서버 코드는 새 표들을 모르고 그대로 돈다.
-- 기존 표에는 기본값 있는 nullable 칸 하나(model_pauses.lane_only_at)만 더한다. 옛 코드는 칸 이름을 적어 넣고 읽어 이 칸을 건드리지 않는다.
-- 값(토큰·키·지문)은 두지 않는다. 계정 이름·묶음 revision·상태·시각뿐이다.

-- 지금 설치(owner의 관리 진입점 account auto가 가리키는 계정·묶음 revision). 행은 하나(id='current')다.
-- 게시 서버는 이 행이 active이고 계정이 지금 계정일 때만 실행마다 방식을 고른다. 없거나 off·refused면 지금 동작이다.
-- 두 방식의 상태는 이 행이 아니라 아래 계정별·계정 revision별 표에 있다. 다른 계정을 설치했다 돌아와도 그 계정의 잠금·예약이 남는다.
CREATE TABLE IF NOT EXISTS method_routing (
  id text PRIMARY KEY CHECK (id = 'current'),
  account text NOT NULL CHECK (account ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  revision text NOT NULL CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  installed_at bigint NOT NULL,
  -- refused: 작업자가 새 판 요청을 not_run으로 거부했다(묶음·자격이 설치 기록과 다름). owner가 다시 설치할 때까지 지금 동작이다.
  install_state text NOT NULL CHECK (install_state IN ('active', 'off', 'refused')),
  refused_reason text,
  -- 설치·상태 전이마다 1씩 는다. 실행은 고를 때의 값을 들고 있어, 그 사이 다른 실행이 이미 넘긴 한도를 다시 넘기지 않는다.
  epoch bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);

-- 계정별 구독 상태. 구독 한도는 계정의 것이라 같은 계정의 새 revision을 설치해도 남는다.
CREATE TABLE IF NOT EXISTS method_subscription (
  account text PRIMARY KEY CHECK (account ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  -- limited면 풀리는 시각(모르면 null)과 다음 확인 시각이 있다.
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'limited')),
  limited_at bigint,
  until bigint,
  next_probe_at bigint,
  -- 지금 구독 확인으로 도는 실행과 그 확인을 다른 실행이 대신할 수 있는 시각(확인 실행의 결과를 잃었을 때).
  probe_run text,
  probe_until bigint,
  updated_at bigint NOT NULL
);

-- 계정·묶음 revision별 API 상태. 막히면(API 잠금) owner의 해제나 새 묶음 revision 설치로만 그 설치의 API가 eligible이 된다.
-- 새 revision은 새 행이라 eligible로 시작하고, 잠긴 revision을 다시 설치하면 그 잠금이 그대로다.
CREATE TABLE IF NOT EXISTS method_api (
  account text NOT NULL CHECK (account ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  revision text NOT NULL CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  state text NOT NULL DEFAULT 'eligible' CHECK (state IN ('eligible', 'billing_blocked', 'auth_blocked')),
  blocked_at bigint,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account, revision)
);

-- 실행마다 고정한 방식(요청의 서명된 선택 칸과 같은 값). 결과는 이 행의 계정·revision·방식으로 귀속한다.
-- jobs의 외래 키를 걸지 않는다: 작업 정리가 행을 지워도 API 실행 누계와 전환 근거는 남아야 한다.
CREATE TABLE IF NOT EXISTS method_runs (
  run_id text PRIMARY KEY,
  job_id text NOT NULL,
  -- 그 실행의 job lease. 저장 결과 회수(변경 자체 리뷰·변경 작성)가 lease로 실제로 시작한 실행의 선택을 찾는다.
  lease text,
  path text NOT NULL CHECK (path IN ('chat', 'review', 'change_review', 'task')),
  account text NOT NULL,
  revision text NOT NULL,
  method text NOT NULL CHECK (method IN ('subscription', 'api')),
  epoch bigint NOT NULL,
  -- 구독 한도 동안 구독으로 고른 실행(구독 확인).
  probe boolean NOT NULL DEFAULT false,
  selected_at bigint NOT NULL,
  -- 고른 선택이 작업자로 나가도 된다고 확정한 시각. API 잠금·구독 한도 전이와 같은 잠금 아래에서 다시 확인하고 적는다.
  -- null이면 보내지 않은 실행이다(고른 뒤 막혔거나 다른 게시 서버가 그 턴을 먼저 시작했다). 실행 수는 이 칸이 있는 행만 센다.
  started_at bigint,
  -- 작업자 결과(succeeded·limited·auth_expired·failed·not_run). 보내지 않고 버린 선택은 unstarted다. 결과를 받지 못했으면 null이다.
  outcome text,
  -- 구독 실행이 넘어갈 근거가 되는 한도 실패로 끝났는지(작업자 응답의 subscriptionLimit).
  subscription_limit boolean,
  settled_at bigint
);
CREATE INDEX IF NOT EXISTS method_runs_job ON method_runs(job_id);
CREATE INDEX IF NOT EXISTS method_runs_selected ON method_runs(selected_at);

-- 작업 레인만 막는 모델 대기(작업 경로 칸이 꺼진 배치의 작업 턴 구독 한도)였다면 그 멈춤의 paused_at과 같은 값이다.
-- 전역 scheduler 해제는 이 대기를 기다리지 않는다. 옛 코드가 같은 작업의 멈춤을 다시 쓰면 paused_at만 바뀌어 전역 대기로 읽힌다.
ALTER TABLE model_pauses ADD COLUMN IF NOT EXISTS lane_only_at bigint DEFAULT NULL;

INSERT INTO schema_migrations VALUES (29) ON CONFLICT DO NOTHING;
COMMIT;
