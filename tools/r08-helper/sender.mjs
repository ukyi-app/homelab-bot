#!/usr/bin/env node
// 로컬 전송기. 큐의 이벤트를 서명해 보낸다. `run`은 계속 돌고 `once`는 한 번 돌고 끝나며 `status`는 큐와 실패 표시를 보여 준다.
// stderr에는 고정 코드만 쓴다. 본문·헤더·키는 쓰지 않는다.
import { Queue, helperPaths, loadConfig, sendDue } from './lib.mjs';

const POLL_MS = 2000;
const CONFIG_RETRY_MS = 30_000;
const paths = helperPaths();
const queue = new Queue(paths.state);
const log = code => process.stderr.write(`r08-sender ${code}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pass() {
  const config = await loadConfig(paths.config);
  return sendDue({ config, queue, log });
}
const command = process.argv[2];
if (command === 'status') {
  process.stdout.write(`${JSON.stringify(await queue.status(), null, 2)}\n`);
} else if (command === 'once') {
  try { process.stdout.write(`${JSON.stringify(await pass())}\n`); } catch (error) {
    log(error?.message === 'config_invalid' ? 'config_invalid' : 'pass_failed');
    process.exitCode = 1;
  }
} else if (command === 'run') {
  let running = true;
  const stop = () => { running = false; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (running) {
    try {
      await pass();
      await sleep(POLL_MS);
    } catch (error) {
      log(error?.message === 'config_invalid' ? 'config_invalid' : 'pass_failed');
      await sleep(CONFIG_RETRY_MS);
    }
  }
} else {
  process.stderr.write('usage: sender.mjs run|once|status\n');
  process.exitCode = 2;
}
