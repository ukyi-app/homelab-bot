// 받은 nonce의 메모리 기록. 프로세스가 다시 뜨면 비므로, 다시 뜬 받는 쪽은 NONCE_RETENTION_MS가 지나기 전에 받은 봉투를
// 다시 받을 수 있다: 오래 남는 받는 쪽은 기록을 지속 저장하거나 다시 뜬 뒤 그만큼 기다려야 한다(이 모듈 밖).
import { NONCE_RETENTION_MS } from './olive-control-limits.js';
import type { Party } from './olive-control-table.js';

export class NonceBook {
  readonly #seen = new Map<string, number>();

  constructor(private readonly clock: () => number) {}

  consume(sender: Party, nonce: string, _expiresAt: number): boolean {
    this.prune();
    const key = `${sender} ${nonce}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, this.clock());
    return true;
  }

  // 기록한 지 NONCE_RETENTION_MS가 지난 nonce를 지운다. 그 봉투는 이미 만료돼 다시 와도 시한에서 거절된다.
  prune(): void {
    const now = this.clock();
    for (const [key, seenAt] of this.#seen) if (now - seenAt >= NONCE_RETENTION_MS) this.#seen.delete(key);
  }

  get size(): number {
    return this.#seen.size;
  }
}
