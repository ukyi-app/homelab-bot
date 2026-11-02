BEGIN;
-- 삭제 원장(SSD 파일)의 초기화 세대를 DB에 묶는다. 다른 디스크·재초기화한 빈 원장을 조용히 받으면
-- 지운 기억이 DB 복원으로 되살아나도 재적용할 항목이 없다. 행은 하나뿐이다.
CREATE TABLE IF NOT EXISTS deletion_ledger_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation text NOT NULL CHECK (generation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  bound_at bigint NOT NULL
);
INSERT INTO schema_migrations VALUES (12) ON CONFLICT DO NOTHING;
COMMIT;
