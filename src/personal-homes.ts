// 사람이 쓰는 모델 CLI 홈(개인 자격·세션·설정): ~/.codex*(.codex-sub 등)와 ~/.claude*(.claude.json 포함).
// 작업자는 이 아래를 읽거나 쓰지 않는다(D-14 조건 1). 홈을 열거하지 않고 홈 바로 아래 이름의 모양으로만 막는다.
export const PERSONAL_PREFIXES: readonly string[] = Object.freeze(['.codex', '.claude']);
export function isPersonalEntry(name: string): boolean {
  return PERSONAL_PREFIXES.some(prefix => name.startsWith(prefix));
}
