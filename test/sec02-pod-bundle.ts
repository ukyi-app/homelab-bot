import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from './sec02-pod.js';

// SEC-02 2단계 배포 묶음. 이미지의 dist/src를 그대로 쓰고, 실행기 파일만 함께 싣는다. 파드 안에서는 돌지 않는 빌드 쪽 도구다.
// 대조군 설정·루트 삭제가 있는 sec02-harness.js와 sec02-run.js를 넣지 않는 것이 이 목록의 목적이다. test/sec02-pod.test.ts가 이 목록의 import가 닫혀 있는지 본다.
export const POD_BUNDLE_FILES = Object.freeze(['sec02-pod-run.js', 'sec02-pod.js', 'sec02-turn.js', 'sec02-fixture.js', 'sec02-fake-api.js', 'sec02-expect.js', 'task-fixtures.js']);
export const POD_IMAGE_SRC = '/app/dist/src';

// distDir은 저장소를 컴파일한 dist다. <outDir>/sec02에 묶음을 만들고 dist/src의 해시를 돌려준다. 실행기가 이미지의 dist/src와 대조한다.
export async function buildPodBundle(distDir: string, outDir: string, imageSrc = POD_IMAGE_SRC): Promise<{ dir: string; srcDigest: string }> {
  const dir = join(outDir, 'sec02');
  await mkdir(join(dir, 'test'), { recursive: true, mode: 0o755 });
  for (const name of POD_BUNDLE_FILES) {
    await copyFile(join(distDir, 'test', name), join(dir, 'test', name));
    await chmod(join(dir, 'test', name), 0o644);
  }
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });
  await symlink(imageSrc, join(dir, 'src'));
  return { dir, srcDigest: await digestTree(join(distDir, 'src')) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [distDir, outDir] = process.argv.slice(2);
  if (!distDir || !outDir) { process.stderr.write('usage: sec02-pod-bundle <distDir> <outDir>\n'); process.exit(2); }
  const { srcDigest } = await buildPodBundle(distDir, outDir);
  process.stdout.write(`${srcDigest}\n`);
}
