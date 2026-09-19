import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DesktopMcpGrant } from '../shared/desktop-mcp.ts';
import type { CollaborationScope, SharedArtifact, TeamTask } from '../shared/collaboration.ts';
import type { WorkspaceState } from './store.ts';

export type DesktopMcpScopeGrant = Pick<DesktopMcpGrant, 'scope' | 'submitTasks' | 'budgetTeamId' | 'generationKey'>;
const id = z.uuid();
const page = { offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(20).default(20) };
export const desktopMcpSchemas = {
  app_context: z.object(page).strict(),
  app_task_list: z.object({ ...page, status: z.enum(['open', 'claimed', 'done']).optional() }).strict(),
  app_task_read: z.object({ taskId: id, ...page }).strict(),
  app_task_create: z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(8000).default(''),
    idempotencyKey: z.string().min(1).max(100) }).strict(),
  app_artifact_list: z.object(page).strict(),
  app_artifact_read: z.object({ artifactId: id, ...page }).strict(),
  app_run_read: z.object({ runId: id, ...page }).strict(),
} as const;
export type DesktopMcpOperation = keyof typeof desktopMcpSchemas;
const descriptions: Record<DesktopMcpOperation, string> = {
  app_context: 'Read the granted team or project and current public member names. offset/limit page members (limit 1..20). No private agent context is returned.',
  app_task_list: 'List tasks only in the granted scope. offset/limit page task summaries (limit 1..20).',
  app_task_read: 'Read one scoped task. Text items contain description/outcome in chunks of at most 256 Unicode characters. offset/limit page text chunks, run IDs, and shared artifact links (limit 1..20).',
  app_task_create: 'Submit an open task to the granted scope without assigning an agent or directly starting a run; existing automatic task discovery may schedule work. Requires task submission permission and a stable idempotencyKey; changed retry content is refused.',
  app_artifact_list: 'List metadata of shared artifacts only in the granted scope. offset/limit page items (limit 1..20).',
  app_artifact_read: 'Read a current scoped shared artifact. offset/limit page content chunks of at most 256 Unicode characters (limit 1..20).',
  app_run_read: 'Read status and result only for a run claimed by a task in the granted scope. offset/limit page result chunks of at most 256 Unicode characters and shared artifact links (limit 1..20). Private artifacts, prompts, and raw errors are excluded.',
};
export const desktopMcpTools = (Object.keys(desktopMcpSchemas) as DesktopMcpOperation[]).map(name => ({
  name, description: descriptions[name], inputSchema: z.toJSONSchema(desktopMcpSchemas[name]),
}));
const messages = {
  MCP_INPUT_INVALID: [400, '요청 형식이 올바르지 않습니다.'],
  MCP_SCOPE_DENIED: [403, '현재 허용된 팀 또는 프로젝트 범위를 확인할 수 없습니다.'],
  MCP_SUBMIT_DENIED: [403, '이 연결에는 과제 등록 권한이 없습니다.'],
  MCP_GENERATION_CHANGED: [403, '작업실 세대가 변경됐습니다. 현재 작업실에서 다시 연결할 수 있습니다.'],
  MCP_NOT_FOUND: [404, '허용된 범위에서 해당 항목을 찾을 수 없습니다.'],
  MCP_CONFLICT: [409, '같은 요청 식별자를 다른 과제에 사용할 수 없습니다.'],
  MCP_BUSY: [409, '작업실 전환 또는 종료 중에는 요청을 처리할 수 없습니다.'],
  MCP_RESPONSE_LIMIT: [413, '응답 한도를 초과했습니다. 더 작은 범위로 조회할 수 있습니다.'],
  MCP_UNAVAILABLE: [503, '이 작업실에서는 로컬 MCP를 사용할 수 없습니다.'],
  MCP_OPERATION_FAILED: [500, '로컬 MCP 요청을 처리하지 못했습니다.'],
} as const;
export class DesktopMcpServiceError extends Error {
  readonly statusCode: number;
  constructor(readonly code: keyof typeof messages) { super(messages[code][1]); this.statusCode = messages[code][0]; }
}
const fail = (code: keyof typeof messages): never => { throw new DesktopMcpServiceError(code); };
export function desktopMcpFailure(error: unknown): DesktopMcpServiceError {
  if (error instanceof DesktopMcpServiceError) return error;
  if (error instanceof z.ZodError) return new DesktopMcpServiceError('MCP_INPUT_INVALID');
  if (error instanceof Error && 'statusCode' in error) {
    const mapped = { 400: 'MCP_INPUT_INVALID', 403: 'MCP_SCOPE_DENIED', 404: 'MCP_NOT_FOUND', 409: 'MCP_CONFLICT', 503: 'MCP_UNAVAILABLE' } as const;
    if (Object.hasOwn(mapped, String(error.statusCode))) return new DesktopMcpServiceError(mapped[error.statusCode as keyof typeof mapped]);
  }
  return new DesktopMcpServiceError('MCP_OPERATION_FAILED');
}
export function parseDesktopMcpInput(operation: string, args: unknown) {
  if (!Object.hasOwn(desktopMcpSchemas, operation)) return fail('MCP_INPUT_INVALID');
  return desktopMcpSchemas[operation as DesktopMcpOperation].parse(args);
}
const scopeGrantSchema = z.object({ scope: z.object({ type: z.enum(['team', 'project']), id }).strict(),
  submitTasks: z.boolean(), budgetTeamId: id.nullable(), generationKey: id });
export function validateDesktopMcpScope(state: WorkspaceState, input: DesktopMcpScopeGrant): void {
  const grant = scopeGrantSchema.parse(input);
  if (grant.scope.type === 'team') {
    if (!state.teams.some(team => team.id === grant.scope.id) || grant.budgetTeamId !== grant.scope.id) fail('MCP_SCOPE_DENIED');
  } else {
    const project = state.projects.find(project => project.id === grant.scope.id);
    if (!project || project.teamIds.some(teamId => !state.teams.some(team => team.id === teamId))
      || grant.budgetTeamId !== null && !project.teamIds.includes(grant.budgetTeamId)
      || grant.submitTasks && grant.budgetTeamId === null) fail('MCP_SCOPE_DENIED');
  }
}
export function validateDesktopMcpCaller(grant: DesktopMcpGrant): void {
  z.object({ id, label: z.string().min(1).max(100) }).parse(grant);
  if (grant.revokedAt !== null) fail('MCP_SCOPE_DENIED');
}
const sameScope = (a: CollaborationScope, b: CollaborationScope) => a.type === b.type && a.id === b.id;
function take(text: string, maximum: number) { let result = '', count = 0; for (const character of text) { if (count++ === maximum) break; result += character; } return result; }
function paged<T>(items: T[], offset: number, limit: number) {
  return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
}
function textPage(fields: Array<{ field: string; text: string }>, offset: number, limit: number) {
  const items: Array<{ index: number; field: string; text: string }> = [];
  let total = 0, totalCharacters = 0;
  for (const { field, text } of fields) {
    let chunk = '', length = 0;
    const finish = () => { if (total >= offset && total < offset + limit) items.push({ index: total, field, text: chunk }); total++; chunk = ''; length = 0; };
    for (const character of text) {
      if (total >= offset && total < offset + limit) chunk += character;
      length++; totalCharacters++;
      if (length === 256) finish();
    }
    if (length) finish();
  }
  return { items, total, nextOffset: offset + limit < total ? offset + limit : null, totalCharacters };
}
function artifactMetadata(artifact: SharedArtifact) {
  return { id: artifact.id, name: take(artifact.name, 120), mediaType: take(artifact.mediaType, 100), version: artifact.version,
    createdAt: artifact.createdAt, updatedAt: artifact.updatedAt, contentLength: artifact.content.length };
}
function artifactLinks(state: WorkspaceState, scope: CollaborationScope, ids: string[], offset: number, limit: number) {
  const allowed = new Set(ids);
  return paged(state.sharedArtifacts.filter(artifact => sameScope(artifact.scope, scope) && allowed.has(artifact.id))
    .map(artifact => ({ id: artifact.id, name: take(artifact.name, 120), version: artifact.version })), offset, limit);
}
function taskMetadata(task: TeamTask) {
  return { id: task.id, title: take(task.title, 200), status: task.status, version: task.version,
    assigneeAgentId: task.assigneeAgentId, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt,
    source: task.externalClient ? { type: 'externalClient', id: task.externalClient.id, label: take(task.externalClient.label, 100) }
      : task.createdByAgentId ? { type: 'agent', id: task.createdByAgentId } : { type: 'operator' } };
}
export function desktopMcpTaskResult(state: WorkspaceState, grant: DesktopMcpGrant, task: TeamTask, offset = 0, limit = 20) {
  if (!sameScope(task.scope, grant.scope)) return fail('MCP_NOT_FOUND');
  return { ...taskMetadata(task), text: textPage([{ field: 'description', text: task.description }, { field: 'outcome', text: task.outcome }], offset, limit),
    runs: paged([...new Set([...(task.claimRunIds ?? []), ...(task.claimedRunId ? [task.claimedRunId] : [])])]
      .filter(id => state.runs.some(run => run.id === id)).map(id => ({ id })), offset, limit),
    artifacts: artifactLinks(state, grant.scope, task.artifactIds, offset, limit) };
}
export function prepareDesktopMcpTask(state: WorkspaceState, grant: DesktopMcpGrant, args: unknown) {
  if (!grant.submitTasks) return fail('MCP_SUBMIT_DENIED');
  const input = desktopMcpSchemas.app_task_create.parse(args);
  const idempotencyKey = `desktop:${grant.id}:${createHash('sha256').update(input.idempotencyKey).digest('hex')}`;
  const existing = state.teamTasks.find(task => task.idempotencyKey === idempotencyKey && task.createdByAgentId === null);
  if (existing && (existing.externalClient?.id !== grant.id || !sameScope(existing.scope, grant.scope)
    || existing.title !== input.title || existing.description !== input.description)) fail('MCP_CONFLICT');
  return { scope: { ...grant.scope }, title: input.title, description: input.description, idempotencyKey,
    budgetTeamId: grant.budgetTeamId, budgetProjectId: grant.scope.type === 'project' ? grant.scope.id : null };
}
export function readDesktopMcp(state: WorkspaceState, grant: DesktopMcpGrant, operation: string, args: unknown): unknown {
  validateDesktopMcpScope(state, grant);
  switch (operation) {
    case 'app_context': {
      const { offset, limit } = desktopMcpSchemas.app_context.parse(args);
      const target = grant.scope.type === 'team' ? state.teams.find(team => team.id === grant.scope.id)! : state.projects.find(project => project.id === grant.scope.id)!;
      const teams = grant.scope.type === 'team' ? state.teams.filter(team => team.id === grant.scope.id)
        : state.teams.filter(team => state.projects.find(project => project.id === grant.scope.id)!.teamIds.includes(team.id));
      const members = new Set(teams.flatMap(team => team.memberIds));
      return { scope: { type: grant.scope.type, id: grant.scope.id, name: take(target.name, 120), description: take(target.description, 1000),
        ...(grant.scope.type === 'team' && 'workflow' in target ? { workflow: take(target.workflow, 4000) } : {}) },
        members: paged(state.agents.filter(agent => members.has(agent.id)).map(agent => ({ id: agent.id, name: take(agent.name, 120), status: agent.status })), offset, limit),
        permissions: { submitTasks: grant.submitTasks } };
    }
    case 'app_task_list': {
      const { offset, limit, status } = desktopMcpSchemas.app_task_list.parse(args);
      return paged(state.teamTasks.filter(task => sameScope(task.scope, grant.scope) && (!status || task.status === status)).map(taskMetadata), offset, limit);
    }
    case 'app_task_read': {
      const { taskId, offset, limit } = desktopMcpSchemas.app_task_read.parse(args);
      const task = state.teamTasks.find(task => task.id === taskId && sameScope(task.scope, grant.scope));
      if (!task) return fail('MCP_NOT_FOUND');
      return desktopMcpTaskResult(state, grant, task, offset, limit);
    }
    case 'app_artifact_list': {
      const { offset, limit } = desktopMcpSchemas.app_artifact_list.parse(args);
      return paged(state.sharedArtifacts.filter(artifact => sameScope(artifact.scope, grant.scope)).map(artifactMetadata), offset, limit);
    }
    case 'app_artifact_read': {
      const { artifactId, offset, limit } = desktopMcpSchemas.app_artifact_read.parse(args);
      const artifact = state.sharedArtifacts.find(artifact => artifact.id === artifactId && sameScope(artifact.scope, grant.scope));
      if (!artifact) return fail('MCP_NOT_FOUND');
      return { ...artifactMetadata(artifact), content: textPage([{ field: 'content', text: artifact.content }], offset, limit) };
    }
    case 'app_run_read': {
      const { runId, offset, limit } = desktopMcpSchemas.app_run_read.parse(args);
      const tasks = state.teamTasks.filter(task => sameScope(task.scope, grant.scope) && (task.claimedRunId === runId || task.claimRunIds?.includes(runId)));
      const run = tasks.length ? state.runs.find(run => run.id === runId) : undefined;
      if (!run) return fail('MCP_NOT_FOUND');
      return { id: run.id, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt,
        error: run.error ? '실행 오류가 기록됐습니다. 자세한 내용은 작업실에서 확인할 수 있습니다.' : null,
        result: textPage([{ field: 'result', text: run.result }], offset, limit),
        artifacts: artifactLinks(state, grant.scope, tasks.flatMap(task => task.artifactIds), offset, limit) };
    }
    default: return fail('MCP_INPUT_INVALID');
  }
}
export function boundedDesktopMcpResult(value: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return fail('MCP_RESPONSE_LIMIT');
  return value;
}
