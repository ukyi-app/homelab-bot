BEGIN;
-- 한도 뒤 API 사용(COLLEAGUE_SPEC §4.11, DECISIONS "C40"). 추가만 한다: 옛 게시 서버 코드는 이 표들을 모르고 그대로 돈다.
-- 값(토큰·키·지문)은 두지 않는다. 계정 이름·묶음 revision·상태·시각뿐이다.

-- 자동 사용 설치와 두 방식의 상태. 행은 하나(id='current')이고 owner의 관리 진입점(account auto)이 만든다.
-- 게시 서버는 이 행이 active이고 계정이 지금 계정일 때만 실행마다 방식을 고른다. 없거나 off·refused면 지금 동작이다.
CREATE TABLE IF NOT EXISTS method_routing (
  id text PRIMARY KEY CHECK (id = 'current'),
  account text NOT NULL CHECK (account ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  revision text NOT NULL CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  installed_at bigint NOT NULL,
  -- refused: 작업자가 새 판 요청을 not_run으로 거부했다(묶음·자격이 설치 기록과 다름). owner가 다시 설치할 때까지 지금 동작이다.
  install_state text NOT NULL CHECK (install_state IN ('active', 'off', 'refused')),
  refused_reason text,
  -- 구독 상태. limited면 풀리는 시각(모르면 null)과 다음 확인 시각이 있다.
  subscription_state text NOT NULL DEFAULT 'available' CHECK (subscription_state IN ('available', 'limited')),
  subscription_limited_at bigint,
  subscription_until bigint,
  subscription_next_probe_at bigint,
  -- 지금 구독 확인으로 도는 실행과 그 확인을 다른 실행이 대신할 수 있는 시각(확인 실행의 결과를 잃었을 때).
  probe_run text,
  probe_until bigint,
  -- API 상태. 막히면(API 잠금) owner의 해제나 새 묶음 revision 설치로만 eligible이 된다.
  api_state text NOT NULL DEFAULT 'eligible' CHECK (api_state IN ('eligible', 'billing_blocked', 'auth_blocked')),
  api_blocked_at bigint,
  api_blocked_revision text,
  -- 상태 전이마다 1씩 는다. 실행은 고를 때의 값을 들고 있어, 그 사이 다른 실행이 이미 넘긴 한도를 다시 넘기지 않는다.
  epoch bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);

-- 실행마다 고정한 방식(요청의 서명된 선택 칸과 같은 값). 결과는 이 행의 계정·revision·방식으로 귀속한다.
-- jobs의 외래 키를 걸지 않는다: 작업 정리가 행을 지워도 API 실행 누계와 전환 근거는 남아야 한다.
CREATE TABLE IF NOT EXISTS method_runs (
  run_id text PRIMARY KEY,
  job_id text NOT NULL,
  -- 그 실행의 job lease. 저장 결과 회수(변경 자체 리뷰)가 lease로 이 선택을 찾아 v2 결과를 읽는다.
  lease text,
  path text NOT NULL CHECK (path IN ('chat', 'review', 'change_review', 'task')),
  account text NOT NULL,
  revision text NOT NULL,
  method text NOT NULL CHECK (method IN ('subscription', 'api')),
  epoch bigint NOT NULL,
  -- 구독 한도 동안 구독으로 고른 실행(구독 확인).
  probe boolean NOT NULL DEFAULT false,
  selected_at bigint NOT NULL,
  -- 작업자 결과(succeeded·limited·auth_expired·failed·not_run). 결과를 받지 못했으면 null이다.
  outcome text,
  -- 구독 실행이 넘어갈 근거가 되는 한도 실패로 끝났는지(작업자 응답의 subscriptionLimit).
  subscription_limit boolean,
  settled_at bigint
);
CREATE INDEX IF NOT EXISTS method_runs_job ON method_runs(job_id);
CREATE INDEX IF NOT EXISTS method_runs_selected ON method_runs(selected_at);

INSERT INTO schema_migrations VALUES (29) ON CONFLICT DO NOTHING;
COMMIT;
