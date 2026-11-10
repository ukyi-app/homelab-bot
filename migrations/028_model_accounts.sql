BEGIN;
-- 봇 모델 계정 기록(COLLEAGUE_SPEC §4.8 "계정 등록"·"계정 전환"·"계정 목록", §4.7 "토큰 만료 알림").
-- 값(토큰·키)은 두지 않는다. 값은 Infisical에만 있고 이 표는 owner가 CLI로 정한 이름·방식·발급 시각·지금 표시뿐이다.
-- 행은 관리 진입점(homelab bot account add·use)만 쓴다. 봇은 스스로 계정을 바꾸지 않는다(D-14 조건 5).
-- 한 계정이 구독과 API 크레딧 두 방식을 가질 수 있어 (이름, 방식)이 키다. api는 C23이 쓴다.
CREATE TABLE IF NOT EXISTS model_accounts (
  name text NOT NULL CHECK (name ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  method text NOT NULL CHECK (method IN ('subscription','api')),
  -- 구독 토큰을 CLI로 등록한 시각(ms). 만료는 발급 뒤 1년이다. CLI 밖에서 바꾼 토큰의 발급일은 모른다.
  issued_at bigint,
  registered_at bigint NOT NULL,
  current boolean NOT NULL DEFAULT false,
  -- 이 계정에서 다른 계정으로 바꿀 때 옮겨 둔 마지막 한도 관측(model_limit_state는 지금 계정 것만 든다).
  last_status text,
  last_rate_limit_type text,
  last_utilization double precision,
  last_resets_at bigint,
  last_observed_at bigint,
  PRIMARY KEY (name, method)
);
-- 봇이 쓰는 계정은 한 번에 하나다.
CREATE UNIQUE INDEX IF NOT EXISTS model_accounts_current ON model_accounts((true)) WHERE current;

INSERT INTO schema_migrations VALUES (28) ON CONFLICT DO NOTHING;
COMMIT;
