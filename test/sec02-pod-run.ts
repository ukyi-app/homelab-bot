import { fileURLToPath } from 'node:url';
import { POD_LIMITS, POD_REPORT_MARKER, PodRunner, defaultDeps, encodePodReport, parsePodConfig } from './sec02-pod.js';
import type { PodConfig } from './sec02-pod.js';

// 운영 파드 실행기 진입점. kubectl exec로 한 번 돈다. stdout에는 값 없는 결과 한 줄만, stderr에는 정해진 코드만 낸다.
// 파드 env에는 진짜 HTTPS_PROXY 등이 있다. 자식에게 넘어갈 일이 없게 먼저 지운다. CLI 자식 env는 어차피 허용 목록으로 새로 만든다.
for (const name of Object.keys(process.env)) if (name !== 'PATH' && name !== 'LANG') delete process.env[name];

const fail = (code: string, exitCode: number): never => {
  process.stderr.write(`sec02_pod_${code}\n`);
  process.exit(exitCode);
};

const readConfig = (): PodConfig => {
  try { return parsePodConfig(process.argv[2] ?? ''); }
  catch { return fail('config_invalid', 2); }
};

const runner = new PodRunner(defaultDeps(readConfig(), fileURLToPath(new URL('../src', import.meta.url))));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => runner.requestAbort('signal'));
// 여기까지 오면 run의 정리를 믿을 수 없다. 올린 경로만 지우고 끝낸다.
const last = (code: string) => { void runner.emergency().finally(() => fail(code, 3)); };
process.on('uncaughtException', () => last('uncaught_exception'));
process.on('unhandledRejection', () => last('unhandled_rejection'));
// 전체 상한 뒤 정리까지 끝낼 여유. run.sh의 kubectl 타임아웃(6분)보다 먼저 온다.
setTimeout(() => last('hard_timeout'), POD_LIMITS.totalMs + 30_000).unref();

runner.run().then(report => {
  // 파이프는 비동기다. 쓰기가 끝나기 전에 exit하면 잘린다.
  process.stdout.write(`${POD_REPORT_MARKER}${encodePodReport(report)}\n`, () => process.exit(0));
}, () => last('run_failed'));
