#!/usr/bin/env node
// Codex notify 프로그램. 마지막 argv의 JSON에서 thread-id·turn-id와 동의한 경우의 요약만 골라 큐에 넣고 끝난다.
// argv를 로그에 남기지 않는다. 그 안에 입력 메시지와 답 전문이 있다. 종료 코드는 항상 0이다.
import { parseCodexNotify, runHook } from './lib.mjs';

await runHook({ executor: 'codex', input: process.argv.at(-1) ?? '', parse: parseCodexNotify });
process.exit(0);
