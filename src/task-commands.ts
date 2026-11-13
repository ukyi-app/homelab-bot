import type { ClaudeTaskBridge } from './claude-task-bridge.js';
import { CHAT_TASK_TEXT as T, jobStateText, waitReasonText } from './chat-task-text.js';
import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import { taskLaneClosedText } from './control-format.js';
import type { Database } from './database.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';
import type { TaskAnswerInput, TaskAnswerResult } from './task-bridge.js';
import type { TaskIntakeStatus } from './task-http.js';
import { TaskPolicySchema, taskProject } from './task-policy.js';

// Discord 작업 명령과 브리지 사이. 수신 경로는 DB 트랜잭션 안에서 부르는 것(admit·answerIn·cancelIn)과 밖에서 부르는 것(status·release)을 가른다.
// 작업자에 묻는 호출은 Gateway 이벤트 순서를 막으면 뒤 상호작용이 3초 기한을 놓쳐서, release는 먼저 답하고 결과를 대화에 게시한다.
export interface TaskCommandHandler {
  // 접수 전 확인. 막을 안내 글, 받으면 null. 호출자의 트랜잭션 안에서 부른다.
  admit(store: Store, project: string | undefined): Promise<string | null>;
  answerIn(store: Store, input: TaskAnswerInput): Promise<TaskAnswerResult>;
  // 답 원문을 events에 두면 안 되는 질문인지. 없으면 지금처럼 둔다.
  sealsAnswer?(db: Database, question: string): Promise<boolean>;
  cancelIn(store: Store, actor: string, conversation: string, job: string, cursor: string): Promise<unknown>;
  status(actor: string, scope: Scope, job: string): Promise<string>;
  // 받았다는 안내를 돌려주고 소멸 확인은 뒤에서 한다. 결과는 대화에 게시한다.
  release(request: { id: string; actor: string; scope: Scope; job: string; revision: string }): string;
}

// codex_sessions.cleanup_state 값. none은 줄에 싣지 않는다.
const CLEANUP: Readonly<Record<string, string>> = Object.freeze({ pending: '확인 중', cleaned: '마침' });
const time = (value: number | null) => value === null ? null : new Date(value).toISOString();
export class TaskCommands implements TaskCommandHandler {
  constructor(private readonly store: Store, private readonly gate: PolicyGate, private readonly bridge: ClaudeTaskBridge,
    private readonly intake: () => TaskIntakeStatus, private readonly track: (task: Promise<void>) => void, private readonly log: Log) {}
  async admit(store: Store, project: string | undefined): Promise<string | null> {
    const policy = await this.gate.withDatabase(store.db).current();
    if (!taskProject(policy, project)) {
      const known = TaskPolicySchema.safeParse(policy.task);
      const names = known.success ? known.data.projects.map(item => item.id).join(', ') : '';
      return T.projectNotAllowed(store.colleague, names);
    }
    const closed = (await store.db.query<{ closed_reason: string | null }>(`SELECT closed_reason FROM execution_lanes WHERE lane='task'`)).rows[0]?.closed_reason;
    if (closed) return taskLaneClosedText(closed, store.colleague);
    const intake = this.intake();
    if (!intake.open) return T.intakeClosed(store.colleague, intake.reasons.join(', '));
    return null;
  }
  answerIn(store: Store, input: TaskAnswerInput): Promise<TaskAnswerResult> { return this.bridge.answerIn(store, input); }
  // /cancel과 같은 경로다. 이 이름으로는 작업 레인 작업만 건드린다.
  async cancelIn(store: Store, actor: string, conversation: string, job: string, cursor: string): Promise<unknown> {
    const row = (await store.db.query<{ type: string }>('SELECT type FROM jobs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3', [job, actor, conversation])).rows[0];
    if (row?.type !== 'task') return { ok: false, status: T.taskNotHere(store.colleague) };
    return store.control(actor, conversation, 'cancel', job, cursor);
  }
  async status(actor: string, scope: Scope, job: string): Promise<string> {
    const status = await this.bridge.status(actor, scope, job);
    return [`작업 ${job}: ${jobStateText(status.state)}${status.waitReason ? `(${waitReasonText(status.waitReason)})` : ''}`,
      `세션: ${status.session ? `있음${status.generation ? `, 세대 ${status.generation}` : ''}` : '없음'}${status.cleanup && status.cleanup !== 'none' ? `, 정리 ${CLEANUP[status.cleanup] ?? status.cleanup}` : ''}`,
      ...(status.question ? [`열린 질문: ${status.question.id} (기한 ${time(status.question.expiresAt)})`] : []),
      ...(status.waitingSince !== null ? [`모델 대기 시작: ${time(status.waitingSince)}${status.ownerConfirmRequestedAt !== null ? ', 관리자 확인 요청함' : ''}`] : [])].join('\n');
  }
  release(request: { id: string; actor: string; scope: Scope; job: string; revision: string }): string {
    this.track((async () => {
      let content: string;
      try {
        const result = await this.bridge.release(request.actor, request.scope, request.job);
        content = result.ok ? T.releaseDone(this.store.colleague, request.job, result.status) : T.releaseFailed(this.store.colleague, request.job, result.status);
      } catch (error) {
        // 타인 작업과 다른 대화의 작업은 존재 여부도 구별해 알리지 않는다.
        if (!(error instanceof Denied)) this.log('task_release_failed', errorInfo(error));
        content = error instanceof Denied ? T.releaseNotFound : T.releaseError;
      }
      await this.store.enqueue({ key: `task-release:${request.id}`, actor: request.actor, scope: request.scope, revision: request.revision,
        payload: { kind: 'message', channel: request.scope.channel, content, classification: 'safe_summary' } });
    })().catch(error => { this.log('task_release_notice_failed', errorInfo(error)); }));
    return T.releaseStarted;
  }
}
