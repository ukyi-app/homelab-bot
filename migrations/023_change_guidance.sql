BEGIN;
-- 변경 PR의 확인할 것·남은 위험과 봇 PR 안내 댓글 전송 기록(COLLEAGUE_SPEC §4.10, AC-25·AC-27). 새 표 둘만 더해 옛 코드가 같은 DB를 써도 깨지지 않는다.
-- 시각은 저장소 시계의 ms다. 토큰·키·자격 열이 없다.

-- 작성 모델이 결과와 함께 낸 목록. generation마다 처음 받은 값 하나이고 고쳐 쓰지 않는다.
-- 승인 digest는 이 목록을 그린 PR 본문에 묶여 있다. 안내 댓글과 미리보기는 승인 본문에 그 줄이 그대로 있는지 다시 본다.
CREATE TABLE IF NOT EXISTS change_notes (
  change_id text NOT NULL,
  generation integer NOT NULL,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  risks jsonb NOT NULL CHECK (jsonb_typeof(risks) = 'array'),
  recorded_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation)
);
CREATE OR REPLACE FUNCTION change_notes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'change_notes_immutable' USING ERRCODE = 'CH001';
END $$;
DROP TRIGGER IF EXISTS change_notes_immutable ON change_notes;
CREATE TRIGGER change_notes_immutable BEFORE UPDATE ON change_notes FOR EACH ROW EXECUTE FUNCTION change_notes_immutable();

-- 차례(round)마다 한 행. 0은 처음 게시, 1부터는 수정 차례(C27)다. 행을 넣은 쪽만 보내고, 보냈는지 모르면 다시 보내지 않고 표식·head로 회수한다.
-- pending: 아직 안 보냄(retry_at 뒤에 보냄). sending: 보내는 중이거나 그러다 끊김. unknown: 보냈는지 모름.
-- posted·skipped·failed는 끝이다. 실패해도 PR과 변경 상태는 되돌리지 않는다.
CREATE TABLE IF NOT EXISTS change_guidance (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL CHECK (round BETWEEN 0 AND 999),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  state text NOT NULL CHECK (state IN ('pending','sending','unknown','posted','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at bigint,
  review_id bigint,
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, round),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation),
  CHECK ((state = 'posted') = (review_id IS NOT NULL))
);

INSERT INTO schema_migrations VALUES (23) ON CONFLICT DO NOTHING;
COMMIT;
