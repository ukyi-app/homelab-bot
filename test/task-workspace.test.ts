import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ArchiveError } from '../src/review-input.js';
import { TaskChangeSchema, TaskResponseSchema } from '../src/task-contracts.js';
import { TaskSessions, TaskWorkspaceError, parseTaskArchive, symlinkEscapes } from '../src/task-workspace.js';
import type { TaskSession } from '../src/task-workspace.js';
import { LIMITS, ROOT, SHA, WORKER, archive, paxRecord, resumeRequest, startRequest, tarBytes, tarGz } from './task-fixtures.js';
import type { TarItem } from './task-fixtures.js';

const scratch = await realpath(await mkdtemp(join(tmpdir(), 't18-workspace-')));
after(async () => { await rm(scratch, { recursive: true, force: true }); });
const fresh = async (options: { maxSessions?: number; volumeBytes?: number } = {}) => {
  const root = await mkdtemp(join(scratch, 'state-'));
  return { root, sessions: new TaskSessions(root, { storage: WORKER.storage, homes: ['/nonexistent-home'], ...options }) };
};
const signal = () => new AbortController().signal;
const limits = { files: LIMITS.files, fileBytes: LIMITS.fileBytes };
const rejected = (items: readonly TarItem[], reason: string, name?: string) =>
  assert.rejects(parseTaskArchive(archive(items), limits), (error: ArchiveError) => error instanceof ArchiveError && error.message === reason, name ?? reason);

test('압축본 음성: 경로 탈출과 이름 속임을 쓰기 전에 거부한다', async () => {
  await assert.rejects(parseTaskArchive(tarGz([{ name: '/etc/passwd' }]), limits), { message: 'archive_path' });
  await rejected([{ name: '../outside' }], 'archive_path', '상위 이동');
  await rejected([{ name: 'a/../../outside' }], 'archive_path', '중간 상위 이동');
  await rejected([{ name: 'a/./b' }], 'archive_path', '점 칸');
  await rejected([{ name: 'a//b' }], 'archive_path', '빈 칸');
  await rejected([{ name: 'a\nb' }], 'archive_path', '제어 문자');
  await rejected([{ name: 'same' }, { name: 'same' }], 'archive_duplicate');
  await rejected([{ name: 'dir', type: '5' }, { name: 'dir', type: '5' }], 'archive_duplicate', '디렉터리 중복');
  await rejected([{ name: 'file' }, { name: 'file/inner' }], 'archive_path', '파일 아래 항목');
  await assert.rejects(parseTaskArchive(tarGz([{ name: `${ROOT}/`, type: '5' }, { name: 'other-root/file' }]), limits), { message: 'archive_path' });
  // 파일이 뿌리 자리에 오는 꼴.
  await assert.rejects(parseTaskArchive(tarGz([{ name: 'plain-file' }]), limits), { message: 'archive_path' });
});

test('압축본 음성: .git은 어느 깊이·어느 대소문자로도 받지 않는다', async () => {
  await rejected([{ name: '.git/config', data: '[core]\n' }], 'archive_git');
  await rejected([{ name: '.git', type: '5' }], 'archive_git', '.git 디렉터리');
  await rejected([{ name: '.GIT/hooks/x' }], 'archive_git', '대문자');
  await rejected([{ name: 'sub/.git/config' }], 'archive_git', '중첩');
});

test('압축본 음성: 일반 파일·디렉터리·안쪽 심링크 밖의 종류를 거부한다', async () => {
  for (const [type, label] of [['1', 'hardlink'], ['3', 'char'], ['4', 'block'], ['6', 'fifo'], ['7', 'contiguous'], ['L', 'gnu long'], ['S', 'sparse']] as const) {
    await rejected([{ name: 'odd', type, link: type === '1' ? 'other' : '' }], 'archive_type', label);
  }
});

test('압축본 음성: 바깥을 가리키는 심링크와 심링크를 거치는 항목을 거부한다', async () => {
  await rejected([{ name: 'link', type: '2', link: '/etc/passwd' }], 'archive_symlink', '절대 경로');
  await rejected([{ name: 'link', type: '2', link: '../outside' }], 'archive_symlink', '상위 이동');
  await rejected([{ name: 'dir/link', type: '2', link: '../../outside' }], 'archive_symlink', '디렉터리 안 상위 이동');
  // 글자로 정규화하면 안쪽으로 보이지만 실제로 따라가면 바깥이다.
  await rejected([{ name: 'x', type: '5' }, { name: 'x/up', type: '2', link: '..' }, { name: 'out', type: '2', link: 'x/up/..' }], 'archive_symlink', '경유 탈출');
  await rejected([{ name: 'a', type: '2', link: 'b' }, { name: 'b', type: '2', link: 'a' }], 'archive_symlink', '순환');
  await rejected([{ name: 'link', type: '2', link: '.git/config' }], 'archive_symlink', '.git 가리킴');
  await rejected([{ name: 'link', type: '2', link: 'target' }, { name: 'link/file' }], 'archive_path', '심링크 아래 항목');
  await rejected([{ name: 'link/file' }, { name: 'link', type: '2', link: 'target' }], 'archive_path', '순서를 바꿔도 거부');
  await rejected([{ name: 'empty', type: '2' }], 'archive_symlink', '빈 대상');
});

test('압축본 음성: pax로 이름·크기를 속이지 못하고, 깨진 tar는 받지 않는다', async () => {
  await rejected([{ name: 'pax', type: 'x', data: paxRecord('path', `${ROOT}/../outside`) }, { name: 'plain' }], 'archive_path', 'pax path 탈출');
  await rejected([{ name: 'pax', type: 'x', data: paxRecord('size', '9') }, { name: 'plain' }], 'archive_type', 'pax size');
  await rejected([{ name: 'pax', type: 'x', data: paxRecord('linkpath', '/etc/passwd') }, { name: 'l', type: '2', link: 'safe' }], 'archive_symlink', 'pax linkpath');
  await rejected([{ name: 'pax', type: 'g', data: paxRecord('path', 'evil') }], 'archive_type', '전역 path');
  await rejected([{ name: 'pax', type: 'x', data: 'not-a-record' }, { name: 'plain' }], 'archive_unreadable', '깨진 pax');
  await rejected([{ name: 'plain', badChecksum: true }], 'archive_unreadable', '체크섬');
  await assert.rejects(parseTaskArchive(tarGz([{ name: `${ROOT}/`, type: '5' }], { end: false }), limits), { message: 'archive_unreadable' }, '끝 표시 없음');
  const raw = tarBytes([{ name: `${ROOT}/`, type: '5' }, { name: `${ROOT}/big`, data: 'x'.repeat(1000) }]);
  await assert.rejects(parseTaskArchive(gzipSync(raw.subarray(0, 700)), limits), { message: 'archive_unreadable' }, '내용 잘림');
  await assert.rejects(parseTaskArchive(Buffer.from('not gzip'), limits), { message: 'archive_unreadable' });
});

test('압축본 음성: 파일 수·파일 크기·압축 폭탄 상한', async () => {
  await assert.rejects(parseTaskArchive(archive([{ name: 'big', data: 'x'.repeat(11) }]), { files: 10, fileBytes: 10 }), { message: 'archive_limit' });
  await assert.rejects(parseTaskArchive(archive([{ name: 'a' }, { name: 'b' }]), { files: 1, fileBytes: 10 }), { message: 'archive_limit' });
  // 해제 뒤 크기가 상한을 넘으면 메모리에 올리기 전에 멈춘다.
  const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024);
  await assert.rejects(parseTaskArchive(bomb, { files: 1000, fileBytes: 2_000_000 }), { message: 'archive_limit' });
});

test('심링크 판정: 안쪽 경유와 끝없는 대상은 받는다', () => {
  const links = new Map([['dir/up', '..']]);
  assert.equal(symlinkEscapes('ok', 'dir/file', links), false);
  assert.equal(symlinkEscapes('dir/ok', '../file', links), false);
  assert.equal(symlinkEscapes('ok', 'dir/up/file', links), false);
  assert.equal(symlinkEscapes('ok', 'missing/later', links), false);
  assert.equal(symlinkEscapes('out', 'dir/up/..', links), true);
});

const GOOD: readonly TarItem[] = [
  { name: 'README.md', data: 'hello\n' },
  { name: 'src', type: '5', mode: 0o775 },
  { name: 'src/run.sh', data: '#!/bin/sh\n', mode: 0o775 },
  { name: 'src/link', type: '2', link: 'run.sh' },
  { name: 'pax-long', type: 'x', data: paxRecord('path', `${ROOT}/src/${'n'.repeat(120)}`) },
  { name: 'ignored-short-name', data: 'long\n' },
  { name: '.gitignore', data: 'ignored.txt\n' },
  { name: 'ignored.txt', data: 'tracked by hash\n' },
];
const fetchGood = (bytes: Uint8Array = archive(GOOD)) => async () => bytes;
async function created(sessions: TaskSessions, bytes?: Uint8Array) {
  const request = startRequest();
  return { request, session: await sessions.create(request, fetchGood(bytes), signal()) };
}

test('작업 공간: 정해진 경로에 풀고 기준 커밋·기준 해시를 남기며 저장소 설정을 실행하지 않는다', async () => {
  const { root, sessions } = await fresh();
  const hostile = [...GOOD,
    // 기준 커밋을 만들 때 저장소 내용이 git 동작을 바꾸지 못해야 한다.
    { name: '.gitattributes', data: '* filter=evil\n' }];
  const { request, session } = await created(sessions, archive(hostile));
  assert.equal(session.dirs.root, join(root, 'tasks', request.job, '1'));
  for (const name of ['home', 'config', 'workspace', 'run', 'tmp']) assert.ok((await lstat(join(session.dirs.root, name))).isDirectory(), name);
  assert.equal(await readFile(join(session.dirs.workspace, 'README.md'), 'utf8'), 'hello\n');
  assert.equal((await stat(join(session.dirs.workspace, 'src/run.sh'))).mode & 0o111, 0o111);
  assert.ok((await lstat(join(session.dirs.workspace, 'src/link'))).isSymbolicLink());
  assert.equal(await readFile(join(session.dirs.workspace, `src/${'n'.repeat(120)}`), 'utf8'), 'long\n');
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: session.dirs.workspace, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: session.dirs.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(log.trim(), 'baseline');
  assert.ok((await lstat(join(session.dirs.run, 'baseline.json'))).isFile());
  assert.equal((await stat(session.dirs.run)).mode & 0o077, 0);
});

test('작업 공간: 잘못된 압축본은 아무것도 남기지 않고 archive_failed, 받기 실패도 같다', async () => {
  const { root, sessions } = await fresh();
  await assert.rejects(sessions.create(startRequest(), fetchGood(archive([{ name: '.git/config' }])), signal()),
    (error: TaskWorkspaceError) => error.reason === 'archive_failed' && error.detail === 'archive_git');
  await assert.rejects(sessions.create(startRequest(), async () => { throw new ArchiveError('archive_network'); }, signal()),
    (error: TaskWorkspaceError) => error.reason === 'archive_failed' && error.detail === 'archive_network');
  assert.deepEqual(await readdir(join(root)).catch(() => []), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sessions.create(startRequest(), async () => { throw new Error('cancelled'); }, controller.signal),
    (error: TaskWorkspaceError) => error.reason === 'aborted');
});

test('작업 공간: 고정 SHA URL만 요청하고 자격·리다이렉트를 끈다', async () => {
  const { sessions } = await fresh();
  const seen: unknown[] = [];
  await sessions.create(startRequest(), async (url, init) => { seen.push(url, init.credentials, init.redirect, init.maxBytes); return archive(GOOD); }, signal());
  assert.deepEqual(seen, [`https://codeload.github.com/fixture/repo/tar.gz/${SHA}`, 'omit', 'error', LIMITS.archiveBytes]);
});

test('작업 공간: 보존 세션 상한과 저장 용량은 storage_full', async () => {
  const full = await fresh({ maxSessions: 2 });
  await created(full.sessions); await created(full.sessions);
  assert.equal(await full.sessions.retained(), 2);
  await assert.rejects(created(full.sessions), (error: TaskWorkspaceError) => error.reason === 'storage_full' && error.detail === 'retention');
  const tight = await fresh({ volumeBytes: 100 });
  await assert.rejects(created(tight.sessions), (error: TaskWorkspaceError) => error.reason === 'storage_full' && error.detail === 'volume');
  // 같은 세대를 다시 받으면 세션을 덮지 않는다.
  const twice = await fresh();
  const { request } = await created(twice.sessions);
  await assert.rejects(twice.sessions.create(request, fetchGood(), signal()), (error: TaskWorkspaceError) => error.reason === 'session_mismatch');
});

test('작업 공간: 디스크 부족은 storage_full이다', async t => {
  const { sessions } = await fresh();
  const realFetch = fetchGood();
  const original = sessions['writeRecord'].bind(sessions);
  sessions['writeRecord'] = async () => { throw Object.assign(new Error('write'), { code: 'ENOSPC' }); };
  await assert.rejects(sessions.create(startRequest(), realFetch, signal()), (error: TaskWorkspaceError) => error.reason === 'storage_full' && error.detail === 'no_space');
  sessions['writeRecord'] = original;
  t.diagnostic('ENOSPC는 쓰기 호출을 대신해 주입했다. 실제 볼륨을 채운 시험이 아니다');
});

test('다른 작업 경로: 이 세대만 빼고 모두 열거한다', async () => {
  const { sessions } = await fresh();
  const one = await created(sessions);
  const two = await created(sessions);
  const sameJob = await sessions.create(startRequest({ job: one.request.job, generation: 2 }), fetchGood(), signal());
  assert.deepEqual(await sessions.others(one.request.job, 1), [two.session.dirs.root, sameJob.dirs.root].sort());
  assert.deepEqual(await sessions.others(two.request.job, 1), [one.session.dirs.root, sameJob.dirs.root].sort());
});

async function conversation(session: TaskSession) {
  await mkdir(join(session.dirs.config, 'projects', 'encoded'), { recursive: true });
  await writeFile(join(session.dirs.config, 'projects', 'encoded', `${session.sessionId}.jsonl`), '{}\n');
}
test('재개: 묶인 값이 다르거나 세션 기록이 없으면 새 세션으로 대신하지 않는다', async () => {
  const { sessions } = await fresh();
  const { request, session } = await created(sessions);
  const resume = resumeRequest(request);
  await assert.rejects(sessions.open(resume), (error: TaskWorkspaceError) => error.reason === 'session_missing' && error.detail === 'conversation');
  await conversation(session);
  assert.equal((await sessions.open(resume)).dirs.root, session.dirs.root);
  for (const [name, change] of Object.entries({
    session: { sessionId: randomUUID() }, base: { base: 'b'.repeat(40) }, repository: { repository: 'fixture/other' }, policy: { policyRevision: 'policy-2' },
    project: { project: { ...request.project, revision: 'r2' } }, storage: { expectedWorker: { instance: WORKER.instance, storage: randomUUID() } } })) {
    await assert.rejects(sessions.open(resumeRequest(request, change)), (error: TaskWorkspaceError) => error.reason === 'session_mismatch', name);
  }
  await assert.rejects(sessions.open(resumeRequest(request, { generation: 9 })), (error: TaskWorkspaceError) => error.reason === 'session_missing');
  await sessions.recordTurn(session, 2);
  await assert.rejects(sessions.open(resume), (error: TaskWorkspaceError) => error.reason === 'session_mismatch', '같은 턴 재전송');
  assert.equal((await sessions.open(resumeRequest(request, { turn: 3 }))).sessionId, request.sessionId);
});

test('finalize: 소멸을 확인하지 못하면 지우지 않고, 권한을 없앤 디렉터리가 있어도 지운다', async () => {
  const { root, sessions } = await fresh();
  const { request, session } = await created(sessions);
  assert.deepEqual(await sessions.finalize(request.job, 1, async () => false), { stopped: false, cleaned: false });
  assert.ok((await lstat(session.dirs.root)).isDirectory());
  assert.deepEqual(await sessions.finalize(request.job, 1, async () => { throw new Error('probe'); }), { stopped: false, cleaned: false });
  const locked = join(session.dirs.workspace, 'locked');
  await mkdir(join(locked, 'inner'), { recursive: true });
  await writeFile(join(locked, 'inner', 'file'), 'x');
  await chmod(join(locked, 'inner'), 0o000);
  await chmod(locked, 0o000);
  // 심링크를 따라 바깥 권한을 바꾸면 안 된다.
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'keep', { mode: 0o600 });
  await symlink(outside, join(session.dirs.workspace, 'to-outside'));
  assert.deepEqual(await sessions.finalize(request.job, 1, async () => true), { stopped: true, cleaned: true });
  await assert.rejects(lstat(session.dirs.root), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, 'tasks', request.job)), { code: 'ENOENT' });
  assert.equal((await stat(outside)).mode & 0o777, 0o600);
  assert.equal(await sessions.retained(), 0);
});

const SECRET = 'sk-ant-oat01-fixture-secret-ABCDEFGHIJKLMNOPQRSTUV';
const PROJECT = startRequest().project;
const collect = (sessions: TaskSessions, session: TaskSession, patchBytes = LIMITS.patchBytes) => sessions.collect(session, PROJECT, { patchBytes }, [SECRET]);
test('증거: 추가·수정·삭제·실행 비트를 실제 파일에서 계산하고 patch가 적용된다', async () => {
  const { sessions } = await fresh();
  const { session } = await created(sessions);
  const { workspace } = session.dirs;
  await writeFile(join(workspace, 'README.md'), 'hello\nworld\n');
  await writeFile(join(workspace, 'src/new.txt'), 'new\n');
  await chmod(join(workspace, 'src/run.sh'), 0o644);
  await unlink(join(workspace, 'src/link'));
  await symlink('new.txt', join(workspace, 'src/alias'));
  const result = await sessions.collect(session, { ...PROJECT, allowedPaths: ['src', 'README.md'] }, { patchBytes: LIMITS.patchBytes }, [SECRET]);
  assert.ok(result.ok);
  const byPath = Object.fromEntries(result.evidence.changes.items.map(item => [item.path, item]));
  assert.equal(result.evidence.changes.total, 5);
  assert.equal(byPath['README.md']!.change, 'modified');
  assert.equal(byPath['src/new.txt']!.change, 'added');
  assert.equal(byPath['src/link']!.change, 'deleted');
  assert.deepEqual([byPath['src/run.sh']!.change, 'mode' in byPath['src/run.sh']! && byPath['src/run.sh']!.mode], ['modified', '100644']);
  assert.deepEqual([byPath['src/alias']!.change, 'mode' in byPath['src/alias']! && byPath['src/alias']!.mode], ['added', '120000']);
  for (const item of result.evidence.changes.items) TaskChangeSchema.parse(item);
  const { patch } = result.evidence;
  assert.match(patch.text, /^diff --git a\/README\.md b\/README\.md/m);
  assert.equal(patch.truncated, false);
  assert.equal(patch.bytes, Buffer.byteLength(patch.text));
  // 기준 압축본을 새로 풀어 patch를 적용하면 실행 뒤 내용이 된다.
  const check = await mkdtemp(join(scratch, 'apply-'));
  const env = { PATH: '/usr/bin:/bin', HOME: check, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const fresh2 = new TaskSessions(check, { storage: WORKER.storage, homes: ['/nonexistent-home'] });
  const copy = await fresh2.create(startRequest(), fetchGood(), signal());
  await writeFile(join(check, 'patch.diff'), patch.text);
  execFileSync('git', ['apply', join(check, 'patch.diff')], { cwd: copy.dirs.workspace, env });
  assert.equal(await readFile(join(copy.dirs.workspace, 'README.md'), 'utf8'), 'hello\nworld\n');
  assert.equal(await readFile(join(copy.dirs.workspace, 'src/new.txt'), 'utf8'), 'new\n');
});

test('증거: 변경이 없으면 빈 patch, 모델 말과 무관하게 실제 파일만 본다', async () => {
  const { sessions } = await fresh();
  const { session } = await created(sessions);
  // .git 안 변경과 숨김 제어 경로는 증거에 들어오지 않는다.
  await writeFile(join(session.dirs.workspace, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil\n');
  const result = await collect(sessions, session);
  assert.ok(result.ok);
  assert.deepEqual(result.evidence.changes, { total: 0, items: [] });
  assert.deepEqual([result.evidence.patch.text, result.evidence.patch.bytes, result.evidence.patch.truncated], ['', 0, false]);
});

test('증거: 바깥을 가리키거나 정책 밖이거나 특수 파일이면 결과를 내지 않는다', async () => {
  const cases: [string, (workspace: string, root: string) => Promise<void>, string][] = [
    ['절대 심링크', workspace => symlink('/run/worker-credential/token', join(workspace, 'src/steal')), 'change_outside_workspace'],
    ['상위 심링크', workspace => symlink('../../config/.claude.json', join(workspace, 'src/steal')), 'change_outside_workspace'],
    ['하드링크', async (workspace, root) => {
      const outside = join(root, 'outside');
      await writeFile(outside, 'x');
      await link(outside, join(workspace, 'src/steal'));
    }, 'change_outside_workspace'],
    ['FIFO', workspace => { execFileSync('mkfifo', [join(workspace, 'src/pipe')]); return Promise.resolve(); }, 'change_path_invalid'],
    ['허용 밖', workspace => writeFile(join(workspace, 'outside-policy.txt'), 'x'), 'change_outside_policy'],
    ['금지 경로', async workspace => { await mkdir(join(workspace, 'src/secret')); await writeFile(join(workspace, 'src/secret/key'), 'x'); }, 'change_outside_policy'],
    ['중첩 .git', async workspace => { await mkdir(join(workspace, 'src/.git')); await writeFile(join(workspace, 'src/.git/config'), 'x'); }, 'change_path_invalid'],
  ];
  for (const [name, plant, reason] of cases) {
    const { root, sessions } = await fresh();
    const { session } = await created(sessions);
    await plant(session.dirs.workspace, root);
    const result = await collect(sessions, session);
    assert.deepEqual(result, { ok: false, reason }, name);
  }
  // 작업 공간 자체를 심링크로 바꿔치기.
  const { root, sessions } = await fresh();
  const { session } = await created(sessions);
  await rm(session.dirs.workspace, { recursive: true, force: true });
  await symlink(root, session.dirs.workspace);
  assert.deepEqual(await collect(sessions, session), { ok: false, reason: 'diff_unavailable' });
});

test('증거: 변경 파일·이름·심링크 대상의 자격 반사를 잡는다(이진 파일과 조각 경계 포함)', async () => {
  const plants: [string, (workspace: string) => Promise<void>][] = [
    ['본문', workspace => writeFile(join(workspace, 'src/leak.txt'), `token=${SECRET}\n`)],
    ['띄어쓰기', workspace => writeFile(join(workspace, 'src/leak.txt'), SECRET.split('').join(' '))],
    ['이진', workspace => writeFile(join(workspace, 'src/leak.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(SECRET), Buffer.from([0])]))],
    ['큰 파일 뒤쪽', workspace => writeFile(join(workspace, 'src/large.txt'), `${'y '.repeat(200_000)}${SECRET}`)],
    ['파일 이름', workspace => writeFile(join(workspace, `src/${SECRET}`), 'x')],
    ['심링크 대상', workspace => symlink(SECRET, join(workspace, 'src/leak-link'))],
  ];
  for (const [name, plant] of plants) {
    const { sessions } = await fresh();
    const { session } = await created(sessions);
    await plant(session.dirs.workspace);
    assert.deepEqual(await collect(sessions, session), { ok: false, reason: 'secret_echo' }, name);
  }
});

test('증거: 큰 patch는 잘라 표시하고 전체 digest를 남기며 깨진 UTF-8을 계약 안에 둔다', async () => {
  const { sessions } = await fresh();
  const { session } = await created(sessions);
  await writeFile(join(session.dirs.workspace, 'src/large.txt'), randomBytes(50_000).toString('hex'));
  const cut = await collect(sessions, session, 1000);
  assert.ok(cut.ok);
  assert.equal(cut.evidence.patch.truncated, true);
  assert.ok(Buffer.byteLength(cut.evidence.patch.text) <= 1000);
  assert.ok(cut.evidence.patch.bytes > 100_000);
  assert.match(cut.evidence.patch.digest, /^[a-f0-9]{64}$/);
  const { sessions: other } = await fresh();
  const second = await created(other);
  await writeFile(join(second.session.dirs.workspace, 'src/latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const invalid = await collect(other, second.session);
  assert.ok(invalid.ok);
  assert.equal(invalid.evidence.patch.truncated, true);
  const response = TaskResponseSchema.safeParse({ version: 1, job: randomUUID(), lease: randomUUID(), generation: 1, sessionId: randomUUID(), turn: 1, worker: WORKER,
    usage: { toolCalls: 0, model: null }, status: 'completed', stopped: true, sessionRetained: true, cleanupPending: false, summary: 's', ...invalid.evidence, verification: [] });
  assert.equal(response.success, true);
});
