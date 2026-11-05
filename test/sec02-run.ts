import { REPORT_MARKER, encodeReport, runBoundary } from './sec02-harness.js';
import type { RunnerConfig } from './sec02-harness.js';

// 하네스 러너 진입점. 시험(또는 네트워크 없는 컨테이너)이 띄운다. stdout에는 값 없는 결과 한 줄만 낸다.
const config = JSON.parse(process.argv[2] ?? '{}') as RunnerConfig;
runBoundary(config).then(report => {
  // 파이프는 비동기다. 쓰기가 끝나기 전에 exit하면 64KiB에서 잘린다.
  process.stdout.write(`${REPORT_MARKER}${encodeReport(report)}\n`, () => process.exit(0));
}, (error: unknown) => {
  // 오류 원문은 경로를 담을 수 있어 이름만 낸다.
  process.stderr.write(`sec02_runner_failed ${error instanceof Error ? error.name : 'unknown'}\n`);
  process.exit(1);
});
