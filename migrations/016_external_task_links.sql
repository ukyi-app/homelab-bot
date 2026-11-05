BEGIN;
-- R08 읽기 전용 알림의 저장 계층이다. 사람이 자기 기기에서 돌리는 세션은 봇이 실행한 작업이 아니므로 jobs·codex_sessions에 넣지 않는다.
-- 개인 seed는 어떤 열에도 두지 않는다. 서버는 public key로 검증만 하므로 이 표가 유출돼도 발신 서명을 만들 수 없다.
CREATE TABLE IF NOT EXISTS external_task_connections (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  owner_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id),
  -- 게시 목적지는 이 값으로만 정한다. 클라이언트가 보낸 owner·채널은 읽지 않는다.
  scope jsonb NOT NULL,
  -- 사람이 등록한 불투명 세션 ID. 경로 구분자를 허용하지 않아 경로를 ID로 넣을 수 없다.
  external_task_id text NOT NULL CHECK (external_task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  executor text NOT NULL CHECK (executor IN ('claude','codex')),
  -- Ed25519 raw public key(32바이트)의 base64url.
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{16}$'),
  summary_consent boolean NOT NULL DEFAULT false,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  revoked_reason text CHECK (revoked_reason IN ('detach','lost_device','delivery_failed','expired','restore_fence')),
  created_at bigint NOT NULL,
  rotated_at bigint,
  last_event_at bigint,
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- 같은 세션을 같은 대화에 두 번 연결하지 못한다. 재발급은 새 행이 아니라 이 행의 키를 바꾼다.
CREATE UNIQUE INDEX IF NOT EXISTS external_task_connections_active
  ON external_task_connections(owner_id,conversation_id,executor,external_task_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS external_task_events (
  connection_id text NOT NULL REFERENCES external_task_connections(id) ON DELETE CASCADE,
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  -- raw body의 SHA-256. 요약 원문은 여기 두지 않는다(동의한 요약은 게시용 outbox 행에만 있다).
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at bigint NOT NULL,
  received_at bigint NOT NULL,
  outbox_key text NOT NULL UNIQUE,
  post_state text NOT NULL DEFAULT 'pending' CHECK (post_state IN ('pending','posted','blocked')),
  PRIMARY KEY (connection_id,event_id)
);
-- 역압 판단이 요청마다 세는 대상이라 미게시 행만 색인한다.
CREATE INDEX IF NOT EXISTS external_task_events_unposted ON external_task_events(connection_id) WHERE post_state='pending';
CREATE INDEX IF NOT EXISTS external_task_events_settled ON external_task_events(received_at) WHERE post_state<>'pending';

-- 게시 상태의 원천은 outbox.state다. 게시자는 R08을 모르고 outbox만 바꾸므로 같은 트랜잭션의 트리거로 따라가게 한다.
-- unknown은 보냈는지 모르는 상태라 아직 미게시로 센다.
CREATE OR REPLACE FUNCTION external_task_event_post_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE external_task_events
    SET post_state = CASE NEW.state WHEN 'sent' THEN 'posted' WHEN 'blocked' THEN 'blocked' ELSE 'pending' END
    WHERE outbox_key = NEW.idempotency_key;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS outbox_external_task_post_state ON outbox;
CREATE TRIGGER outbox_external_task_post_state AFTER UPDATE OF state ON outbox FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.idempotency_key LIKE 'external-task:%')
  EXECUTE FUNCTION external_task_event_post_state();

-- 복원 감지용 한 행. 백업에 함께 들어가므로 복원하면 옛 값이 돌아오고, 지금 값과 달라져 연결을 모두 닫는 근거가 된다.
CREATE TABLE IF NOT EXISTS external_task_link_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token text,
  fenced_at bigint
);
INSERT INTO external_task_link_fence(singleton) VALUES (true) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations VALUES (16) ON CONFLICT DO NOTHING;
COMMIT;
