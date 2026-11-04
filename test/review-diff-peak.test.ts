import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildReviewFiles, readArchive, unifiedDiff } from '../src/review-input.js';
import type { Change, InputLimits } from '../src/review-input.js';

const CHILD = fileURLToPath(new URL('./review-diff-peak-child.js', import.meta.url));
const MIB = 1024 * 1024, WORKER_LIMIT_MIB = 1024;
function child(args: string[], heapMiB: number, timeoutMs: number) {
  const run = spawnSync(process.execPath, [`--max-old-space-size=${heapMiB}`, CHILD, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MIB });
  // 힙 한도를 넘으면 V8이 프로세스를 죽여 status가 0이 아니다. 시간 초과는 signal로 드러난다.
  assert.equal(run.status, 0, `child ${args[0]} status=${run.status} signal=${run.signal}\n${run.stderr.slice(-2000)}`);
  return JSON.parse(run.stdout) as { maxRssMiB: number; ms: number; complex?: boolean; bytes?: number; checked?: number; inputBytes?: number; omitted?: string[]; omittedCount?: number };
}
const entry = (text: string) => ({ kind: 'file' as const, data: Buffer.from(text), mode: 0o644 });
const change = (path: string): Change => ({ path, previousPath: null, status: 'modified', baseType: 'blob', headType: 'blob' });
const LIMITS: InputLimits = { maxFiles: 20, maxFileBytes: 2_000_000, maxDiffBytes: 1000, maxArchiveBytes: 1_000_000, maxBodyChars: 100 };

test('T17 이월 4 최악 편집 거리: trace를 끝까지 채워도 힙 64MiB 안에서 diff_too_complex로 끝난다', () => {
  const result = child(['distance'], 64, 60_000);
  assert.equal(result.complex, true);
  assert.ok(result.maxRssMiB < 256, `maxRSS ${result.maxRssMiB}MiB`);
});
test('T17 이월 4 파일 상한의 반복 내용: 대각선마다 일치 구간이 길어도 동기 계산이 짧다', () => {
  const result = child(['repetitive'], 256, 30_000);
  assert.equal(result.complex, true);
  assert.ok(result.bytes! <= 2_000_000, `input ${result.bytes}`);
  assert.ok(result.ms < 3_000, `${result.ms}ms`);
});
test('T17 이월 4 스키마 상한 입력(압축본 200MB 두 개, 2MB 파일 99개 전부 변경)의 전체 경로 피크가 작업자 한도 1Gi 아래다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-diff-peak-'));
  try {
    child(['fixture', dir], 1024, 120_000);
    // 1Gi cgroup의 기본 힙 한도는 560MiB다(systemd-run MemoryMax=1G로 측정). 그보다 좁게 잡아 힙에 기대지 않는지 본다.
    const result = child(['worker', dir], 256, 300_000);
    assert.ok(result.maxRssMiB < WORKER_LIMIT_MIB * 0.9, `maxRSS ${result.maxRssMiB}MiB`);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.omitted, ['diff_too_complex']);
    assert.equal(result.omittedCount, 99);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('T17 이월 4 크기 차이만으로 maxDiffBytes를 넘는 파일은 diff를 계산하지 않고 diff_limit이다', async () => {
  // 모든 줄이 달라 계산했다면 diff_too_complex가 됐을 입력이다.
  const before = Array.from({ length: 5000 }, (_, i) => `base-${i}`).join('\n') + '\n';
  const after = before.replaceAll('base', 'head-and-longer');
  const built = await buildReviewFiles([change('big.txt')], false, new Map([['big.txt', entry(before)]]), new Map([['big.txt', entry(after)]]), LIMITS);
  assert.deepEqual(built.coverage.omitted_files_with_reasons, [{ path: 'big.txt', reason: 'diff_limit' }]);
  assert.deepEqual(built.coverage.limits_hit, ['diff_limit']);
});
test('T17 이월 4 크기 차이가 작아도 만드는 중 maxDiffBytes를 넘으면 멈추고, 남은 예산으로 다음 파일을 본다', async () => {
  const before = Array.from({ length: 300 }, (_, i) => `base-${String(i).padStart(4, '0')}`).join('\n') + '\n';
  const after = before.replaceAll('base', 'head');
  const built = await buildReviewFiles([change('a-big.txt'), change('b-small.txt')], false,
    new Map([['a-big.txt', entry(before)], ['b-small.txt', entry('x\n')]]), new Map([['a-big.txt', entry(after)], ['b-small.txt', entry('y\n')]]), LIMITS);
  assert.deepEqual(built.coverage.omitted_files_with_reasons, [{ path: 'a-big.txt', reason: 'diff_limit' }]);
  assert.deepEqual(built.coverage.checked_files, ['b-small.txt']);
  assert.ok(Buffer.byteLength(built.files[0]!.patch) <= LIMITS.maxDiffBytes);
});
test('T17 이월 4 계산량 상한: 편집 거리 상한 안이라도 넘으면 끊고, 작업 전체 상한을 다 쓰면 남은 파일은 작아도 계산하지 않는다', async () => {
  const block = Array.from({ length: 50 }, () => 'x');
  const before: string[] = [], after: string[] = [];
  for (let i = 0; i < 100; i++) { before.push(...block, `a-${i}`); after.push(`b-${i}`, ...block); }
  const left = `${before.join('\n')}\n`, right = `${after.join('\n')}\n`;
  // 편집 200개라 거리 상한 안이고 상한이 넉넉하면 답이 나온다. 상한이 그 계산량보다 작으면 끊긴다.
  assert.ok(unifiedDiff('f', left, right));
  assert.equal(unifiedDiff('f', left, right, 3, 20_000), null);
  const limits = { ...LIMITS, maxDiffBytes: 4_000_000 };
  const base = new Map([['a.txt', entry(left)], ['z-small.txt', entry('x\n')]]), head = new Map([['a.txt', entry(right)], ['z-small.txt', entry('y\n')]]);
  const built = await buildReviewFiles([change('a.txt'), change('z-small.txt')], false, base, head, limits, 0, undefined, 20_000);
  assert.deepEqual(built.coverage.checked_files, []);
  assert.deepEqual(built.coverage.omitted_files_with_reasons.map(o => o.reason), ['diff_too_complex', 'diff_too_complex']);
  const enough = await buildReviewFiles([change('a.txt'), change('z-small.txt')], false, base, head, limits);
  assert.deepEqual(enough.coverage.checked_files, ['a.txt', 'z-small.txt']);
});
test('T17 이월 4 파일 사이에서 취소를 보고 모델을 부르기 전에 멈춘다', async () => {
  const abort = new AbortController();
  const pending = buildReviewFiles([change('a.txt')], false, new Map([['a.txt', entry('x\n')]]), new Map([['a.txt', entry('y\n')]]), LIMITS, 0, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
test('T17 이월 4 diff 결과: 공통 앞뒤를 먼저 잘라도 편집 거리 상한 안의 hunk와 줄 번호가 정확하다', () => {
  const base = Array.from({ length: 40 }, (_, i) => `l${i}`);
  const head = [...base.slice(0, 10), 'new-a', 'new-b', ...base.slice(12, 30), ...base.slice(31)];
  const diff = unifiedDiff('f', `${base.join('\n')}\n`, `${head.join('\n')}\n`)!;
  assert.equal(diff.patch, ['--- a/f', '+++ b/f',
    '@@ -8,8 +8,8 @@', ' l7', ' l8', ' l9', '-l10', '-l11', '+new-a', '+new-b', ' l12', ' l13', ' l14',
    '@@ -28,7 +28,6 @@', ' l27', ' l28', ' l29', '-l30', ' l31', ' l32', ' l33', ''].join('\n'));
  assert.deepEqual(diff.rightLines, [8, 9, 10, 11, 12, 13, 14, 15, 28, 29, 30, 31, 32, 33]);
  assert.equal(unifiedDiff('f', 'same\n', 'same\n')!.patch, '--- a/f\n+++ b/f\n');
  assert.equal(unifiedDiff('f', '', 'a\n')!.patch, '--- a/f\n+++ b/f\n@@ -0,0 +1,1 @@\n+a\n');
  assert.equal(unifiedDiff('f', 'a\n', '')!.patch, '--- a/f\n+++ b/f\n@@ -1,1 +0,0 @@\n-a\n');
  // 줄 번호는 앞쪽 hunk 뒤에도 양쪽 내용과 맞아야 한다. 모든 RIGHT 줄은 head에 실제로 있는 줄이다.
  for (const line of diff.rightLines) assert.ok(line >= 1 && line <= head.length);
});
test('T17 이월 4 diff 결과: 무작위 입력에서 patch를 적용하면 head가 되고 편집 수가 최소다', () => {
  // 시드 고정 난수. 짧은 알파벳이라 일치·반복이 많아 경로 선택 경계를 고루 지난다.
  let seed = 20261104;
  const next = (bound: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % bound; };
  const words = (length: number) => Array.from({ length }, () => 'abcd'[next(4)]!);
  const lcs = (a: string[], b: string[]) => {
    let row = new Array<number>(b.length + 1).fill(0);
    for (const x of a) {
      const nextRow = [0];
      for (let j = 0; j < b.length; j++) nextRow.push(x === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, nextRow[j]!));
      row = nextRow;
    }
    return row[b.length]!;
  };
  for (let round = 0; round < 300; round++) {
    const before = words(next(40)), after = words(next(40));
    const left = before.map(w => `${w}\n`).join(''), right = after.map(w => `${w}\n`).join('');
    const diff = unifiedDiff('f', left, right, 2)!;
    const removed = diff.patch.split('\n').slice(2).filter(l => l.startsWith('-')).length;
    const added = diff.patch.split('\n').slice(2).filter(l => l.startsWith('+')).length;
    assert.equal(removed + added, before.length + after.length - 2 * lcs(before, after), `round ${round}`);
    const result: string[] = [];
    let cursor = 0;
    const body = diff.patch.split('\n').slice(2, -1);
    for (const line of body) {
      const hunk = /^@@ -(\d+),(\d+) /.exec(line);
      if (hunk) {
        const start = Number(hunk[2]) === 0 ? Number(hunk[1]) : Number(hunk[1]) - 1;
        result.push(...before.slice(cursor, start)); cursor = start;
      } else if (line[0] === ' ') { assert.equal(line.slice(1), before[cursor]); result.push(line.slice(1)); cursor++; }
      else if (line[0] === '-') { assert.equal(line.slice(1), before[cursor]); cursor++; }
      else result.push(line.slice(1));
    }
    result.push(...before.slice(cursor));
    assert.deepEqual(result, after, `round ${round}`);
  }
});
test('T17 이월 4 압축본 항목은 해제본을 복사하지 않는다', () => {
  // 항목이 해제본의 subarray면 ArrayBuffer를 함께 쓴다. 파일별 복사는 피크를 두 배로 만든다.
  // 내용은 Buffer 풀(이 런타임에서 64KB)보다 커야 한다. 작으면 복사본끼리도 풀을 공유해 이 비교가 가리지 못한다.
  const content = Buffer.alloc(131_072, 'a');
  const header = (name: string, size: number) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('0', 156); h.write('ustar\0', 257);
    return h;
  };
  const tar = Buffer.concat([header('root/a.txt', content.length), content, header('root/b.txt', content.length), content, Buffer.alloc(1024)]);
  const entries = readArchive(gzipSync(tar), 1_000_000);
  assert.deepEqual(entries.get('a.txt')!.data, content);
  assert.equal(entries.get('a.txt')!.data.buffer, entries.get('b.txt')!.data.buffer);
});
