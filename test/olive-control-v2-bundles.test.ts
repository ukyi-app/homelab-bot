import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  ACTIONS, adoptExecutionGeneration, assembleCandidate, CANDIDATE_CHUNK_MAX_BYTES, CANDIDATE_MAX_BYTES, CANDIDATE_MAX_CHUNKS,
  candidateDigestOf, MAX_MESSAGE_BYTES, seal, SealError, verify,
} from '../src/olive-control.js';
import type {
  CandidateChunkReply, CandidateFetchOutcome, Envelope, GenerationAuthority, Party, VerifyContext, VerifyOutcome,
} from '../src/olive-control.js';

// 입력·이벤트, 출력, 후보 내용 묶음의 표본 밖 경계. 키는 이 파일에서 새로 만든다(표본의 키와 무관). 실제 효과·네트워크·파일 쓰기 없음.
const KEYS: Record<Party, { publicKey: KeyObject; privateKey: KeyObject }> = {
  'front-door': generateKeyPairSync('ed25519'),
  supervisor: generateKeyPairSync('ed25519'),
};
const NOW = 1_800_000_000_000;
const other = (party: Party): Party => (party === 'front-door' ? 'supervisor' : 'front-door');
const uuidOf = (n: number): string => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const nonceOf = (n: number): string => n.toString(16).padStart(32, '0');
let counter = 0x900;
const fresh = (): number => ++counter;
const SHA = 'a'.repeat(64);
const REF = 'originals/' + uuidOf(1);

function context(recipient: Party, over: Partial<VerifyContext> = {}): VerifyContext & { consumed: string[] } {
  const consumed: string[] = [];
  return {
    now: NOW,
    expectedRecipient: recipient,
    publicKeyFor: (sender) => (sender === recipient ? undefined : KEYS[sender].publicKey),
    handshake: 'agreed',
    intakeOpen: true,
    generations: { stop: { known: true, current: 7, prepared: null }, execution: { known: true, current: 3, prepared: null } },
    awaiting: () => undefined,
    nonces: {
      consume(sender, nonce) {
        consumed.push(sender + ' ' + nonce);
        return true;
      },
    },
    consumed,
    ...over,
  };
}

function sealed(sender: Party, action: string, body: unknown): Envelope {
  const n = fresh();
  return seal({ sender, recipient: other(sender), action, requestId: uuidOf(n), nonce: nonceOf(n), issuedAt: NOW - 1_000, body },
    KEYS[sender].privateKey);
}

const reasonOf = (outcome: VerifyOutcome): string => (outcome.ok ? 'ok' : outcome.reason);
const sealFault = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SealError) return error.reason;
    throw error;
  }
  return 'sealed';
};
// 보내는 쪽의 seal과 받는 쪽의 verify가 같은 사유를 낸다(본문 단계의 거절). 통과면 둘 다 'ok'.
function judge(sender: Party, action: string, body: unknown, over: Partial<VerifyContext> = {}): string {
  const fault = sealFault(() => sealed(sender, action, body));
  if (fault !== 'sealed') return 'seal:' + fault;
  return reasonOf(verify(sealed(sender, action, body), context(other(sender), over)));
}

const SUBMIT = { job_id: uuidOf(10), stop_generation: 7, source: 'admin', source_ref: { ref: REF, digest: SHA, expires_at: NOW } };
const OUT_GENS = { stop_generation: 7, execution_generation: 3 };
const REPLY = { job_id: uuidOf(20), input_job_id: uuidOf(10), purpose: 'answer', candidate_digest: SHA, ...OUT_GENS };
const CARD = { job_id: uuidOf(21), input_job_id: uuidOf(10), candidate_digest: SHA, ...OUT_GENS };
const PUBLICATION = {
  job_id: uuidOf(22), kind: 'pull_request', candidate_digest: SHA, run_id: null, input_job_id: null, ...OUT_GENS,
};
const PROGRESS = { job_id: uuidOf(23), input_job_id: uuidOf(10), stage: 'patch', seq: 0, ...OUT_GENS };
const OUTPUTS: [string, Record<string, unknown>][] = [
  ['reply_candidate', REPLY], ['approval_card_request', CARD], ['publication_candidate', PUBLICATION], ['progress_update', PROGRESS],
];

// ---- 동작마다 통과하는 본문과 방향 ----

test('묶음 동작 열넷: 바른 쪽이 서명하면 통과해 nonce를 한 번 쓰고, 반대쪽은 만들 때부터 wrong_direction이다', () => {
  const lookups = (action: string, body: Record<string, unknown>) => () => ({ action, job: null, body });
  const cases: [Party, string, unknown, Partial<VerifyContext>][] = [
    ['front-door', 'input_submit', SUBMIT, {}],
    ['front-door', 'input_cancel', { job_id: uuidOf(11), input_job_id: uuidOf(10) }, {}],
    ['front-door', 'approval_changed', {
      job_id: uuidOf(12), stop_generation: 7, card_job_id: uuidOf(21), candidate_digest: SHA, seq: 1, state: 'expired',
    }, {}],
    ['front-door', 'publication_changed', {
      job_id: uuidOf(13), publication_job_id: uuidOf(22), candidate_digest: SHA, seq: 1, state: 'closed',
    }, {}],
    ['front-door', 'merge_observed', { job_id: uuidOf(14), publication_job_id: uuidOf(22), merge_commit: 'f'.repeat(40), merged_at: 1 }, {}],
    ['front-door', 'source_forgotten', { job_id: uuidOf(15), source_ref: REF }, {}],
    ['front-door', 'execution_generation_lookup', {}, {}],
    ['front-door', 'candidate_fetch', { candidate_digest: SHA, offset: 0 }, {}],
    ...OUTPUTS.map(([action, body]): [Party, string, unknown, Partial<VerifyContext>] => ['supervisor', action, body, {}]),
    ['supervisor', 'execution_generation_reply', { in_reply_to: uuidOf(30), generation: 1 }, {
      awaiting: () => ({ action: 'execution_generation_lookup', job: null }),
    }],
    ['supervisor', 'candidate_chunk', {
      in_reply_to: uuidOf(31), candidate_digest: SHA, offset: 0, piece: { state: 'unavailable' },
    }, { awaiting: lookups('candidate_fetch', { candidate_digest: SHA, offset: 0 }) }],
  ];
  assert.equal(cases.length, 14);
  const covered = new Set(cases.map(([, action]) => action));
  for (const [name, spec] of ACTIONS) if (spec.bundle !== 'common' && spec.bundle !== 'stop') assert.ok(covered.has(name), name);
  for (const [sender, action, body, over] of cases) {
    const ctx = context(other(sender), over);
    const outcome = verify(sealed(sender, action, body), ctx);
    assert.equal(reasonOf(outcome), 'ok', action);
    assert.equal(ctx.consumed.length, 1, action);
    if (outcome.ok) assert.equal(outcome.job === null, ACTIONS.get(action)!.class !== 'effect', action);
    assert.equal(sealFault(() => sealed(other(sender), action, body)), 'wrong_direction', action);
  }
});

// ---- 출력의 세대와 접수 ----

test('출력 넷: 정지·실행 세대가 현관의 지금 값과 같아야 하고, 모르면 generation_unknown, 닫힌 접수에서는 intake_closed다', () => {
  for (const [action, body] of OUTPUTS) {
    assert.equal(judge('supervisor', action, body), 'ok', action);
    for (const [stop, execution] of [[6, 3], [8, 3], [7, 2], [7, 4]]) {
      const ctx = context('front-door');
      const outcome = verify(sealed('supervisor', action, { ...body, stop_generation: stop, execution_generation: execution }), ctx);
      assert.equal(reasonOf(outcome), 'generation_mismatch', `${action} ${stop}/${execution}`);
      assert.deepEqual(ctx.consumed, []);
    }
    const unknown = { stop: { known: true, current: 7, prepared: null }, execution: { known: false } } as const;
    assert.equal(judge('supervisor', action, body, { generations: unknown }), 'generation_unknown', action);
    // 받아 둔 준비가 있어도 current는 지금 값만 본다.
    const prepared = { stop: { known: true, current: 7, prepared: 8 }, execution: { known: true, current: 3, prepared: null } } as const;
    assert.equal(judge('supervisor', action, body, { generations: prepared }), 'ok', action);
    assert.equal(judge('supervisor', action, body, { intakeOpen: false }), 'intake_closed', action);
    assert.equal(judge('supervisor', action, body, { handshake: 'policy_mismatch' }), 'policy_mismatch', action);
    const { execution_generation: _dropped, ...withoutExecution } = body;
    assert.equal(judge('supervisor', action, withoutExecution), 'seal:generation_missing', action);
  }
});

test('입력·취소·사실의 세대와 접수: 취소와 세대 없는 사실 셋은 세대를 몰라도, 접수가 닫혀도 받는다', () => {
  const blind = { stop: { known: false }, execution: { known: false } } as const;
  const free: [string, unknown][] = [
    ['input_cancel', { job_id: uuidOf(11), input_job_id: uuidOf(10) }],
    ['publication_changed', { job_id: uuidOf(13), publication_job_id: uuidOf(22), candidate_digest: SHA, seq: 2, state: 'posted' }],
    ['merge_observed', { job_id: uuidOf(14), publication_job_id: uuidOf(22), merge_commit: '0'.repeat(40), merged_at: NOW }],
    ['source_forgotten', { job_id: uuidOf(15), source_ref: REF }],
  ];
  for (const [action, body] of free) {
    assert.equal(judge('front-door', action, body, { generations: blind, intakeOpen: false }), 'ok', action);
    assert.equal(judge('front-door', action, { ...(body as object), stop_generation: 7 }), 'seal:body_malformed', action);
    assert.equal(judge('front-door', action, body, { handshake: 'policy_mismatch' }), 'policy_mismatch', action);
  }
  assert.equal(judge('front-door', 'input_submit', SUBMIT, { generations: blind }), 'generation_unknown');
  assert.equal(judge('front-door', 'input_submit', { ...SUBMIT, stop_generation: 8 }), 'generation_mismatch');
  assert.equal(judge('front-door', 'input_submit', SUBMIT, { intakeOpen: false }), 'intake_closed');
});

// ---- 본문의 꼴 ----

test('입력·이벤트 본문의 경계: 원문 참조의 꼴, 순번, 병합 커밋·시각, 잊기의 참조는 글 하나', () => {
  const submit = (sourceRef: unknown) => judge('front-door', 'input_submit', { ...SUBMIT, source_ref: sourceRef });
  const ref = (repository: string) => repository + '/' + uuidOf(2);
  assert.equal(submit({ ref: ref('a'), digest: SHA, expires_at: 1 }), 'ok');
  assert.equal(submit({ ref: REF, digest: SHA, expires_at: 0 }), 'seal:body_malformed');
  assert.equal(submit({ ref: ref('a' + 'b'.repeat(31)), digest: SHA, expires_at: NOW }), 'ok');
  for (const bad of ['a' + 'b'.repeat(32), 'Originals', '1originals', 'orig_inals', '']) {
    assert.equal(submit({ ref: ref(bad), digest: SHA, expires_at: NOW }), 'seal:body_malformed', bad);
  }
  assert.equal(submit({ ref: REF.toUpperCase(), digest: SHA, expires_at: NOW }), 'seal:body_malformed');
  assert.equal(submit({ ref: REF, digest: SHA.toUpperCase(), expires_at: NOW }), 'seal:body_malformed');
  assert.equal(submit({ ref: REF, digest: SHA, expires_at: -1 }), 'seal:body_malformed');
  assert.equal(submit({ ref: REF, digest: SHA, expires_at: null }), 'seal:body_malformed');
  // 금지 이름이 아닌 글 칸은 닫힌 객체라 unknown_field, 원문 이름은 어느 깊이에서든 forbidden_field다.
  assert.equal(submit({ ref: REF, digest: SHA, expires_at: NOW, text: 'x' }), 'seal:unknown_field');
  assert.equal(submit({ ref: REF, digest: SHA, expires_at: NOW, 'Raw Text': 'x' }), 'seal:forbidden_field');

  const approval = (over: Record<string, unknown>) => judge('front-door', 'approval_changed', {
    job_id: uuidOf(12), stop_generation: 7, card_job_id: uuidOf(21), candidate_digest: SHA, seq: 1, state: 'approved', ...over,
  });
  assert.equal(approval({ seq: 0 }), 'seal:body_malformed');
  assert.equal(approval({ state: 'invalidated' }), 'ok');
  // 승인 이름은 현관이 낸 본문에서는 금지 이름이 아니다: 닫힌 객체라 unknown_field다.
  assert.equal(approval({ approved: true }), 'seal:unknown_field');

  const merge = (over: Record<string, unknown>) => judge('front-door', 'merge_observed', {
    job_id: uuidOf(14), publication_job_id: uuidOf(22), merge_commit: 'e'.repeat(40), merged_at: NOW, ...over,
  });
  assert.equal(merge({ merged_at: 0 }), 'seal:body_malformed');
  assert.equal(merge({ merge_commit: 'e'.repeat(39) }), 'seal:body_malformed');
  assert.equal(merge({ merge_commit: 'E'.repeat(40) }), 'seal:body_malformed');
  assert.equal(merge({ merge_commit: 'e'.repeat(64) }), 'seal:body_malformed');

  assert.equal(judge('front-door', 'source_forgotten', { job_id: uuidOf(15), source_ref: { ref: REF, digest: SHA, expires_at: NOW } }),
    'seal:body_malformed');
  assert.equal(judge('front-door', 'input_cancel', { job_id: uuidOf(11), input_job_id: null }), 'seal:body_malformed');
});

test('출력 본문의 경계: 목적·종류·단계와 멈춤 이유, null을 받는 칸, 목적지·내용 칸', () => {
  assert.equal(judge('supervisor', 'reply_candidate', { ...REPLY, purpose: 'start' }), 'ok');
  assert.equal(judge('supervisor', 'reply_candidate', { ...REPLY, purpose: 'final' }), 'seal:body_malformed');
  assert.equal(judge('supervisor', 'reply_candidate', { ...REPLY, input_job_id: null }), 'seal:body_malformed');
  for (const kind of ['pull_request', 'pull_request_review', 'knowledge_pull_request']) {
    assert.equal(judge('supervisor', 'publication_candidate', { ...PUBLICATION, kind, run_id: uuidOf(5), input_job_id: uuidOf(6) }),
      'ok', kind);
  }
  assert.equal(judge('supervisor', 'publication_candidate', { ...PUBLICATION, kind: 'issue' }), 'seal:body_malformed');
  const { run_id: _run, ...withoutRun } = PUBLICATION;
  assert.equal(judge('supervisor', 'publication_candidate', withoutRun), 'seal:body_malformed');
  for (const stage of ['cause', 'patch', 'verify', 'pull_request', 'done']) {
    assert.equal(judge('supervisor', 'progress_update', { ...PROGRESS, stage }), 'ok', stage);
    assert.equal(judge('supervisor', 'progress_update', { ...PROGRESS, stage, stop_cause: 'deadline' }), 'seal:unknown_field', stage);
  }
  for (const cause of ['deadline', 'budget_exhausted', 'cancelled', 'input_expired', 'launch_refused', 'worker_failed',
    'result_rejected', 'verification_failed', 'executor_lost']) {
    assert.equal(judge('supervisor', 'progress_update', { ...PROGRESS, stage: 'stopped', stop_cause: cause }), 'ok', cause);
  }
  assert.equal(judge('supervisor', 'progress_update', { ...PROGRESS, stage: 'stopped', stop_cause: 'emergency_stop' }),
    'seal:body_malformed');
  assert.equal(judge('supervisor', 'progress_update', { ...PROGRESS, seq: -1 }), 'seal:body_malformed');
  // 감독이 낸 본문에서 목적지 이름은 금지, 후보 내용 칸(chunk_b64url)은 조각 답 밖에서 모르는 칸이다.
  assert.equal(judge('supervisor', 'reply_candidate', { ...REPLY, webhook_url: 'x' }), 'seal:forbidden_field');
  for (const [action, body] of OUTPUTS) {
    assert.equal(judge('supervisor', action, { ...body, chunk_b64url: 'YQ' }), 'seal:unknown_field', action);
  }
  assert.equal(judge('front-door', 'input_submit', { ...SUBMIT, chunk_b64url: 'YQ' }), 'seal:unknown_field');
  assert.equal(judge('front-door', 'execution_generation_lookup', { generation: 1 }), 'seal:unknown_field');
  assert.equal(judge('front-door', 'execution_generation_lookup', null), 'seal:body_malformed');
});

// ---- 확정 결과 ----

function answered(action: string, result: unknown): string {
  const job = { job_id: uuidOf(40), action, request_digest: SHA };
  const sender = ACTIONS.get(action)!.from.includes('front-door') ? 'supervisor' : 'front-door';
  return judge(sender, 'job_status', { in_reply_to: uuidOf(41), ...job, status: { state: 'confirmed', result } }, {
    awaiting: () => ({ action, job }),
  });
}

test('확정 결과: 갈래가 여럿이면 outcome 값을 먼저, 하나면 모르는 칸을 먼저 본다. 게시됨은 PR 번호를 반드시 싣는다', () => {
  const table: [string, string[]][] = [
    ['input_submit', ['queued', 'refused']], ['input_cancel', ['cancelled', 'not_found']], ['approval_changed', ['recorded']],
    ['publication_changed', ['recorded']], ['merge_observed', ['recorded']], ['source_forgotten', ['recorded']],
    ['reply_candidate', ['posted', 'refused']], ['approval_card_request', ['shown', 'refused']],
    ['progress_update', ['shown', 'superseded', 'refused']],
  ];
  for (const [action, outcomes] of table) {
    for (const outcome of outcomes) {
      assert.equal(answered(action, { outcome }), 'ok', action + ' ' + outcome);
      assert.equal(answered(action, { outcome, note: 1 }), 'seal:unknown_field', action + ' ' + outcome);
    }
    assert.equal(answered(action, { outcome: 'other', note: 1 }), outcomes.length === 1 ? 'seal:unknown_field' : 'seal:body_malformed',
      action);
    assert.equal(answered(action, { outcome: 'approved' }), 'seal:body_malformed', action);
  }
  assert.equal(answered('publication_candidate', { outcome: 'posted', pr_number: 1 }), 'ok');
  assert.equal(answered('publication_candidate', { outcome: 'posted', pr_number: Number.MAX_SAFE_INTEGER }), 'ok');
  assert.equal(answered('publication_candidate', { outcome: 'not_posted' }), 'ok');
  assert.equal(answered('publication_candidate', { outcome: 'posted', pr_number: 0 }), 'seal:body_malformed');
  assert.equal(answered('publication_candidate', { outcome: 'posted', pr_number: 1.5 }), 'seal:body_malformed');
  assert.equal(answered('publication_candidate', { outcome: 'not_posted', pr_number: 3 }), 'seal:unknown_field');
  // 감독이 답하는 현관의 사실에 승인 이름: 감독이 낸 본문이라 forbidden_field다.
  assert.equal(answered('approval_changed', { outcome: 'recorded', approval: 'yes' }), 'seal:forbidden_field');
});

// ---- 후보 내용: 묻기와 조각 ----

const CHUNK_MAX = CANDIDATE_CHUNK_MAX_BYTES;
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fetchBody = (digest: string, offset: number) => ({ candidate_digest: digest, offset });
// 기다리는 요청에 묻기의 본문을 보관하지 않은 경우.
const NO_BODY = Symbol('no body');
function chunkJudge(offset: number, piece: unknown, asked: unknown = fetchBody(SHA, offset), action = 'candidate_fetch'): string {
  return judge('supervisor', 'candidate_chunk', { in_reply_to: uuidOf(50), candidate_digest: SHA, offset, piece }, {
    awaiting: () => (asked === NO_BODY ? { action, job: null } : { action, job: null, body: asked }),
  });
}

test('묻기의 위치는 0 이상 1MiB 미만이고, 조각 답은 32KiB 이하·total 1MiB 이하·자기 total 안이다', () => {
  assert.equal(judge('front-door', 'candidate_fetch', fetchBody(SHA, CANDIDATE_MAX_BYTES - 1)), 'ok');
  assert.equal(judge('front-door', 'candidate_fetch', fetchBody(SHA, CANDIDATE_MAX_BYTES)), 'seal:body_malformed');
  assert.equal(judge('front-door', 'candidate_fetch', fetchBody(SHA, -1)), 'seal:body_malformed');
  assert.equal(judge('front-door', 'candidate_fetch', fetchBody(SHA.toUpperCase(), 0)), 'seal:body_malformed');

  const full = new Uint8Array(CHUNK_MAX).fill(7);
  assert.equal(chunkJudge(0, { state: 'chunk', total: CHUNK_MAX, chunk_b64url: b64(full) }), 'ok');
  assert.equal(chunkJudge(0, { state: 'chunk', total: CHUNK_MAX + 1, chunk_b64url: b64(new Uint8Array(CHUNK_MAX + 1)) }),
    'seal:body_malformed');
  assert.equal(chunkJudge(CANDIDATE_MAX_BYTES - CHUNK_MAX, { state: 'chunk', total: CANDIDATE_MAX_BYTES, chunk_b64url: b64(full) }),
    'ok');
  assert.equal(chunkJudge(0, { state: 'chunk', total: CANDIDATE_MAX_BYTES + 1, chunk_b64url: 'YQ' }), 'seal:body_malformed');
  assert.equal(chunkJudge(0, { state: 'chunk', total: 0, chunk_b64url: 'YQ' }), 'seal:body_malformed');
  assert.equal(chunkJudge(2, { state: 'chunk', total: 3, chunk_b64url: 'YQ' }), 'ok');
  assert.equal(chunkJudge(3, { state: 'chunk', total: 3, chunk_b64url: 'YQ' }), 'seal:body_malformed');
  assert.equal(chunkJudge(2, { state: 'chunk', total: 3, chunk_b64url: 'YWE' }), 'seal:body_malformed');
  // 표기는 하나만: 남는 비트(YR), 4로 나눠 1이 남는 길이(Y), 빈 글, 패딩, 표준 base64 글자.
  for (const text of ['YR', 'Y', '', 'YQ==', 'YQ=', '+/8', 'YQ ']) {
    assert.equal(chunkJudge(0, { state: 'chunk', total: 44, chunk_b64url: text }), 'seal:body_malformed', JSON.stringify(text));
  }
  assert.equal(chunkJudge(0, { state: 'chunk', total: 44, chunk_b64url: '-_8' }), 'ok');
  assert.equal(chunkJudge(0, { state: 'unavailable', total: 1 }), 'seal:unknown_field');
  assert.equal(chunkJudge(0, { state: 'chunk', total: 44 }), 'seal:body_malformed');
});

test('가장 큰 조각의 봉투도 바이트 틀(64KiB) 안에 든다', () => {
  const env = sealed('supervisor', 'candidate_chunk', {
    in_reply_to: uuidOf(51), candidate_digest: SHA, offset: CANDIDATE_MAX_BYTES - CHUNK_MAX,
    piece: { state: 'chunk', total: CANDIDATE_MAX_BYTES, chunk_b64url: b64(new Uint8Array(CHUNK_MAX).fill(255)) },
  });
  const size = Buffer.byteLength(JSON.stringify(env), 'utf8');
  assert.ok(size <= MAX_MESSAGE_BYTES, String(size));
  assert.equal(Math.ceil((CHUNK_MAX * 4) / 3), 43_691);
});

test('조각 답은 물은 digest·위치를 되풀이하고, 묻기의 본문을 보관한 기다리는 candidate_fetch에만 맞는다', () => {
  const piece = { state: 'unavailable' };
  assert.equal(chunkJudge(0, piece), 'ok');
  assert.equal(chunkJudge(0, piece, fetchBody(SHA, 1)), 'reply_mismatch');
  assert.equal(chunkJudge(0, piece, fetchBody('b'.repeat(64), 0)), 'reply_mismatch');
  assert.equal(chunkJudge(0, piece, NO_BODY), 'reply_mismatch');
  assert.equal(chunkJudge(0, piece, null), 'reply_mismatch');
  assert.equal(chunkJudge(0, piece, { candidate_digest: SHA, offset: '0' }), 'reply_mismatch');
  assert.equal(chunkJudge(0, piece, fetchBody(SHA, 0), 'execution_generation_lookup'), 'reply_mismatch');
  // 실행 세대 답은 기다리는 실행 세대 조회만 가리킨다.
  const reply = { in_reply_to: uuidOf(52), generation: 4 };
  assert.equal(judge('supervisor', 'execution_generation_reply', reply, {
    awaiting: () => ({ action: 'candidate_fetch', job: null, body: fetchBody(SHA, 0) }),
  }), 'reply_mismatch');
  assert.equal(judge('supervisor', 'execution_generation_reply', { ...reply, generation: 0 }), 'seal:body_malformed');
});

// ---- 후보 내용의 조립 ----

const content = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
};
const piece = (digest: string, offset: number, total: number, bytes: Uint8Array): CandidateFetchOutcome => ({
  answered: true,
  reply: { in_reply_to: uuidOf(60), candidate_digest: digest, offset, piece: { state: 'chunk', total, chunk_b64url: b64(bytes) } },
});
// 내용을 size바이트 조각으로 나눠 위치마다의 답을 만든다.
function split(bytes: Uint8Array, size: number, digest = candidateDigestOf(bytes)): CandidateFetchOutcome[] {
  const outcomes: CandidateFetchOutcome[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    outcomes.push(piece(digest, offset, bytes.length, bytes.subarray(offset, offset + size)));
  }
  return outcomes;
}
const kindOf = (assembly: ReturnType<typeof assembleCandidate>): string =>
  assembly.kind === 'rejected' ? 'rejected:' + assembly.fault : assembly.kind === 'unknown' ? 'unknown:' + assembly.cause : assembly.kind;

test('candidateDigestOf는 바이트 그대로의 SHA-256이다(정규화 없음)', () => {
  const crlf = Buffer.from('a\r\nb', 'utf8');
  assert.equal(candidateDigestOf(crlf), createHash('sha256').update(crlf).digest('hex'));
  assert.notEqual(candidateDigestOf(crlf), candidateDigestOf(Buffer.from('a\nb', 'utf8')));
  // 같은 글자의 NFC와 NFD는 다른 바이트라 다른 digest다.
  assert.notEqual(candidateDigestOf(Buffer.from('\u00e9')), candidateDigestOf(Buffer.from('e\u0301')));
});

test('조립: 0부터 total까지 빈틈·겹침 없이 이어지고 바이트의 SHA-256이 같을 때만 complete', () => {
  const one = content(44);
  const single = assembleCandidate(candidateDigestOf(one), split(one, CHUNK_MAX));
  assert.equal(kindOf(single), 'complete');
  if (single.kind === 'complete') assert.deepEqual(Buffer.from(single.bytes), Buffer.from(one));
  const three = content(100);
  const assembled = assembleCandidate(candidateDigestOf(three), split(three, 40));
  assert.equal(kindOf(assembled), 'complete');
  if (assembled.kind === 'complete') assert.deepEqual(Buffer.from(assembled.bytes), Buffer.from(three));
  // 조각이 모두 맞게 이어져도 내용이 다르면 받지 않는다.
  const forged = content(100);
  forged[50] = forged[50]! ^ 1;
  assert.equal(kindOf(assembleCandidate(candidateDigestOf(three), split(forged, 40, candidateDigestOf(three)))),
    'rejected:digest_mismatch');
});

test('조립: 1MiB는 32조각으로 complete, 33조각은 too_many_chunks, 32조각에서 total에 못 닿으면 gap', () => {
  const max = content(CANDIDATE_MAX_BYTES);
  const outcomes = split(max, CHUNK_MAX);
  assert.equal(outcomes.length, CANDIDATE_MAX_CHUNKS);
  assert.equal(kindOf(assembleCandidate(candidateDigestOf(max), outcomes)), 'complete');
  const small = content(33);
  assert.equal(kindOf(assembleCandidate(candidateDigestOf(small), split(small, 1))), 'rejected:too_many_chunks');
  assert.equal(kindOf(assembleCandidate(candidateDigestOf(small), split(small, 1).slice(0, 32))), 'rejected:gap');
  // 조각 수는 이어짐보다 먼저 본다: 33조각이 겹쳐도 too_many_chunks다.
  const crowded = split(small, 1);
  crowded[1] = piece(candidateDigestOf(small), 0, 33, small.subarray(0, 1));
  assert.equal(kindOf(assembleCandidate(candidateDigestOf(small), crowded)), 'rejected:too_many_chunks');
});

test('조립: 이어짐의 결함(크기 → 순서 → 겹침 → 빠짐)과 그 앞의 꼴·다른 후보·줄 수 없음·답 없음', () => {
  const bytes = content(90);
  const digest = candidateDigestOf(bytes);
  const at = (offset: number, length: number, total = 90) => piece(digest, offset, total, bytes.subarray(offset, offset + length));
  const run = (outcomes: unknown[]) => kindOf(assembleCandidate(digest, outcomes as CandidateFetchOutcome[]));
  assert.equal(run([at(0, 30), at(30, 30), at(60, 30)]), 'complete');
  assert.equal(run([]), 'rejected:gap');
  assert.equal(run([at(30, 30), at(60, 30)]), 'rejected:gap');
  assert.equal(run([at(0, 30), at(60, 30)]), 'rejected:gap');
  assert.equal(run([at(0, 30), at(30, 30)]), 'rejected:gap');
  assert.equal(run([at(0, 30), at(20, 30), at(50, 40)]), 'rejected:overlap');
  assert.equal(run([at(0, 30), at(0, 30), at(30, 60)]), 'rejected:overlap');
  assert.equal(run([at(0, 30), at(60, 30), at(30, 30)]), 'rejected:order');
  // 순서는 위치와 무관하게 빠짐보다 먼저 본다.
  assert.equal(run([at(0, 10), at(40, 10), at(30, 10)]), 'rejected:order');
  assert.equal(run([at(0, 30, 90), at(30, 30, 91), at(60, 30, 90)]), 'rejected:size_mismatch');
  assert.equal(run([at(60, 30), at(0, 30, 91)]), 'rejected:size_mismatch');

  const unavailable = { answered: true, reply: { in_reply_to: uuidOf(61), candidate_digest: digest, offset: 30, piece: { state: 'unavailable' } } };
  const timeout = { answered: false, cause: 'timeout' };
  assert.equal(run([at(0, 30), unavailable, timeout]), 'unavailable');
  assert.equal(run([timeout, at(0, 30), unavailable]), 'unavailable');
  assert.equal(run([at(0, 30), { answered: false, cause: 'disconnected' }, timeout]), 'unknown:disconnected');
  assert.equal(run([at(0, 30), { answered: false, cause: 'reply_rejected' }]), 'unknown:reply_rejected');

  const other = piece('b'.repeat(64), 0, 90, bytes.subarray(0, 30));
  assert.equal(run([other, unavailable]), 'rejected:other_candidate');
  assert.equal(run([unavailable, other]), 'rejected:other_candidate');
  const pastTotal = piece(digest, 80, 90, bytes.subarray(0, 30));
  for (const bad of [pastTotal, { answered: false, cause: 'gone' }, { answered: true }, null, { answered: 'yes', reply: {} },
    { answered: false, cause: 'timeout', note: 1 },
    { answered: true, reply: { ...(at(0, 30) as { reply: CandidateChunkReply }).reply, extra: 1 } }]) {
    assert.equal(run([at(0, 30), bad, unavailable]), 'rejected:malformed', JSON.stringify(bad));
  }
  assert.equal(kindOf(assembleCandidate('B'.repeat(64), [at(0, 90)])), 'rejected:malformed');
  assert.equal(kindOf(assembleCandidate(digest, null as unknown as CandidateFetchOutcome[])), 'rejected:malformed');
});

test('출력 → 내용 묻기 → 조각 답 → 조립: 답 글 후보의 digest로 물어 받은 조각을 이으면 그 내용이다', () => {
  const text = Buffer.from('시험용 답 글입니다. '.repeat(3_000), 'utf8');
  assert.ok(text.length > 2 * CHUNK_MAX && text.length <= 3 * CHUNK_MAX, String(text.length));
  const digest = candidateDigestOf(text);
  assert.equal(reasonOf(verify(sealed('supervisor', 'reply_candidate', { ...REPLY, candidate_digest: digest }), context('front-door'))),
    'ok');
  const outcomes: CandidateFetchOutcome[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_MAX) {
    const ask = sealed('front-door', 'candidate_fetch', { candidate_digest: digest, offset });
    assert.equal(reasonOf(verify(ask, context('supervisor'))), 'ok');
    const answer = verify(sealed('supervisor', 'candidate_chunk', {
      in_reply_to: ask.header.request_id, candidate_digest: digest, offset,
      piece: { state: 'chunk', total: text.length, chunk_b64url: b64(text.subarray(offset, offset + CHUNK_MAX)) },
    }), context('front-door', {
      awaiting: (id) => (id === ask.header.request_id ? { action: 'candidate_fetch', job: null, body: ask.body } : undefined),
    }));
    assert.equal(reasonOf(answer), 'ok');
    if (answer.ok) outcomes.push({ answered: true, reply: answer.body as CandidateChunkReply });
  }
  assert.equal(outcomes.length, 3);
  const assembled = assembleCandidate(digest, outcomes);
  assert.equal(kindOf(assembled), 'complete');
  if (assembled.kind === 'complete') assert.equal(Buffer.from(assembled.bytes).toString('utf8'), text.toString('utf8'));
});

// ---- 실행 세대 받기 ----

test('실행 세대 받기: 모르면 쓰고, 같거나 크면 올리고, 작으면 낮추지 않고 regressed, 1 미만·답 없음은 그대로', () => {
  const unknown: GenerationAuthority = { known: false };
  const known: GenerationAuthority = { known: true, current: 4, prepared: null };
  const adopt = (previous: GenerationAuthority, outcome: unknown) =>
    adoptExecutionGeneration(previous, outcome as Parameters<typeof adoptExecutionGeneration>[1]);
  assert.deepEqual(adopt(unknown, { answered: true, generation: 1 }), {
    authority: { known: true, current: 1, prepared: null }, regressed: false,
  });
  assert.deepEqual(adopt(known, { answered: true, generation: 4 }), { authority: known, regressed: false });
  assert.deepEqual(adopt(known, { answered: true, generation: 9 }), {
    authority: { known: true, current: 9, prepared: null }, regressed: false,
  });
  assert.deepEqual(adopt(known, { answered: true, generation: 3 }), { authority: known, regressed: true });
  for (const generation of [0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.deepEqual(adopt(known, { answered: true, generation }), { authority: known, regressed: false }, String(generation));
    assert.deepEqual(adopt(unknown, { answered: true, generation }), { authority: unknown, regressed: false }, String(generation));
  }
  for (const cause of ['timeout', 'disconnected', 'reply_rejected']) {
    assert.deepEqual(adopt(known, { answered: false, cause }), { authority: known, regressed: false });
    assert.deepEqual(adopt(unknown, { answered: false, cause }), { authority: unknown, regressed: false });
  }
  // 두 길(풀기 확정, 조회 답)의 값이 어긋나도 큰 값이 남는다.
  const afterRelease = adopt(known, { answered: true, generation: 5 }).authority;
  const late = adopt(afterRelease, { answered: true, generation: 4 });
  assert.deepEqual(late, { authority: afterRelease, regressed: true });
  // 받아들인 값이 곧 출력 효과의 current 검사에 쓰인다.
  const generations = { stop: { known: true, current: 7, prepared: null }, execution: afterRelease } as const;
  assert.equal(judge('supervisor', 'reply_candidate', { ...REPLY, execution_generation: 5 }, { generations }), 'ok');
  assert.equal(judge('supervisor', 'reply_candidate', { ...REPLY, execution_generation: 4 }, { generations }), 'generation_mismatch');
});
