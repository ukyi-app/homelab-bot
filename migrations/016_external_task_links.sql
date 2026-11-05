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
  -- 이 이벤트를 수락한 키. 재발급 뒤 재시도되는 옛 키의 이벤트를 게시 직전에 가려낸다.
  accepted_key_id text NOT NULL CHECK (accepted_key_id ~ '^[A-Za-z0-9_-]{16}$'),
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

-- 게시 행을 잡는 순간의 재확인. 폐기·재발급은 발송을 시작한 행을 건드리지 못하는데, 그 발송이 429·401로 실패하면 행이 pending으로 돌아온다.
-- 돌아오는 경로가 여럿이고 게시자는 R08을 모르므로, 발송 전에 반드시 지나는 pending→sending 전이에서 막는다.
-- 그 뒤의 폐기는 발송 시작 전 sending을 blocked로 바꾸고 dispatch 표시가 실패한다.
-- blocked나 pending을 돌려주면 claim의 RETURNING 행도 그 상태라 게시자의 dispatch 표시(state='sending' 요구)가 실패해 나가지 않는다.
-- 만료는 막지 않는다. 만료 전에 정상으로 받은 이벤트이기 때문이다. restoreEpoch는 프로세스 설정이라 여기서 볼 수 없다.
CREATE OR REPLACE FUNCTION external_task_outbox_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  accepted record;
  link record;
BEGIN
  SELECT connection_id,accepted_key_id INTO accepted FROM external_task_events WHERE outbox_key = NEW.message_key;
  IF NOT FOUND THEN
    NEW.state := 'blocked';
    RETURN NEW;
  END IF;
  -- 폐기·재발급·동의 변경은 연결 행을 FOR UPDATE로 잠근 뒤 outbox 행을 기다린다. 여기는 outbox 행을 쥔 채라 잠금을 기다리면 교착이다.
  -- 그 트랜잭션의 결과를 아직 알 수 없으므로 보내지 않고 lease 길이만큼 미룬다. 수락은 FOR NO KEY UPDATE라 이 잠금과 부딪히지 않는다.
  SELECT key_id,revoked_reason INTO link FROM external_task_connections WHERE id = accepted.connection_id FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN
    NEW.state := OLD.state;
    NEW.attempt := OLD.attempt;
    NEW.available_at := NEW.lease_until;
    RETURN NEW;
  END IF;
  IF link.revoked_reason <> 'expired' OR link.key_id <> accepted.accepted_key_id
    OR (SELECT split_part(token,';',1) FROM external_task_link_fence)
      IS DISTINCT FROM 'timeline:' || substr(pg_walfile_name(pg_current_wal_lsn()),1,8) THEN
    NEW.state := 'blocked';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS outbox_external_task_claim ON outbox;
CREATE TRIGGER outbox_external_task_claim BEFORE UPDATE OF state ON outbox FOR EACH ROW
  WHEN (OLD.state = 'pending' AND NEW.state = 'sending' AND NEW.message_key LIKE 'external-task:%')
  EXECUTE FUNCTION external_task_outbox_claim();
INSERT INTO schema_migrations VALUES (16) ON CONFLICT DO NOTHING;
COMMIT;
