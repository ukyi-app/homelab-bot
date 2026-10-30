// 한 줄 JSON 로그. 값(토큰·URL·본문)은 넣지 않는다. 오류는 이름과 우리 코드 형식의 메시지·code만 남긴다.
export type Log = (event: string, detail?: Record<string, unknown>) => void;
export const jsonLog: Log = (event, detail) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);
};
export function errorInfo(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { error: typeof error };
  const info: Record<string, string> = { error: error.name };
  // 우리 오류 코드(예: discord_unauthorized, read_http_403)만 싣는다. 외부 라이브러리 메시지는 주소·값을 담을 수 있다.
  if (/^[a-z][a-z0-9_]{0,60}$/.test(error.message)) info.reason = error.message;
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) info.code = code;
  return info;
}
