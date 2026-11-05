#!/usr/bin/env node
// Claude Code Stop 훅(type: command, async: true). stdin JSON에서 session_id와 동의한 경우의 요약만 골라 큐에 넣고 끝난다.
// stdout에 아무것도 쓰지 않는다. 훅 출력은 Claude가 해석한다. 종료 코드는 항상 0이다.
import { parseClaudeStop, readLimited, runHook } from './lib.mjs';

await runHook({ executor: 'claude', input: await readLimited(process.stdin), parse: parseClaudeStop });
process.exit(0);
