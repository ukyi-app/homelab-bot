import { z } from 'zod';
import type { Job } from './contracts.js';
import type { Policy } from './policy.js';
import type { Store } from './store.js';
import type { TaskPlan, TaskPlanSource } from './claude-task-bridge.js';
import { TASK_LIMITS, TaskProjectSchema, TaskRunLimitsSchema } from './task-contracts.js';
import { REPOSITORY_NAME } from './worker.js';

// 실행 정책(RUNTIME_POLICIES)의 task 절. 프로젝트 ID → 저장소·허용 경로·검증 명령 식별자·상한.
// 값은 Infisical에 두고 공개 문서에는 키 이름만 둔다. 이 절이 없거나 틀리면 작업 레인만 닫힌다.
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
const TaskProjectPolicySchema = TaskProjectSchema.extend({
  repository: z.string().max(140).regex(REPOSITORY_NAME),
  // 둘 중 하나만. branch: 작업 시작 때 그 브랜치 머리. base: 고정 SHA(첫 live 시험처럼 승인 범위를 커밋까지 묶을 때).
  branch: z.string().regex(BRANCH).optional(),
  base: z.string().regex(SHA).optional(),
  limits: TaskRunLimitsSchema.partial().optional(),
}).refine(project => (project.branch === undefined) !== (project.base === undefined), 'branch_or_base');
export const TaskPolicySchema = z.strictObject({ projects: z.array(TaskProjectPolicySchema).min(1).max(32) }).superRefine((policy, ctx) => {
  if (new Set(policy.projects.map(project => project.id)).size !== policy.projects.length) ctx.addIssue({ code: 'custom', path: ['projects'], message: 'duplicate_project' });
});
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;
export type TaskProjectPolicy = TaskPolicy['projects'][number];
export const taskProject = (policy: Policy, id: string | undefined): TaskProjectPolicy | undefined => {
  const parsed = TaskPolicySchema.safeParse(policy.task);
  return parsed.success ? parsed.data.projects.find(project => project.id === id) : undefined;
};

const DEFAULT_LIMITS = Object.freeze({ archiveBytes: TASK_LIMITS.archiveBytes, files: TASK_LIMITS.files, fileBytes: TASK_LIMITS.fileBytes,
  patchBytes: TASK_LIMITS.patchBytes, lineBytes: TASK_LIMITS.lineBytes, outputBytes: TASK_LIMITS.outputBytes, events: TASK_LIMITS.events });

// 기준 SHA: 공개 GitHub REST를 자격 없이 읽는다(commits/<branch>, sha 미디어 타입).
// 작업자가 같은 저장소를 자격 없이 codeload로 받으므로 익명으로 안 보이는 저장소는 어차피 시작할 수 없고, 리뷰 App 토큰을 작업 레인에 끌어오지 않는다.
// 익명 한도(IP당 시간 60회)는 owner 한 사람의 작업 시작에 충분하다. 닿지 않으면 그 작업만 실패하고 owner가 /retry한다.
const HEAD_TIMEOUT_MS = 10_000;
export async function branchHead(send: typeof fetch, repository: string, branch: string): Promise<string> {
  const response = await send(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`, { method: 'GET', redirect: 'error',
    headers: { accept: 'application/vnd.github.sha', 'user-agent': 'homelab-bot', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
  const text = response.ok ? (await response.text()).trim() : '';
  if (!SHA.test(text)) throw new Error('task_base_unavailable');
  return text;
}

// 턴마다 불린다. 브리지가 재개 때 세션의 기준 SHA와 대조하므로 머리가 움직여도 대기 중인 세션의 값을 돌려준다.
// /retry는 세션이 대기 상태가 아니라 새 세대가 그때의 머리에서 시작한다.
export class PolicyTaskPlans implements TaskPlanSource {
  constructor(private readonly store: Store, private readonly send: typeof fetch) {}
  async plan(job: Job, policy: Policy): Promise<TaskPlan> {
    const row = (await this.store.db.query<{ target: string | null }>(`SELECT payload->>'target' AS target FROM events WHERE id=$1`, [job.event_id])).rows[0];
    const project = taskProject(policy, row?.target ?? undefined);
    if (!project) throw new Error('task_project_missing');
    const waiting = (await this.store.db.query<{ base_sha: string | null }>(`SELECT base_sha FROM codex_sessions WHERE job_id=$1 AND executor='claude'
      AND state IN ('waiting_answer','waiting_model')`, [job.id])).rows[0]?.base_sha;
    return { repository: project.repository, base: waiting ?? project.base ?? await branchHead(this.send, project.repository, project.branch!),
      project: { id: project.id, revision: project.revision, allowedPaths: project.allowedPaths, forbiddenPaths: project.forbiddenPaths, verifyCommands: project.verifyCommands },
      limits: { ...DEFAULT_LIMITS, ...project.limits } };
  }
}
