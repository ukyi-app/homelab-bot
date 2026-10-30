// 새 파드는 시작 직후 잠깐(실측 약 0.25초) 상대 NetworkPolicy의 허용 집합(파드 IP)에 없어 첫 접속이 거부된다
// (k3s 내장 kube-router, homelab 설계 B.8). Sync hook Job은 재시도해도 새 파드라 같은 창에 다시 걸리므로
// 프로세스 안에서 연결 단계 오류만 짧게 다시 시도한다. 인증·SQL 오류는 다시 해도 같아서 바로 던진다.
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

export function transientConnectError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code ?? ((error as { cause?: { code?: unknown } } | null)?.cause)?.code;
  return typeof code === 'string' && TRANSIENT.has(code);
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
