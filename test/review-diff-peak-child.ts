import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getHeapStatistics } from 'node:v8';
import { REVIEW_INSTRUCTIONS, ReviewWorker, unifiedDiff } from '../src/review-input.js';
import type { ReviewTask } from '../src/review-input.js';
import { archiveContract } from '../src/worker.js';
import type { WorkerVerifier } from '../src/worker.js';

// 메모리 피크는 프로세스 전체의 최고 RSS로 잰다. 시험 프로세스의 다른 시험·입력 생성이 섞이지 않게 따로 띄운다.
const FILES = 99, FILE_BYTES = 2_000_000, MAX_ARCHIVE = 200_000_000;
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const pathOf = (i: number) => `src/file-${i}.txt`;
const LIMITS = { maxFiles: 1000, maxFileBytes: FILE_BYTES, maxDiffBytes: 4_000_000, maxArchiveBytes: MAX_ARCHIVE, maxBodyChars: 65_536 };
function randomLines(bytes: number): Buffer {
  // 줄이 짧고 모두 달라야 줄 배열·정수 표·trace가 함께 최대가 된다. base64는 거의 압축되지 않는다.
  const text = randomBytes(bytes).toString('base64').slice(0, bytes);
  const out = Buffer.from(text);
  for (let i = 8; i < out.length; i += 9) out[i] = 10;
  out[out.length - 1] = 10;
  return out;
}
function tarGz(block: Buffer): Buffer {
  const parts: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write(type, 156);
    h.write('ustar\0', 257); h.write('00', 263);
    return h;
  };
  parts.push(header('root/', 0, '5'));
  const padding = Buffer.alloc((512 - (block.length % 512)) % 512);
  for (let i = 0; i < FILES; i++) parts.push(header(`root/${pathOf(i)}`, block.length, '0'), block, padding);
  parts.push(Buffer.alloc(1024));
  // 저장만 한다(level 0). 압축본도 해제본과 같은 크기라 스키마 상한에서 가장 큰 입력이다.
  return gzipSync(Buffer.concat(parts), { level: 0 });
}
function report(extra: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ maxRssMiB: process.resourceUsage().maxRSS / 1024,
    heapLimitMiB: getHeapStatistics().heap_size_limit / 1048576, ...extra })}\n`);
}

const [mode, dir] = process.argv.slice(2);
if (mode === 'fixture') {
  await mkdir(dir!, { recursive: true });
  await writeFile(join(dir!, 'base.tgz'), tarGz(randomLines(FILE_BYTES)));
  await writeFile(join(dir!, 'head.tgz'), tarGz(randomLines(FILE_BYTES)));
  report({});
} else if (mode === 'worker') {
  const contract = archiveContract('fixture-org/fixture-repo', BASE, HEAD);
  const verifier = { check: async () => {} } as unknown as WorkerVerifier;
  let inputBytes = 0;
  const worker = new ReviewWorker(verifier, async url => readFile(join(dir!, url === contract.base ? 'base.tgz' : 'head.tgz')),
    async input => {
      inputBytes = input.untrusted.files.reduce((sum, file) => sum + file.patch.length, 0);
      return { status: 'succeeded', output: {} };
    });
  const task: ReviewTask = { version: 1, job: randomUUID(), lease: randomUUID(), lane: 'review', repository: 'fixture-org/fixture-repo',
    base: BASE, head: HEAD, archives: { base: contract.base, head: contract.head },
    changes: Array.from({ length: FILES }, (_, i) => ({ path: pathOf(i), previousPath: null, status: 'modified' as const, baseType: 'blob' as const, headType: 'blob' as const })),
    truncated: false, pullRequest: { title: 'peak', body: '' }, limits: LIMITS, policyRevision: 'rp-peak', instructions: REVIEW_INSTRUCTIONS, timeoutMs: 60_000 };
  const started = Date.now();
  const result = await worker.review(task, 'fixture-capability', new AbortController().signal);
  if (result.status !== 'succeeded') throw new Error(`unexpected_${result.status}`);
  report({ ms: Date.now() - started, inputBytes, checked: result.coverage.checked_files.length,
    omitted: result.coverage.omitted_files_with_reasons.map(o => o.reason).filter((r, i, all) => all.indexOf(r) === i),
    omittedCount: result.coverage.omitted_files_with_reasons.length });
} else if (mode === 'distance') {
  // 편집 거리 상한까지 trace를 끝까지 채우는 입력. 모든 줄이 달라 공통 앞뒤도 없다.
  const before = Array.from({ length: 5000 }, (_, i) => `base-${i}`).join('\n'), after = Array.from({ length: 5000 }, (_, i) => `head-${i}`).join('\n');
  const started = Date.now();
  const diff = unifiedDiff('f', before, after);
  report({ ms: Date.now() - started, complex: diff === null });
} else if (mode === 'repetitive') {
  // 파일 상한(2MB) 안에서 대각선마다 긴 일치 구간을 따라가며 편집 거리 상한까지 가는 입력. 계산량이 가장 많이 나온 모양이다.
  const block = Array.from({ length: 450 }, () => 'x');
  const before: string[] = [], after: string[] = [];
  for (let i = 0; i < 2200; i++) {
    before.push(...block, `a-${i}`);
    after.push(`b-${i}`, ...block);
  }
  const left = before.join('\n'), right = after.join('\n');
  const started = Date.now();
  const diff = unifiedDiff('f', left, right);
  report({ ms: Date.now() - started, complex: diff === null, bytes: Math.max(left.length, right.length) });
} else throw new Error('unknown_mode');
