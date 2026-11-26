BEGIN;
-- 새 변경 브랜치 이름은 bot/change/c<24 hex>(무작위 공개 추적 ID)다. change ID·세대가 이름에 없어 공개 브랜치·PR 글에서 change ID를 되찾을 수 없고,
-- 이름과 내부 키의 대응은 이 행(change_generations.branch, UNIQUE)에만 있다.
-- 옛 꼴 bot/change/<change ID>/g<세대>는 이미 있는 행과 그 브랜치를 찾고 읽으려고 계속 받는다. 새 행을 옛 꼴로 만들지 않는 것은
-- 코드가 지킨다(이 꼴을 만드는 함수가 없고, 정적 시험이 본다). 기존 행을 고치지 않는다. 새 CHECK는 옛 CHECK보다 넓어 기존 행이 모두 지난다.
ALTER TABLE change_generations DROP CONSTRAINT IF EXISTS change_generations_branch_shape;
ALTER TABLE change_generations ADD CONSTRAINT change_generations_branch_shape CHECK (
  branch = 'bot/change/' || change_id || '/g' || generation
  OR branch ~ '^bot/change/c[0-9a-f]{24}$'
);

INSERT INTO schema_migrations VALUES (30) ON CONFLICT DO NOTHING;
COMMIT;
