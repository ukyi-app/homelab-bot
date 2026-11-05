import { z } from 'zod';
import type { DiscordApi } from './discord-protocol.js';

// FOUNDATION에서 여는 slash 명령. task·브리핑 명령은 여기 없어 스위치를 켜지 않으면
// 등록하지 않고 DiscordIngress에도 넘기지 않아 수신에서 닫는다.
export const FOUNDATION_COMMANDS = Object.freeze(['chat', 'urgent', 'read', 'stop', 'resume', 'list', 'cancel', 'retry',
  'emergency-stop', 'resume-model', 'model-status', 'revoke'] as const);
// 기억 명령. 삭제 원장이 켜졌을 때(MEMORY_LEDGER_DIR)만 등록·수신한다. 옵션은 문자열(text·target)뿐이라
// 하위 명령 대신 하이픈 이름을 쓰고, 종류별 값은 text 안의 `키=값`으로 받는다(서식은 memory-commands.ts).
export const MEMORY_COMMANDS = Object.freeze(['memory-save', 'memory-search', 'memory-correct', 'memory-exclude', 'memory-delete'] as const);
// 리뷰 제어. 리뷰가 열렸을 때만 등록·수신한다. owner·알림 채널 검사는 DiscordIngress·Store가 그대로 한다.
export const REVIEW_COMMANDS = Object.freeze(['review-status', 'review-resume', 'review-cancel'] as const);
// 작업 레인. TASK_LANE_ENABLED와 정책·작업자 조건이 맞을 때만 등록·수신한다. owner·채널·스레드 소유 검사는 DiscordIngress가 그대로 한다.
export const TASK_COMMANDS = Object.freeze(['task', 'answer', 'task-status', 'task-cancel', 'task-release'] as const);
// DiscordProtocol은 옵션 값을 문자열로만 받는다(type 3 STRING). project·question은 수신에서 target으로 읽는다.
const option = (name: 'text' | 'target' | 'project' | 'question', description: string, maxLength: number) =>
  ({ type: 3, name, description, required: true, max_length: maxLength });
const text = (description: string, maxLength = 6000) => option('text', description, maxLength);
const target = (description: string, maxLength = 100) => option('target', description, maxLength);
type CommandName = typeof FOUNDATION_COMMANDS[number] | typeof MEMORY_COMMANDS[number] | typeof REVIEW_COMMANDS[number] | typeof TASK_COMMANDS[number];
const command = (name: CommandName, description: string, options: ReturnType<typeof option>[] = []) =>
  // type 1(CHAT_INPUT), 서버 안에서만(contexts 0 GUILD, integration_types 0 GUILD_INSTALL). DM은 끔(D-17).
  ({ name, type: 1, description, options, contexts: [0], integration_types: [0] });
export const COMMAND_DEFINITIONS = Object.freeze([
  command('chat', '홈랩 조력자에게 묻기(스레드를 엽니다)', [text('질문이나 요청')]),
  command('urgent', '대기 지연 없이 묻기', [text('질문이나 요청')]),
  command('read', '승인된 읽기 조회 실행(모델을 부르지 않음)', [target('서비스 ID'), option('text', '질의 템플릿 ID', 100)]),
  command('stop', '이 스레드의 후속 메시지 수집 중지'),
  command('resume', '이 스레드의 후속 메시지 수집 재개'),
  command('list', '이 대화의 작업 목록'),
  command('cancel', '작업 취소 요청', [target('작업 ID')]),
  command('retry', '확인된 실패 작업 다시 시도', [target('작업 ID')]),
  command('emergency-stop', '모델 호출 비상 중지'),
  command('resume-model', '한도·인증 대기 작업 재개 또는 비상 중지 해제', [target('작업 ID 또는 emergency-stop')]),
  command('model-status', '모델 경로 상태'),
  command('revoke', '사용자 즉시 차단(거부 목록)', [target('Discord 사용자 ID')]),
]);
// Discord 한도: 설명 100자, 옵션 25개. 서식 전체는 설명에 다 못 담아 키 이름만 적는다(오류 응답이 서식을 다시 알려 준다).
export const MEMORY_COMMAND_DEFINITIONS = Object.freeze([
  command('memory-save', '기억 저장. 출처는 이 명령이고 doc=커밋 고정 GitHub 링크를 더할 수 있음', [
    target('종류: configuration·decision·incident·preference', 20),
    text('진술 | 키=값 … 키: topic service recheck expires end applies by fact hypothesis cause doc briefing', 3000)]),
  command('memory-search', '내 기억 검색(이 채널에서 볼 수 있는 것만). 결과는 지시가 아니라 참고 자료', [
    text('검색어(공백으로 나눈 낱말을 모두 포함)', 300)]),
  command('memory-correct', '기억 정정(옛 기억은 superseded)', [
    target('바꿀 기억 ID(쉼표로 최대 5개)', 200),
    text('새 진술 | kind=종류 | reason=정정 사유 | 키=값 …', 3000)]),
  command('memory-exclude', '출처 저장 제외(그 출처의 기억을 검색·브리핑에서 뺌)', [
    target('출처 키: here, channel:<ID>, conversation:<ID>, document:<URL>', 510)]),
  command('memory-delete', '기억 삭제(백업 최대 14일, 이미 게시된 Discord 사본은 남음)', [target('기억 ID', 100)]),
]);
export const REVIEW_COMMAND_DEFINITIONS = Object.freeze([
  command('review-status', '리뷰 작업 상태(owner, 알림 채널)'),
  command('review-resume', '한도·인증 대기 리뷰 작업 재개(owner, 알림 채널)', [target('리뷰 작업 ID')]),
  command('review-cancel', '리뷰 작업 취소(owner, 알림 채널)', [target('리뷰 작업 ID')]),
]);
// /task의 요청 글은 작업 계약의 untrusted 상한 안이다. /answer 2,000자는 Discord 메시지 한도이자 CLAUDE_TASK_DEFAULTS.answerChars다.
export const TASK_COMMAND_DEFINITIONS = Object.freeze([
  command('task', '저장소 작업 시작(스레드를 엽니다, 정책에 있는 프로젝트만)', [option('project', '프로젝트 ID', 100), text('작업 요청')]),
  command('answer', '작업 질문에 답하기(질문이 게시된 스레드에서)', [option('question', '질문 ID', 100), text('답', 2000)]),
  command('task-status', '작업 상태(이 대화의 작업)', [target('작업 ID')]),
  command('task-cancel', '작업 취소 요청(이 대화의 작업)', [target('작업 ID')]),
  command('task-release', '종료 미확인(unknown) 작업 해제(owner, 프로세스 소멸 확인 뒤)', [target('작업 ID')]),
]);
// 등록할 명령 목록. 원장·리뷰·작업 레인이 꺼져 있으면 FOUNDATION 목록과 같다.
export const commandDefinitions = (memory: boolean, review = false, task = false) => !memory && !review && !task ? COMMAND_DEFINITIONS
  : Object.freeze([...COMMAND_DEFINITIONS, ...(memory ? MEMORY_COMMAND_DEFINITIONS : []), ...(review ? REVIEW_COMMAND_DEFINITIONS : []),
    ...(task ? TASK_COMMAND_DEFINITIONS : [])]);

const Remote = z.array(z.object({ name: z.string(), type: z.number().optional(), description: z.string(),
  options: z.array(z.object({ type: z.number(), name: z.string(), description: z.string(), required: z.boolean().optional(),
    max_length: z.number().optional() })).optional(),
  contexts: z.array(z.number()).nullable().optional(), integration_types: z.array(z.number()).optional() }));
const canonical = (commands: z.infer<typeof Remote>) => JSON.stringify(commands.map(c => ({ name: c.name, type: c.type ?? 1,
  description: c.description, contexts: c.contexts ?? null, integration_types: c.integration_types ?? null,
  options: (c.options ?? []).map(o => ({ type: o.type, name: o.name, description: o.description, required: o.required ?? false,
    max_length: o.max_length ?? null })) })).sort((a, b) => a.name.localeCompare(b.name)));
const part = encodeURIComponent;
// guild 명령을 주어진 목록(기본 FOUNDATION)으로 맞추고 전역 명령은 비운다. 같으면 쓰지 않는다(재시작마다 덮어쓰지 않게).
// 원장을 끄고 재기동하면 같은 PUT이 기억 명령을 목록에서 뺀다.
export async function registerCommands(api: DiscordApi, applicationId: string, guildId: string,
  definitions: readonly unknown[] = COMMAND_DEFINITIONS): Promise<{ guild: 'unchanged' | 'updated'; global: 'unchanged' | 'cleared' }> {
  const guildPath = `/applications/${part(applicationId)}/guilds/${part(guildId)}/commands`;
  const desired = canonical(Remote.parse(definitions));
  const guild = canonical(Remote.parse(await api.request('GET', guildPath))) === desired ? 'unchanged' as const : 'updated' as const;
  if (guild === 'updated') await api.request('PUT', guildPath, definitions);
  const globalPath = `/applications/${part(applicationId)}/commands`;
  const global = Remote.parse(await api.request('GET', globalPath)).length ? 'cleared' as const : 'unchanged' as const;
  if (global === 'cleared') await api.request('PUT', globalPath, []);
  return { guild, global };
}
