import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_TEXT } from '../src/change-commands.js';
import { DEFAULTS, Denied } from '../src/contracts.js';
import { DiscordPublisher } from '../src/discord.js';
import { ATTACH_COMMAND_TEXT } from '../src/external-task-commands.js';
import { RAW_TEXT_NOTICE } from '../src/memory-commands.js';
import { PROPOSAL_TEXT, PROPOSAL_TTL_MS } from '../src/proposals.js';
import { purgeExpiredRawText } from '../src/raw-text-retention.js';
import { Store } from '../src/store.js';
import { localDatabase, thread } from './helpers.js';
import { harness, PROJECT } from './c13-proposal-fixture.js';
import { actions, notifyChannel, notifyThread, outsideThread, TRUNCATE } from './c14-actions-fixture.js';
import type { Actions } from './c14-actions-fixture.js';
import { REPO } from './change-github-fake.js';

// C14 나머지 동작 연결(COLLEAGUE_SPEC §4.3, AC-6·AC-7·AC-26). 경계는 S1이다: Gateway 프레임 → 수신·저장(PGlite) → 가짜 Discord REST.
// 비교 기준은 같은 대화에서 같은 '/' 명령을 직접 보낸 결과다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let open: Actions | undefined;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(TRUNCATE);
  await database.pg.exec(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`);
});
afterEach(async () => { await open?.close(); open = undefined; });
after(async () => { await database.pg.close(); });
async function wired() { open = await actions(database.db); return open; }

const body = (content: string) => content.split('\n-# ref:')[0]!;
let seq = 100;
const message = () => `1000000000000${String(++seq).padStart(5, '0')}`;
const yesOf = (a: Actions) => a.buttons().ids[0]!;
const noOf = (a: Actions) => a.buttons().ids[1]!;
// 같은 대화에 '/task'로 작업 하나를 접수하고 그 ID를 돌려준다.
async function task(a: Actions) {
  await a.slash('task', { target: PROJECT, text: '시험을 고쳐 줘' });
  return (await a.jobs('task')).at(-1)!.id;
}

test('C14 실행 확인 글은 대화 답의 모든 쪽이 게시된 뒤에만 나간다(긴 답의 남은 쪽이 늦어져도 버튼이 먼저 보이지 않는다)', async () => {
  const h = await harness(database.db);
  const long = `${'가'.repeat(1500)}\n\n${'나'.repeat(1500)}`;
  h.reply({ action: 'task', target: PROJECT, content: null }, long);
  await h.say('100000000000000010', '실패하는 시험을 고쳐 줘');
  // 답의 둘째 쪽은 Discord에 올라갔지만 응답을 잃어(보냈는지 모름, unknown) 대조가 찾을 때까지 sent가 아니다.
  const send = h.f.rest.sendMessage.bind(h.f.rest);
  let lost = false;
  h.f.rest.sendMessage = async (channel, sent) => {
    const record = await send(channel, sent);
    if (!lost && sent.content.startsWith('나')) { lost = true; throw new Error('response_lost'); }
    return record;
  };
  await h.turn();
  assert.ok(lost);
  assert.equal(h.buttons().posted.length, 0, '답의 남은 쪽보다 확인 글이 먼저 나가면 안 된다');
  await h.f.publisher.reconcile();
  while (await h.f.publisher.deliver()) { /* 대조 뒤 남은 쪽과 확인 글 */ }
  const order = h.f.rest.messages.map(m => body(m.body.content));
  const second = order.findIndex(text => text.startsWith('나'));
  const button = h.f.rest.messages.findIndex(m => m.body.components?.length);
  assert.ok(second >= 0 && button > second, JSON.stringify({ second, button }));
});

test('C14 작업 상태 제안은 확인 없이 /task-status와 같은 결과를 일반 답으로 달고, 상태를 바꾸지 않으며, 이 대화에서 볼 수 없는 작업이면 버려진다', async () => {
  const a = await wired();
  const job = await task(a);
  const slash = (await a.slash('task-status', { target: job })).reply;
  assert.ok(slash?.includes(job), slash);
  await a.speak(message(), '그 작업 어떻게 돼 가?', { action: 'task_status', target: job, content: null });
  assert.equal(a.buttons().posted.length, 0);
  assert.equal(a.posted().at(-1), slash);
  assert.deepEqual((await a.jobs('task')).map(j => j.state), ['queued']);
  assert.deepEqual(await a.proposals(), []);
  const posted = a.posted().length;
  await a.speak(message(), '다른 작업은?', { action: 'task_status', target: 'fixture-unknown-job', content: null });
  assert.equal(a.posted().length, posted + 1, '대화 답만 나간다');
  assert.deepEqual((await a.dropped()).at(-1), { action: 'task_status', reason: 'target_denied' });
});

test('C14 변경 상태·세션 연결 목록·기억 검색 제안은 확인 없이 같은 /명령 결과를 일반 답으로 단다', async () => {
  const a = await wired();
  await a.slash('change', { target: REPO.fullName, text: '공개 요약 | accept=시험 통과 | label=public' });
  const change = (await database.db.query<{ id: string }>('SELECT id FROM change_requests')).rows[0]!.id;
  const changeSlash = (await a.slash('change-status', { target: change })).reply;
  await a.speak(message(), '그 변경 어디까지 됐어?', { action: 'change_status', target: change, content: null });
  assert.equal(a.posted().at(-1), changeSlash);
  await a.links.attach({ owner: a.f.policy.owner, scope: thread, externalTaskId: 'fixture-session', executor: 'claude' });
  const listSlash = (await a.slash('attach-list')).reply;
  await a.speak(message(), '연결한 세션 보여 줘', { action: 'attach_list', target: null, content: null });
  assert.equal(a.posted().at(-1), listSlash);
  await a.slash('memory-save', { target: 'decision', text: '금요일에는 배포하지 않는다 | applies=homelab' });
  const searchSlash = (await a.slash('memory-search', { text: '금요일' })).reply;
  assert.ok(searchSlash?.includes('금요일에는 배포하지 않는다'), searchSlash);
  await a.speak(message(), '금요일 배포 규칙 기억나?', { action: 'memory_search', target: null, content: '금요일' });
  // 일반 글이라 대화 출처는 ID 없이 "대화"로만 적는다(C36 묶음 E). 나머지는 '/' 결과와 같다.
  assert.match(searchSlash!, /출처 conversation:fixture-c14-command-\d+ · /);
  assert.equal(a.posted().at(-1), searchSlash!.replace(/출처 conversation:fixture-c14-command-\d+ · /, '출처 대화 · '));
  assert.equal(a.buttons().posted.length, 0);
  assert.deepEqual(await a.proposals(), []);
});

test('C36 F-4 읽기 제안의 결과가 공개 검사에 걸리면 일반 답에는 고정 안내만 달고 값은 게시·outbox에 없다. 같은 /명령의 본인 전용 응답은 그대로다', async () => {
  const a = await wired();
  const hidden = '10.20.30.40';
  await a.slash('memory-save', { target: 'decision', text: `배포 대상 노드는 ${hidden}이다 | applies=homelab` });
  const searchSlash = (await a.slash('memory-search', { text: '배포 대상' })).reply;
  assert.ok(searchSlash?.includes(hidden), '대조: 본인 전용 응답에는 있다');
  await a.speak(message(), '배포 대상 노드 기억나?', { action: 'memory_search', target: null, content: '배포 대상' });
  await a.deliver();
  assert.equal(a.posted().at(-1), PROPOSAL_TEXT.readWithheld);
  assert.ok(!a.posted().some(text => text.includes(hidden)));
  assert.ok(!JSON.stringify((await database.db.query('SELECT payload FROM outbox')).rows).includes(hidden));
});

test('C36 묶음 E 대화 출처가 있는 안전한 기억을 말로 검색하면 일반 답에 진술은 보이고 출처의 Discord ID는 없다. 같은 /memory-search 본인 전용 응답에는 ID가 있다', async () => {
  const a = await wired();
  const said = message();
  await a.speak(said, '금요일 배포 규칙 기억해 둬', { action: 'memory_save', target: 'decision', content: '금요일에는 배포하지 않는다 | applies=homelab' });
  await a.press(yesOf(a));
  const searchSlash = (await a.slash('memory-search', { text: '금요일' })).reply;
  assert.ok(searchSlash?.includes(`conversation:${said}`), '대조: 본인 전용 응답에는 대화 출처 ID가 있다');
  await a.speak(message(), '금요일 배포 규칙 기억나?', { action: 'memory_search', target: null, content: '금요일' });
  await a.deliver();
  const answer = a.posted().at(-1)!;
  assert.notEqual(answer, PROPOSAL_TEXT.readWithheld);
  assert.ok(answer.includes('금요일에는 배포하지 않는다'), answer);
  assert.ok(answer.includes('출처 대화 · '), answer);
  assert.ok(!a.posted().some(text => text.includes(said)), '일반 글 어디에도 출처 ID가 없다');
  assert.ok(!JSON.stringify((await database.db.query("SELECT payload FROM outbox WHERE message_key LIKE 'result:%:read'")).rows).includes(said));
});

test('C36 묶음 E 켜짐에서 저장한 여러 쪽의 기억 저장 확인 글은 스위치를 끈 게시 서버가 어느 쪽도 게시하지 않고, 대화 답은 나간다', async () => {
  const a = await wired();
  const statement = `${'금요일 저녁에는 배포하지 않는다. '.repeat(90).trim()} | applies=homelab`;
  assert.ok(statement.length >= 1600);
  a.reply({ action: 'memory_save', target: 'decision', content: statement }, '저장할지 물어볼게요.');
  await a.say(message(), '긴 배포 규칙 기억해 둬');
  a.f.advance(DEFAULTS.debounceMs + 50);
  await a.local.runtime.tick();
  const pages = (await database.db.query<{ page_index: number; buttons: boolean }>(`SELECT page_index,payload ? 'buttons' AS buttons FROM outbox
    WHERE message_key LIKE 'result:%:proposal' ORDER BY page_index`)).rows;
  assert.ok(pages.length >= 2 && pages.at(-1)!.buttons && pages.slice(0, -1).every(page => !page.buttons), `대조: 버튼은 마지막 쪽에만 있다 ${JSON.stringify(pages)}`);
  const off = new DiscordPublisher(new Store(database.db, a.f.now, false), a.f.gate, a.f.rest);
  while (await off.deliver()) { /* 쌓인 게시를 비운다 */ }
  assert.ok(a.posted().includes('저장할지 물어볼게요.'), '대화 답은 나간다');
  assert.ok(!a.posted().some(text => text.includes('금요일 저녁에는') || text.includes('기억으로 저장할까요')), JSON.stringify(a.posted()));
  assert.equal(a.buttons().posted.length, 0);
  // 모든 쪽이 끝 상태(blocked)라 원문 주기 정리가 본문을 비울 수 있다.
  assert.deepEqual((await database.db.query<{ state: string }>("SELECT state FROM outbox WHERE message_key LIKE 'result:%:proposal'")).rows.map(r => r.state),
    pages.map(() => 'blocked'));
  assert.deepEqual((await a.proposals()).map(p => p.state), ['pending']);
});

test('C14 읽기 템플릿 제안은 카탈로그의 템플릿이면 /read와 같은 read 레인 결과를 달고, 카탈로그 밖이면 버려진다', async () => {
  const a = await wired();
  await a.slash('read', { target: 'homelab-bot', text: 'homelab-bot-deployment' });
  await a.local.runtime.tickRead();
  await a.deliver();
  // 시간창 줄은 조회 시각이라 둘이 다르다. 나머지 줄(대상·출처·결과)을 비교한다.
  const lines = (text: string | undefined) => (text ?? '').split('\n').filter(line => !line.startsWith('시간창:')).join('\n');
  const slash = a.posted().at(-1);
  assert.match(slash ?? '', /^대상: homelab-bot\n/);
  await a.speak(message(), '봇 배포 상태 봐 줘', { action: 'read', target: 'homelab-bot-deployment', content: null });
  await a.local.runtime.tickRead();
  await a.deliver();
  assert.equal(lines(a.posted().at(-1)), lines(slash));
  assert.equal((await a.jobs('read')).length, 2);
  await a.speak(message(), '이것도 봐 줘', { action: 'read', target: 'fixture-not-in-catalog', content: null });
  assert.equal((await a.jobs('read')).length, 2);
  assert.deepEqual((await a.dropped()).at(-1), { action: 'read', reason: 'target_denied' });
});

test('C14 리뷰 상태 제안은 스레드에서 말해도 알림 채널의 /review-status와 같은 결과를 단다', async () => {
  const a = await wired();
  await a.reviewJob();
  const slash = (await a.slash('review-status', { scope: notifyChannel })).posted.at(-1);
  await a.speak(message(), '리뷰 밀린 거 있어?', { action: 'review_status', target: null, content: null });
  assert.equal(a.posted().at(-1), slash);
});

test('C14 작업 취소 제안은 버튼 전 실행 0건이고, 누르면 /cancel·/task-cancel과 같은 결과로 한 번 실행되며, 이 대화에서 볼 수 없는 작업이면 버려진다', async () => {
  const a = await wired();
  const first = await task(a);
  const second = await task(a);
  const slash = (await a.slash('cancel', { target: second })).posted;
  await a.speak(message(), '첫 작업 취소해 줘', { action: 'task_cancel', target: first, content: null });
  assert.equal(a.buttons().content.split('\n-# ref:')[0], PROPOSAL_TEXT.taskCancelQuestion(first));
  assert.equal((await a.jobs('task')).find(j => j.id === first)!.state, 'queued');
  await a.press(yesOf(a));
  assert.equal((await a.jobs('task')).find(j => j.id === first)!.state, 'cancelled');
  // '/cancel'이 게시한 제어 결과 글과 같은 문장이다.
  assert.ok(slash.includes(String(a.lastCallback()!.data.content)), JSON.stringify({ slash, button: a.lastCallback()!.data.content }));
  assert.deepEqual(a.lastCallback()!.data.components, []);
  await a.speak(message(), '그거 취소', { action: 'cancel', target: 'fixture-unknown-job', content: null });
  assert.deepEqual((await a.dropped()).at(-1), { action: 'cancel', reason: 'target_denied' });
  assert.equal((await a.proposals()).length, 1);
});

test('C14 말로 하는 리뷰 재개·취소는 대화 채널·알림 채널 아래 스레드에서 owner면 받고, 허용 채널 밖·비 owner는 거부하며, / 리뷰 제어는 지금처럼 알림 채널 본문에서만 받는다', async () => {
  const a = await wired();
  const first = await a.reviewJob();
  const waiting = await a.reviewJob();
  // '/' 예비: 스레드에서 보낸 리뷰 취소는 지금처럼 거부된다.
  const refused = (await a.slash('review-cancel', { target: first })).posted.at(-1)!;
  assert.ok(refused.includes('리뷰 작업은 owner가 알림 채널에서만 제어할 수 있어요.'), refused);
  assert.equal((await a.jobs('review')).find(j => j.id === first)!.state, 'queued');
  // 대화 채널 아래 스레드: 확인 뒤 취소된다. 버튼 전에는 그대로다.
  await a.speak(message(), '그 리뷰 취소해 줘', { action: 'review_cancel', target: first, content: null });
  assert.equal((await a.jobs('review')).find(j => j.id === first)!.state, 'queued');
  await a.press(yesOf(a));
  assert.equal((await a.jobs('review')).find(j => j.id === first)!.state, 'cancelled');
  // 알림 채널 아래 스레드: 확인 뒤 재개된다.
  await a.speak(message(), '그 리뷰 다시 해 줘', { action: 'review_resume', target: waiting, content: null }, { scope: notifyThread });
  await a.waitReview(waiting);
  await a.press(yesOf(a), { scope: notifyThread });
  assert.equal((await a.jobs('review')).find(j => j.id === waiting)!.state, 'queued');
  // 허용 채널 밖·owner가 아닌 사람은 '/'와 같이 수신에서 거부된다(대화 작업도 제안도 없다).
  const before = (await a.proposals()).length;
  await assert.rejects(a.say(message(), '리뷰 취소해 줘', { scope: outsideThread }), Denied);
  await assert.rejects(a.say(message(), '리뷰 취소해 줘', { author: 'fixture-stranger' }), Denied);
  assert.equal((await a.proposals()).length, before);
});

test('C14 기억 저장 제안은 저장될 내용이 확인 글에 그대로 보이고, 누르면 그 내용만 출처를 owner 대화로 저장하며, 값은 처리·거절·만료 뒤 비워진다', async () => {
  const a = await wired();
  const statement = '금요일에는 배포하지 않는다 | applies=homelab';
  const said = message();
  await a.speak(said, '앞으로 금요일엔 배포하지 말자. 기억해 둬', { action: 'memory_save', target: 'decision', content: statement });
  const shown = body(a.buttons().content);
  assert.equal(shown, PROPOSAL_TEXT.memorySaveQuestion('decision', statement));
  assert.ok(shown.includes(statement));
  assert.deepEqual(await a.memoryService.search(a.f.policy.owner, thread, '금요일'), []);
  await a.press(yesOf(a));
  const [saved] = await a.memoryService.search(a.f.policy.owner, thread, '금요일');
  assert.equal(saved?.statement, '금요일에는 배포하지 않는다');
  assert.deepEqual(saved?.sources, [{ type: 'conversation', message: said }]);
  assert.equal(saved?.status, 'active');
  assert.ok(String(a.lastCallback()!.data.content).includes(saved.id));
  assert.deepEqual((await a.proposals()).map(p => [p.state, p.value, p.source_event]), [['confirmed', null, null]]);
  // 거절과 만료도 값을 비운다.
  await a.speak(message(), '이것도 기억해', { action: 'memory_save', target: 'decision', content: '다른 결정 | applies=homelab' });
  await a.press(noOf(a));
  await a.speak(message(), '저것도', { action: 'memory_save', target: 'decision', content: '세 번째 결정 | applies=homelab' });
  a.f.advance(PROPOSAL_TTL_MS + 1);
  await a.press(yesOf(a));
  assert.deepEqual((await a.proposals()).map(p => [p.state, p.value, p.source_event]),
    [['confirmed', null, null], ['declined', null, null], ['expired', null, null]]);
  assert.equal((await a.memoryService.search(a.f.policy.owner, thread, '결정')).length, 0);
});

test('C36 F-9 누르지 않고 새 제안도 없는 기억 제안의 진술은 만료 뒤 주기 원문 정리가 비운다(스위치를 끈 게시 서버에서도)', async () => {
  const a = await wired();
  const statement = '토요일에는 배포하지 않는다 | applies=homelab';
  await a.speak(message(), '토요일 배포 규칙 기억해 둬', { action: 'memory_save', target: 'decision', content: statement });
  // 만료 전에는 남는다(버튼을 누를 수 있다).
  await purgeExpiredRawText(database.db, a.f.now());
  assert.deepEqual((await a.proposals()).map(p => [p.state, p.value]), [['pending', statement]]);
  a.f.advance(PROPOSAL_TTL_MS + 1);
  // 스위치를 끄고 다시 띄운 게시 서버도 같은 정리를 돈다(정리는 DB와 시각만 받는다).
  const off = new Store(database.db, a.f.now, false);
  await purgeExpiredRawText(off.db, off.now());
  assert.deepEqual((await a.proposals()).map(p => [p.state, p.value, p.source_event, p.reason]), [['expired', null, null, 'expired']]);
  assert.ok(!JSON.stringify((await database.db.query('SELECT * FROM proposals')).rows).includes('토요일'));
});

test('C36 F-7 "할게요" 확정 커밋 뒤 실행 전에 멈추면, 다시 띄운 게시 서버의 주기 정리가 그 스레드에 실패 안내를 한 번 남기고 값을 비운다', async () => {
  const a = await wired();
  const statement = '일요일에는 배포하지 않는다 | applies=homelab';
  await a.speak(message(), '일요일 배포 규칙 기억해 둬', { action: 'memory_save', target: 'decision', content: statement });
  // 커밋 뒤 처리기 호출에서 프로세스가 멈춘 것과 같다: 처리기가 끝나지 않는다.
  a.memoryService.remember = () => new Promise(() => {});
  void a.press(yesOf(a));
  for (let spin = 0; spin < 200 && (await a.proposals())[0]!.state === 'pending'; spin++) await new Promise(resolve => setImmediate(resolve));
  // 확정했지만 실행이 끝나지 않은 동안에는 값(실행 입력)을 남긴다.
  assert.deepEqual((await a.proposals()).map(p => [p.state, p.value]), [['confirmed', statement]]);
  const posted = a.posted().length;
  // 실행 중일 수 있는 동안(10분)은 건드리지 않는다.
  await purgeExpiredRawText(database.db, a.f.now());
  await a.deliver();
  assert.equal(a.posted().length, posted);
  a.f.advance(10 * 60_000 + 1);
  await purgeExpiredRawText(database.db, a.f.now());
  await purgeExpiredRawText(database.db, a.f.now());
  await a.deliver();
  assert.deepEqual(a.posted().slice(posted), [PROPOSAL_TEXT.interrupted]);
  assert.deepEqual((await a.proposals()).map(p => [p.state, p.value, p.source_event, p.reason]), [['confirmed', null, null, 'run_interrupted']]);
});

test('C14 기억 저장 제안의 값이 확인 글과 달라지면 버튼은 저장하지 않는다(owner가 본 값만 저장된다)', async () => {
  const a = await wired();
  await a.speak(message(), '기억해 둬', { action: 'memory_save', target: 'decision', content: '보인 진술 | applies=homelab' });
  await database.db.query("UPDATE proposals SET value='바뀐 진술 | applies=homelab'");
  await a.press(yesOf(a));
  assert.equal(a.lastCallback()!.data.content, PROPOSAL_TEXT.changed);
  assert.equal((await a.memoryService.search(a.f.policy.owner, thread, '진술')).length, 0);
});

test('C14 기억 삭제 제안은 누르면 /memory-delete와 같은 처리로 지우고 원문 7일 안내가 버튼 응답에도 나온다', async () => {
  const a = await wired();
  const saved = (await a.slash('memory-save', { target: 'decision', text: '지울 결정 | applies=homelab' })).reply!;
  const id = /`([0-9a-f-]{36})`/.exec(saved)![1]!;
  await a.speak(message(), '그 기억 지워 줘', { action: 'memory_delete', target: id, content: null });
  assert.equal((await a.memoryService.search(a.f.policy.owner, thread, '지울')).length, 1);
  await a.press(yesOf(a));
  assert.ok(String(a.lastCallback()!.data.content).includes(RAW_TEXT_NOTICE));
  assert.equal((await a.memoryService.search(a.f.policy.owner, thread, '지울')).length, 0);
});

test('C14 세션 연결 해제 제안은 이 스레드의 연결만 받고, 누르면 /detach와 같은 처리로 한 번 해제한다', async () => {
  const a = await wired();
  await a.speak(message(), '안녕', null);
  const link = await a.links.attach({ owner: a.f.policy.owner, scope: thread, externalTaskId: 'fixture-session', executor: 'claude' });
  await a.speak(message(), '그 연결 끊어 줘', { action: 'detach', target: link.connectionId, content: null });
  assert.equal(body(a.buttons().content), PROPOSAL_TEXT.detachQuestion(link.connectionId));
  assert.equal((await a.links.list(a.f.policy.owner, thread)).items[0]!.state, 'active');
  await a.press(yesOf(a));
  assert.equal(String(a.lastCallback()!.data.content), ATTACH_COMMAND_TEXT.detached(true, 0));
  assert.equal((await a.links.list(a.f.policy.owner, thread)).items[0]!.state, 'revoked');
  await a.speak(message(), '없는 연결 끊어 줘', { action: 'detach', target: '00000000-0000-4000-8000-000000000000', content: null });
  assert.deepEqual((await a.dropped()).at(-1), { action: 'detach', reason: 'target_denied' });
});

test('C14 말로 한 변경 요청은 "<저장소>에 이 변경 PR을 준비할까요?"로 묻고, 누르기 전 접수 0건이며, 누르면 owner 원문을 공개 표시로 접수한다', async () => {
  const a = await wired();
  const request = '로그인 화면의 오타를 고쳐 줘';
  const said = message();
  await a.speak(said, request, { action: 'change', target: REPO.fullName, content: '모델이 다시 쓴 변경 내용' });
  assert.equal(body(a.buttons().content), `${REPO.fullName}에 이 변경 PR을 준비할까요?`);
  assert.deepEqual(a.buttons().labels, ['할게요', '아니에요']);
  // 공개 여부를 묻는 글이 없다.
  assert.ok(!a.posted().some(text => /공개해도|label=/.test(text)), JSON.stringify(a.posted()));
  assert.equal((await database.db.query('SELECT id FROM change_requests')).rows.length, 0);
  await a.press(yesOf(a));
  const rows = (await database.db.query<{ id: string; label: string }>('SELECT id,label FROM change_requests')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, 'public');
  const input = (await database.db.query<{ text: string; event_id: string }>('SELECT text,event_id FROM change_request_inputs')).rows[0]!;
  assert.equal(input.text.split(' | ')[0], request);
  assert.ok(!input.text.includes('모델이 다시 쓴'));
  assert.equal(input.event_id, said);
  assert.ok(String(a.lastCallback()!.data.content).includes(rows[0]!.id));
});

test('C14 말로 한 변경 요청도 /change와 같은 장소·저장소 규칙이라 알림 채널 스레드·정책 밖 저장소면 버려진다', async () => {
  const a = await wired();
  const slash = (await a.slash('change', { target: REPO.fullName, text: '공개 요약 | accept=시험 통과 | label=public', scope: notifyThread })).reply!;
  assert.equal(slash, CHANGE_TEXT.threadOnly(true));
  await a.speak(message(), '로그인 화면 오타 고쳐 줘', { action: 'change', target: REPO.fullName, content: null }, { scope: notifyThread });
  await a.speak(message(), '로그인 화면 오타 고쳐 줘', { action: 'change', target: 'fixture-org/not-in-policy', content: null });
  assert.deepEqual((await a.dropped()).map(d => d.reason), ['target_denied', 'target_denied']);
  assert.equal(a.buttons().posted.length, 0);
  assert.equal((await database.db.query('SELECT id FROM change_requests')).rows.length, 0);
});

test('C14 / 변경 요청은 지금처럼 owner가 적은 label을 쓴다(적지 않으면 unknown으로 막힌다)', async () => {
  const a = await wired();
  const reply = (await a.slash('change', { target: REPO.fullName, text: '공개 요약 | accept=시험 통과' })).reply!;
  const id = (await database.db.query<{ id: string }>('SELECT id FROM change_requests')).rows[0]!.id;
  assert.equal(reply, CHANGE_TEXT.blocked(true, id, CHANGE_TEXT.blockedLabel(true, 'unknown')));
  assert.equal((await database.db.query<{ label: string }>('SELECT label FROM change_requests')).rows[0]!.label, 'unknown');
});

test('C14 변경 취소 제안은 이 스레드의 변경만 받고, 누르면 /change-cancel과 같은 처리로 취소한다', async () => {
  const a = await wired();
  await a.slash('change', { target: REPO.fullName, text: '공개 요약 | accept=시험 통과 | label=public' });
  const change = (await database.db.query<{ id: string }>('SELECT id FROM change_requests')).rows[0]!.id;
  await a.speak(message(), '그 변경 취소해 줘', { action: 'change_cancel', target: change, content: null });
  assert.equal(body(a.buttons().content), PROPOSAL_TEXT.changeCancelQuestion(change));
  assert.notEqual((await database.db.query<{ phase: string }>('SELECT phase FROM change_requests')).rows[0]!.phase, 'cancelled');
  await a.press(yesOf(a));
  assert.equal((await database.db.query<{ phase: string }>('SELECT phase FROM change_requests')).rows[0]!.phase, 'cancelled');
  assert.equal(String(a.lastCallback()!.data.content), CHANGE_TEXT.cancelled(true, change, false));
  await a.speak(message(), '없는 변경 취소', { action: 'change_cancel', target: 'fixture-unknown-change', content: null });
  assert.deepEqual((await a.dropped()).at(-1), { action: 'change_cancel', reason: 'target_denied' });
});
