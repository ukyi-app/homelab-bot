// 새 파드는 시작 직후 잠깐(실측 약 0.25초) 상대 NetworkPolicy의 허용 집합(파드 IP)에 없어 첫 접속이 거부된다
// (k3s 내장 kube-router, homelab 설계 B.8). Sync hook Job은 재시도해도 새 파드라 같은 창에 다시 걸리므로
// 프로세스 안에서 연결 단계 오류만 짧게 다시 시도한다. 인증·SQL 오류는 다시 해도 같아서 바로 던진다.
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

// node-pg는 연결 시간 초과·연결 중 끊김을 코드 없이 이 문구로 낸다(pg 8.23 client.js, pg-pool index.js).
// 운영에서 새 파드가 연결은 열었는데 인증 전에 멈춰 5초 연결 시간 초과로 끝난 적이 있다(서버 로그 57014).
// SQLSTATE 코드가 붙은 오류(인증 28P01 등)는 문구와 상관없이 다시 하지 않는다.
const TRANSIENT_MESSAGES = [/^Connection terminated due to connection timeout$/, /^timeout expired$/, /^Connection terminated unexpectedly$/];

export function transientConnectError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  const code = e.code ?? (e.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return TRANSIENT.has(code);
  if (typeof e.message === 'string' && TRANSIENT_MESSAGES.some(re => re.test(e.message as string))) return true;
  return e.cause !== undefined && transientConnectError(e.cause);
}

export interface RetryOptions {
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

// 0.25초부터 두 배씩(상한 4초) 기다리며 deadline(기본 30초) 안에서만 다시 한다. 마지막 오류를 그대로 던진다.
export async function withConnectRetry<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const end = now() + (options.deadlineMs ?? 30_000);
  for (let attempt = 1; ; attempt++) {
    try { return await op(); } catch (error) {
      const wait = Math.min(4_000, 250 * 2 ** (attempt - 1));
      if (!transientConnectError(error) || now() + wait > end) throw error;
      options.onRetry?.(attempt, error);
      await sleep(wait);
    }
  }
}
