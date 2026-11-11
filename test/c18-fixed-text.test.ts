import assert from 'node:assert/strict';
import test from 'node:test';
import { ALERT_TEXT } from '../src/alerts.js';
import { changeChildFailed, changeNextGeneration, changeRestart } from '../src/change-advice.js';
import { CHANGE_TEXT, PUBLISH_TEXT } from '../src/change-commands.js';
import { DEPLOYMENT_TEXT, describeDeployment } from '../src/change-deployment.js';
import { CHANGE_NOTICE_TEXT } from '../src/change-runtime.js';
import { commandDefinitions } from '../src/commands.js';
import { ATTACH_COMMAND_TEXT } from '../src/external-task-commands.js';
import { EXTERNAL_NOTICE_TEXT, formatNotice } from '../src/external-task-receiver.js';
import { REVIEW_NOTICE_TEXT } from '../src/review.js';
import { ALL_COMMANDS, COMMAND_INGRESS_TEXT, DiscordIngress } from '../src/discord.js';
import type { ChangeCommandHandler } from '../src/change-commands.js';
import type { ExternalTaskCommandHandler } from '../src/external-task-commands.js';
import { seedConversation } from './external-task-fixture.js';
import { event, fixture, localDatabase } from './helpers.js';

// C18 고정 문구 3(명세 §4.4·§4.9, AC-11·AC-23): 변경·Discord 리뷰 안내·경보·세션 연결. 경계는 S1의 문구 표 단위다.
// 스위치가 켜지면 '/' 명령 이름이 없고, 꺼지면 지금처럼 '/'를 안내한다. 이름은 등록 명령 표 전체에서 읽는다.
const registered = commandDefinitions(true, true, true, true, true).map(command => command.name);
const slashName = /(^|[^\p{L}\p{N}])\/[a-z][a-z-]*/u;
const ARGS = ['fixture-id', 'fixture-2', 'fixture-3', 'fixture-4'];
type Text = string | ((...values: never[]) => string) | Readonly<Record<string, string>>;
// 표의 항목마다 첫 인자가 스위치다(스위치를 받지 않는 항목은 앞 인자를 문자열로 받는다).
const render = (colleague: boolean, table: Readonly<Record<string, Text>>) => Object.entries(table).flatMap(([name, text]) =>
  typeof text === 'function' ? [[name, (text as (...values: unknown[]) => string)(colleague, ...ARGS)] as const]
    : typeof text === 'string' ? [[name, text] as const] : Object.entries(text).map(([key, value]) => [`${name}.${key}`, value] as const));
const SWITCHED = { CHANGE_TEXT, CHANGE_NOTICE_TEXT, ATTACH_COMMAND_TEXT, COMMAND_INGRESS_TEXT };
const advice = (c: boolean) => [['changeRestart', changeRestart(c)], ['changeNextGeneration', changeNextGeneration(c, 'fixture-id')],
  ['changeChildFailed', changeChildFailed('fixture-job', 'fixture-id', c)]] as const;
const all = (colleague: boolean) => [...Object.entries(SWITCHED).flatMap(([table, texts]) =>
  render(colleague, texts as Readonly<Record<string, Text>>).map(([name, text]) => [`${table}.${name}`, text] as const)), ...advice(colleague)];
// 스위치 밖 문구(인자에 스위치가 없다).
const OBSERVATION = { state: 'observed' as const, reason: null, headSha: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), configCommit: null, imageDigest: null,
  observedAt: 0, argoObservedAt: null, workloadObservedAt: null };
const fixed = () => [...Object.values(DEPLOYMENT_TEXT.state), DEPLOYMENT_TEXT.scope, describeDeployment(OBSERVATION),
  REVIEW_NOTICE_TEXT.unpublished('ukyi-app/fixture', 7, 'c'.repeat(12)), REVIEW_NOTICE_TEXT.restricted('ukyi-app/fixture', 7),
  REVIEW_NOTICE_TEXT.summary('ukyi-app/fixture', 7, 'c'.repeat(12), false, 2, 1), ALERT_TEXT.relayed('firing', 2),
  formatNotice({ executor: 'codex', externalTaskId: 'fixture-session', summary: '턴 완료', occurredAt: 0, receivedAt: 1000 }),
  ...Object.values(PUBLISH_TEXT).map(text => typeof text === 'function' ? text('fixture-id') : text)];

test("C18 스위치 켜짐: 변경·세션 연결 고정 문구 어디에도 '/' 명령 이름이 없다", () => {
  assert.ok(registered.includes('change-publish') && registered.includes('attach-list') && registered.includes('task-release'));
  for (const [name, text] of all(true)) {
    assert.doesNotMatch(text, slashName, name);
    for (const command of registered) assert.ok(!text.includes(`/${command}`), `${name}: /${command}`);
  }
});

test("C18 스위치 밖 문구(배포 관측·리뷰 안내·경보·R08 알림·게시 버튼 응답)에도 '/' 명령 이름이 없다", () => {
  for (const text of fixed()) assert.doesNotMatch(text, slashName, text);
});

test("C18 스위치 꺼짐: '/' 안내 줄은 지금처럼 '/' 명령 이름을 안내한다", () => {
  const off = Object.fromEntries(all(false));
  assert.match(off['CHANGE_TEXT.usage']!, /\/change project:<저장소> text:<요약>/);
  assert.match(off['CHANGE_TEXT.threadOnly']!, /\/chat/);
  assert.match(off['CHANGE_TEXT.transient']!, /\/change-status/);
  assert.match(off['CHANGE_TEXT.acceptedPost']!, /\/change-status target:fixture-id/);
  assert.match(off['CHANGE_TEXT.accepted']!, /\/change-publish/);
  assert.match(off['CHANGE_TEXT.nextUsage']!, /\/change project:fixture-id text:next/);
  assert.match(off['CHANGE_TEXT.nextPurged']!, /\/change/);
  assert.match(off['CHANGE_TEXT.cancelRace']!, /\/change-status/);
  assert.match(off['CHANGE_TEXT.statusChildUnknown']!, /\/task-release target:fixture-id/);
  assert.match(off['CHANGE_TEXT.answerUsage']!, /\/answer question:<ID> text:label=public/);
  assert.match(off['CHANGE_NOTICE_TEXT.published']!, /\/change-status/);
  assert.match(off['CHANGE_NOTICE_TEXT.previewApprove']!, /\/change-publish target:fixture-id text:fixture-2/);
  assert.match(off['ATTACH_COMMAND_TEXT.usage']!, /\/attach target:<세션 ID>/);
  assert.match(off['ATTACH_COMMAND_TEXT.threadOnly']!, /\/chat/);
  assert.match(off['ATTACH_COMMAND_TEXT.notAttachable']!, /\/resume/);
  assert.match(off['ATTACH_COMMAND_TEXT.alreadyAttached']!, /\/attach-list[\s\S]*\/detach[\s\S]*\/attach/);
  assert.match(off['ATTACH_COMMAND_TEXT.deliveryFailed']!, /\/attach/);
  assert.match(off['ATTACH_COMMAND_TEXT.revokeUnconfirmed']!, /\/attach-list[\s\S]*\/detach/);
  assert.match(off.changeRestart!, /\/change/);
  assert.match(off.changeNextGeneration!, /\/change project:fixture-id text:next/);
  assert.match(off.changeChildFailed!, /\/change-status target:fixture-id/);
  assert.match(off['COMMAND_INGRESS_TEXT.changeAckLost']!, /\/change-status/);
  assert.match(off['COMMAND_INGRESS_TEXT.changeFailed']!, /\/change-status/);
  assert.match(off['COMMAND_INGRESS_TEXT.attachAckLost']!, /\/attach-list/);
  assert.match(off['COMMAND_INGRESS_TEXT.attachFailed']!, /\/attach-list/);
});

// C36 F-12(AC-11·23): 변경·세션 연결 명령의 처리기 예외와 응답 실패 안내도 스위치 판을 따른다. 문구 표가 아니라 실제 수신
// (DiscordIngress.receive)에 예외·ACK 실패를 넣어, 본인 응답과 채널에 남는 고정 안내를 본다.
async function ingressWith(colleague: boolean, reply: 'throw' | 'ok') {
  const { db, pg } = await localDatabase();
  const f = await fixture(db, { colleague });
  await seedConversation(db, f.store, f.now());
  const answer = async () => { if (reply === 'throw') throw new Error('fixture handler failed'); return { content: '처리했어요.', outcome: 'ok' }; };
  const changes: ChangeCommandHandler = { handle: answer };
  const external: ExternalTaskCommandHandler = { handle: answer };
  const acks: string[] = [];
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, true, ALL_COMMANDS, () => {}, undefined, undefined, external, changes);
  const outbox = async () => (await db.query<{ payload: { content: string } }>('SELECT payload FROM outbox ORDER BY created_at')).rows.map(row => row.payload.content);
  return { f, acks, ingress, outbox, close: () => pg.close() };
}
for (const colleague of [true, false]) {
  const name = colleague ? '켜짐' : '꺼짐';
  test(`C36 F-12 스위치 ${name}: 변경·세션 연결 처리기 예외의 답은 스위치 판 문구다`, async () => {
    const ctx = await ingressWith(colleague, 'throw');
    try {
      ctx.f.rest.acknowledge = async (_e, content) => { ctx.acks.push(content); };
      await ctx.ingress.receive(event('fixture-change', { kind: 'command', command: 'change-status', target: 'fixture-id' }));
      await ctx.ingress.receive(event('fixture-attach', { kind: 'command', command: 'attach-list' }));
      assert.deepEqual(ctx.acks, [COMMAND_INGRESS_TEXT.changeFailed(colleague), COMMAND_INGRESS_TEXT.attachFailed(colleague)]);
      for (const text of ctx.acks) {
        if (colleague) assert.doesNotMatch(text, slashName, text);
        else assert.match(text, /\/(change-status|attach-list)/, text);
      }
    } finally { await ctx.close(); }
  });
  test(`C36 F-12 스위치 ${name}: 변경·세션 연결 명령의 응답을 전하지 못하면 채널에 남는 안내가 스위치 판 문구다`, async () => {
    const ctx = await ingressWith(colleague, 'ok');
    try {
      ctx.f.rest.acknowledge = async () => { throw new Error('ack_lost'); };
      await ctx.ingress.receive(event('fixture-change', { kind: 'command', command: 'change-status', target: 'fixture-id' }));
      await ctx.ingress.receive(event('fixture-attach', { kind: 'command', command: 'attach-list' }));
      const notices = await ctx.outbox();
      assert.deepEqual(notices, [COMMAND_INGRESS_TEXT.changeAckLost(colleague), COMMAND_INGRESS_TEXT.attachAckLost(colleague)]);
      for (const text of notices) {
        if (colleague) assert.doesNotMatch(text, slashName, text);
        else assert.match(text, /\/(change-status|attach-list)/, text);
      }
    } finally { await ctx.close(); }
  });
}

test('C18 켜짐 판은 말로 하는 안내다: 미리보기는 게시 승인 버튼을, 세션 연결은 말로 부탁하라고 한다', () => {
  const on = Object.fromEntries(all(true));
  assert.ok(on['CHANGE_NOTICE_TEXT.previewApprove']!.includes(PUBLISH_TEXT.label), '미리보기는 C17 버튼을 가리킨다');
  assert.doesNotMatch(on['CHANGE_NOTICE_TEXT.previewApprove']!, /fixture-2/, '켜짐 판은 digest를 옮겨 적게 하지 않는다');
  assert.match(on['ATTACH_COMMAND_TEXT.alreadyAttached']!, /말해 주세요/);
  assert.match(on['CHANGE_TEXT.statusChildUnknown']!, /`homelab bot` CLI/);
});

test('C18 고정 문구는 해요체이고 자기를 봇이라 부르지 않는다', () => {
  const texts = [...all(false), ...all(true)].map(([, text]) => text).concat(fixed());
  for (const text of texts) {
    assert.doesNotMatch(text, /봇/, text);
    assert.doesNotMatch(text, /습니다|십시오|입니다|합니다|한다\.|이다\.|않았다/, text);
  }
});

test('C18 안전 문장: 경보는 원문을 싣지 않는다고 말하고, 리뷰 요약은 승인·병합 판단이 아니며, R08 알림은 결과를 확인하지 않았다고 말한다', () => {
  // 경보 중계 글은 상태와 건수만 받는다(원문을 받을 인자가 없다).
  assert.equal(ALERT_TEXT.relayed.length, 2);
  assert.match(ALERT_TEXT.relayed('firing', 3), /원문은 게시하지 않았어요/);
  assert.match(REVIEW_NOTICE_TEXT.summary('ukyi-app/fixture', 7, 'c'.repeat(12), true, 0, 0), /승인·병합 판단이 아니에요/);
  // 리뷰 요약은 숫자·리비전·고정 낱말만 받는다(모델 문장을 받을 문자열 인자가 저장소·head뿐이다).
  assert.equal(REVIEW_NOTICE_TEXT.summary.length, 6);
  const notice = formatNotice({ executor: 'claude', externalTaskId: 'fixture-session', summary: '빌드 끝', occurredAt: 0, receivedAt: 0 });
  assert.ok(notice.includes(EXTERNAL_NOTICE_TEXT.unverified));
  assert.ok(notice.includes('`fixture-session`') && notice.includes('`빌드 끝`'), '사용자 값은 코드 스팬에 둔다');
});
