import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_TASK_TEXT, jobStateText, laneReasonText } from '../src/chat-task-text.js';
import { commandDefinitions } from '../src/commands.js';
import { controlText, taskLaneClosedText } from '../src/control-format.js';

// 명세 §4.1·§4.9: 스위치가 켜지면 고정 문구 어디에도 '/' 명령 이름이 없다. 이름은 등록 목록 전체에서 읽는다.
const registered = commandDefinitions(true, true, true, true, true).map(command => command.name);
// 등록 목록 밖이라도 '/이름' 모양 안내가 남으면 같은 실패다(예: Codex 해제 안내).
const slashName = /(^|[^\p{L}\p{N}])\/[a-z][a-z-]*/u;
const args = ['job-1', 'risk-1', 'reason-1', '3', 'job-2'];
const all = (colleague: boolean) => Object.entries(CHAT_TASK_TEXT).map(([name, text]) =>
  [name, typeof text === 'function' ? (text as (...values: unknown[]) => string)(colleague, ...args) : text] as const);
const controls = (colleague: boolean) => [
  ...['unknown', 'cleanup_pending', 'retention_full', 'other_reason'].map(reason => taskLaneClosedText(reason, colleague)),
  controlText('stop', { active: false }, colleague), controlText('resume', { active: true }, colleague),
  controlText('model-status', { paused: true, emergency: true, executionPending: true, waiting: [{ id: 'job-1', wait_reason: 'model_limit' }] }, colleague),
  controlText('list', [{ id: 'job-1', state: 'waiting_user', wait_reason: 'clarification' }], colleague),
  controlText('cancel', { ok: false, status: 'x' }, colleague)];

test("스위치 켜짐: 대화·작업·제어 고정 문구 어디에도 '/' 명령 이름이 없다", () => {
  assert.ok(registered.includes('task-release') && registered.includes('resume-model'));
  for (const [name, text] of all(true)) {
    assert.doesNotMatch(text, slashName, name);
    for (const command of registered) assert.ok(!text.includes(`/${command}`), `${name}: /${command}`);
  }
  for (const text of controls(true)) assert.doesNotMatch(text, slashName, text);
});

test("스위치 꺼짐: '/' 안내 줄은 지금처럼 '/' 명령 이름을 안내한다", () => {
  const off = Object.fromEntries(all(false));
  assert.match(off.readTimeout!, /\/read/);
  assert.match(off.jobFailed!, /\/list[\s\S]*\/retry/);
  assert.match(off.modelWaitAuth!, /\/resume-model target:job-1[\s\S]*\/model-status/);
  assert.match(off.unknownWait!, /\/model-status/);
  assert.match(off.staleRetry!, /\/retry target:job-1/);
  assert.match(off.interactionExpired!, /\/list/);
  assert.match(off.modelStatus!, /\/resume-model target:<job-id>[\s\S]*\/cancel target:<job-id>[\s\S]*\/resume-model target:emergency-stop/);
  assert.match(off.reviewStatus!, /\/review-resume target:<job-id>[\s\S]*\/review-cancel target:<job-id>/);
  assert.match(off.taskBlocked!, /\/task-release target:job-1/);
  assert.match(off.codexBlocked!, /\/codex-release target:job-1/);
  assert.match(off.questionFooter!, /\/answer question:job-1/);
  assert.match(off.modelPauseResume!, /\/resume-model target:job-1[\s\S]*\/cancel/);
  assert.match(off.modelWaitLong!, /\/resume-model target:job-1[\s\S]*\/cancel target:job-1/);
  assert.match(taskLaneClosedText('unknown'), /\/task-release target:<job-id>/);
  assert.match(taskLaneClosedText('retention_full'), /\/answer[\s\S]*\/resume-model[\s\S]*\/task-cancel/);
  assert.match(controlText('stop', { active: false }), /\/resume/);
});

test('관리 기능 안내의 켜짐 판은 homelab bot CLI로 한다고 말한다', () => {
  const on = Object.fromEntries(all(true));
  for (const name of ['modelWaitAuth', 'modelWaitLimit', 'unknownWait', 'modelStatus', 'taskBlocked', 'codexBlocked', 'laneUnknownNote', 'releaseUnknownNote'] as const) {
    assert.match(on[name]!, /`homelab bot` CLI/, name);
  }
  assert.match(taskLaneClosedText('unknown', true), /`homelab bot` CLI/);
});

test('고정 문구는 해요체이고 자기를 봇이라 부르지 않는다', () => {
  const texts = [...all(false), ...all(true)].map(([, text]) => text).concat(controls(false), controls(true));
  for (const text of texts) {
    assert.doesNotMatch(text, /봇/, text);
    assert.doesNotMatch(text, /습니다|십시오|입니다/, text);
  }
});

test('질문 안내는 두 판 모두 질문 ID와 승인·권한 변경이 아니라는 문장을 남긴다', () => {
  for (const colleague of [false, true]) {
    const footer = CHAT_TASK_TEXT.questionFooter(colleague, 'q-1', '2026-11-10T00:00:00.000Z');
    assert.match(footer, /q-1/);
    assert.match(footer, /도구 실행을 승인하거나 권한을 바꿀 수는 없어요/);
  }
});

test('상태·사유 코드는 owner가 읽는 말로 풀고 모르는 코드는 그대로 둔다', () => {
  assert.equal(jobStateText('waiting_user'), '확인 기다림');
  assert.equal(jobStateText('new_state'), 'new_state');
  assert.equal(laneReasonText('retention_full'), '보존 세션 8개가 다 참');
  assert.equal(laneReasonText('new_reason'), 'new_reason');
});
