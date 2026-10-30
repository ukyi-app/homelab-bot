import { z } from 'zod';
import type { DiscordApi } from './discord-protocol.js';

// FOUNDATION에서 여는 slash 명령(T16b PLAN S3). task·review-*·기억·브리핑 명령은 등록하지 않고
// DiscordIngress에도 이 목록만 넘겨 수신에서 닫는다(T17·T18·T20 경로는 연결하지 않음).
export const FOUNDATION_COMMANDS = Object.freeze(['chat', 'urgent', 'read', 'stop', 'resume', 'list', 'cancel', 'retry',
  'emergency-stop', 'resume-model', 'model-status', 'revoke'] as const);
// DiscordProtocol은 옵션 값을 문자열로만 받는다(type 3 STRING). 이름은 수신 계약(text·target)과 같다.
const option = (name: 'text' | 'target', description: string, maxLength: number) =>
  ({ type: 3, name, description, required: true, max_length: maxLength });
const text = (description: string) => option('text', description, 6000);
const target = (description: string) => option('target', description, 100);
const command = (name: typeof FOUNDATION_COMMANDS[number], description: string, options: ReturnType<typeof option>[] = []) =>
  // type 1(CHAT_INPUT), 서버 안에서만(contexts 0 GUILD, integration_types 0 GUILD_INSTALL). DM은 끔(T16a).
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

const Remote = z.array(z.object({ name: z.string(), type: z.number().optional(), description: z.string(),
  options: z.array(z.object({ type: z.number(), name: z.string(), description: z.string(), required: z.boolean().optional(),
    max_length: z.number().optional() })).optional(),
  contexts: z.array(z.number()).nullable().optional(), integration_types: z.array(z.number()).optional() }));
const canonical = (commands: z.infer<typeof Remote>) => JSON.stringify(commands.map(c => ({ name: c.name, type: c.type ?? 1,
  description: c.description, contexts: c.contexts ?? null, integration_types: c.integration_types ?? null,
  options: (c.options ?? []).map(o => ({ type: o.type, name: o.name, description: o.description, required: o.required ?? false,
    max_length: o.max_length ?? null })) })).sort((a, b) => a.name.localeCompare(b.name)));
const part = encodeURIComponent;
// guild 명령을 FOUNDATION 목록으로 맞추고 전역 명령은 비운다. 같으면 쓰지 않는다(재시작마다 덮어쓰지 않게).
export async function registerCommands(api: DiscordApi, applicationId: string, guildId: string): Promise<{ guild: 'unchanged' | 'updated'; global: 'unchanged' | 'cleared' }> {
  const guildPath = `/applications/${part(applicationId)}/guilds/${part(guildId)}/commands`;
  const desired = canonical(Remote.parse(COMMAND_DEFINITIONS));
  const guild = canonical(Remote.parse(await api.request('GET', guildPath))) === desired ? 'unchanged' as const : 'updated' as const;
  if (guild === 'updated') await api.request('PUT', guildPath, COMMAND_DEFINITIONS);
  const globalPath = `/applications/${part(applicationId)}/commands`;
  const global = Remote.parse(await api.request('GET', globalPath)).length ? 'cleared' as const : 'unchanged' as const;
  if (global === 'cleared') await api.request('PUT', globalPath, []);
  return { guild, global };
}
