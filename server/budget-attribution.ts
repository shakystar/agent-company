import type { WorkspaceState } from './store.ts';
import type { Run } from '../shared/types.ts';
import type { BudgetAttribution } from '../shared/operational-budget.ts';
import type { PeerMessage } from '../shared/collaboration.ts';

type AttributionState = Pick<WorkspaceState, 'teams' | 'projects' | 'messages' | 'teamTasks'>
  & Partial<Pick<WorkspaceState, 'runs' | 'executionStates' | 'messageOrigins' | 'conversations' | 'conversationMessages'>>;
type Scope = { type: 'agent' | 'team' | 'project'; id: string };

export class BudgetAttributionError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** New-task selection only. Never use current membership to backfill history. */
export function teamForScope(state: Pick<WorkspaceState, 'teams' | 'projects'>, scope: Scope,
  projectId: string | null, selected?: string | null): string | null {
  if (scope.type === 'team') {
    if (!state.teams.some(team => team.id === scope.id)) throw new BudgetAttributionError(404, '팀이 없습니다.');
    if (selected !== undefined && selected !== scope.id) throw new BudgetAttributionError(403, '팀 작업 공간의 원팀은 변경하거나 제외할 수 없습니다.');
    return scope.id;
  }
  const project = projectId ? state.projects.find(item => item.id === projectId) : undefined;
  if (projectId && !project) throw new BudgetAttributionError(404, '프로젝트가 없습니다.');
  const eligible = state.teams.filter(team => (scope.type === 'project' || team.memberIds.includes(scope.id))
    && (!project || project.teamIds.includes(team.id)));
  if (selected === null) {
    if (projectId !== null || scope.type === 'project') throw new BudgetAttributionError(403, '프로젝트 과제의 원팀을 제외할 수 없습니다.');
    return null;
  }
  if (selected !== undefined) {
    if (!eligible.some(team => team.id === selected)) throw new BudgetAttributionError(403, '현재 작업 공간과 프로젝트에 연결된 팀만 원팀으로 지정할 수 있습니다.');
    return selected;
  }
  if (eligible.length > 1) throw new BudgetAttributionError(400, '적격 팀이 여러 곳입니다. 원래 과제의 팀 한 곳을 명시해야 합니다.');
  if (!eligible.length && projectId !== null) throw new BudgetAttributionError(400, '프로젝트 과제의 적격 원팀이 없습니다.');
  return eligible[0]?.id ?? null;
}

/** Historical evidence only: absent means unrecorded, null means explicit personal work. */
function historicalPeerTeam(state: AttributionState, message: PeerMessage, visited: Set<string>): string | null | undefined {
  if (message.budgetTeamId !== undefined) return message.budgetTeamId;
  const key = `peer-team:${message.id}`;
  if (visited.has(key)) return undefined;
  visited.add(key);
  const sourceId = message.budgetRootRunId ?? state.messageOrigins?.[message.id];
  if (sourceId) {
    const source = state.runs?.find(run => run.id === sourceId);
    return source ? historicalRunTeam(state, source, visited) : undefined;
  }
  if (message.replyToId) {
    const original = state.messages.find(item => item.id === message.replyToId);
    return original ? historicalPeerTeam(state, original, visited) : undefined;
  }
  const task = message.taskId ? state.teamTasks.find(item => item.id === message.taskId) : undefined;
  if (task?.budgetTeamId !== undefined) return task.budgetTeamId;
  if (task?.scope.type === 'team') return task.scope.id;
  return message.scope.type === 'team' ? message.scope.id : undefined;
}

export function historicalRunTeam(state: AttributionState, run: Run, visited = new Set<string>()): string | null | undefined {
  if (run.budgetTeamId !== undefined) return run.budgetTeamId;
  if (visited.has(run.id)) return undefined;
  visited.add(run.id);
  const rootId = run.budgetRootRunId && run.budgetRootRunId !== run.id ? run.budgetRootRunId
    : state.executionStates?.[run.id]?.input.growth?.sourceRunId;
  if (rootId && rootId !== run.id) {
    const root = state.runs?.find(item => item.id === rootId);
    return root ? historicalRunTeam(state, root, visited) : undefined;
  }
  const message = run.conversationMessageId ? state.conversationMessages?.find(item => item.id === run.conversationMessageId) : undefined;
  if (message?.budgetTeamId !== undefined) return message.budgetTeamId;
  const sources = (run.messageIds ?? []).map(id => state.messages.find(item => item.id === id)).filter((item): item is PeerMessage => Boolean(item));
  if (sources.length) {
    const teams = sources.map(item => historicalPeerTeam(state, item, new Set(visited)));
    return new Set(teams).size === 1 ? teams[0] : undefined;
  }
  const task = run.teamTaskId ? state.teamTasks.find(item => item.id === run.teamTaskId) : undefined;
  if (task?.budgetTeamId !== undefined) return task.budgetTeamId;
  if (task?.scope.type === 'team') return task.scope.id;
  const conversation = run.conversationId ? state.conversations?.find(item => item.id === run.conversationId) : undefined;
  // Joining an existing peer thread can attach a room after the original task
  // started. Its scope is not proof of that task's original team.
  if (conversation?.legacyThreadId) return undefined;
  if (conversation?.budgetTeamId !== undefined) return conversation.budgetTeamId;
  return conversation?.scope.type === 'team' ? conversation.scope.id : undefined;
}

export function historicalBudgetAttribution(state: AttributionState, entry: { runId: string; rootRunId: string; projectId: string | null }) {
  const run = state.runs?.find(item => item.id === entry.runId);
  const root = state.runs?.find(item => item.id === entry.rootRunId);
  const teamId = run?.budgetTeamId !== undefined ? run.budgetTeamId : root ? historicalRunTeam(state, root) : run ? historicalRunTeam(state, run) : undefined;
  return { ...(run ? { agentId: run.agentId } : {}), ...(teamId !== undefined ? { teamId } : {}) };
}
export function projectForScope(state: Pick<WorkspaceState, 'teams' | 'projects'>, scope: { type: 'agent' | 'team' | 'project'; id: string }, selected?: string | null): string | null {
  if (scope.type === 'project') {
    if (selected !== undefined && selected !== scope.id) throw new BudgetAttributionError(403, '프로젝트 작업의 원래 예산 귀속은 변경할 수 없습니다.');
    if (!state.projects.some(project => project.id === scope.id)) throw new BudgetAttributionError(404, '프로젝트가 없습니다.');
    return scope.id;
  }
  const teamIds = scope.type === 'team' ? [scope.id] : state.teams.filter(team => team.memberIds.includes(scope.id)).map(team => team.id);
  const eligible = state.projects.filter(project => project.teamIds.some(id => teamIds.includes(id)));
  if (selected === null) return null;
  if (selected !== undefined) {
    if (!eligible.some(project => project.id === selected)) throw new BudgetAttributionError(403, '현재 작업 공간에 연결된 프로젝트만 예산 귀속으로 지정할 수 있습니다.');
    return selected;
  }
  if (eligible.length > 1) throw new BudgetAttributionError(400, '연결된 프로젝트가 여러 개입니다. 원래 과제 프로젝트 또는 개인 작업을 명시해야 합니다.');
  return eligible[0]?.id ?? null;
}

export function runAttribution(state: AttributionState, run: Run, visited = new Set<string>()): BudgetAttribution {
  if (run.budgetRootRunId && run.budgetProjectId !== undefined) {
    const teamId = historicalRunTeam(state, run);
    if (teamId !== undefined) run.budgetTeamId = teamId;
    return { projectId: run.budgetProjectId, rootRunId: run.budgetRootRunId, teamId, agentId: run.agentId };
  }
  if (visited.has(run.id)) throw new BudgetAttributionError(409, '원래 과제 귀속에 순환 참조가 있습니다.');
  visited.add(run.id);
  const growthSource = state.executionStates?.[run.id]?.input.growth?.sourceRunId;
  const origin = growthSource ? state.runs?.find(item => item.id === growthSource && item.id !== run.id) : undefined;
  let attribution: BudgetAttribution;
  if (origin) attribution = runAttribution(state, origin, visited);
  else {
    const messages = (run.messageIds ?? []).map(id => state.messages.find(message => message.id === id)).filter((message): message is PeerMessage => Boolean(message));
    const sourceMessages = messages.map(message => peerAttribution(state, message, visited));
    const projects = new Set(sourceMessages.map(value => value.projectId));
    if (projects.size > 1) throw new BudgetAttributionError(409, '여러 원래 프로젝트의 요청이 한 실행에 섞여 있습니다. 분리된 실행이 필요합니다.');
    if (new Set(sourceMessages.map(value => value.teamId)).size > 1) throw new BudgetAttributionError(409, '서로 다른 원팀의 요청은 분리된 실행이 필요합니다.');
    const task = run.teamTaskId ? state.teamTasks.find(item => item.id === run.teamTaskId) : undefined;
    const conversation = run.conversationId ? state.conversations?.find(item => item.id === run.conversationId) : undefined;
    const message = run.conversationMessageId ? state.conversationMessages?.find(item => item.id === run.conversationMessageId) : undefined;
    const projectId = run.budgetProjectId !== undefined ? run.budgetProjectId : message?.budgetProjectId !== undefined ? message.budgetProjectId
      : sourceMessages.length ? sourceMessages[0].projectId : task?.budgetProjectId !== undefined ? task.budgetProjectId
      : task ? projectForScope(state, task.scope) : conversation?.budgetProjectId !== undefined ? conversation.budgetProjectId
      : conversation ? projectForScope(state, conversation.scope) : null;
    attribution = { projectId, rootRunId: message?.budgetRootRunId ?? sourceMessages.find(value => value.rootRunId)?.rootRunId ?? task?.budgetRootRunId ?? run.id,
      teamId: run.budgetTeamId !== undefined ? run.budgetTeamId : historicalRunTeam(state, run), agentId: run.agentId };
  }
  run.budgetProjectId = attribution.projectId; run.budgetRootRunId = attribution.rootRunId;
  if (attribution.teamId !== undefined) run.budgetTeamId = attribution.teamId;
  return { ...attribution, agentId: run.agentId };
}
export function peerAttribution(state: AttributionState, message: PeerMessage, visited = new Set<string>()): { projectId: string | null; rootRunId: string | null; teamId?: string | null } {
  if (message.budgetProjectId !== undefined) {
    const teamId = historicalPeerTeam(state, message, new Set());
    if (teamId !== undefined) message.budgetTeamId = teamId;
    return { projectId: message.budgetProjectId, rootRunId: message.budgetRootRunId ?? null, teamId };
  }
  if (visited.has(`message:${message.id}`)) throw new BudgetAttributionError(409, 'Message budget attribution contains a circular reference');
  visited.add(`message:${message.id}`);
  const sourceId = state.messageOrigins?.[message.id];
  const source = sourceId ? state.runs?.find(run => run.id === sourceId) : undefined;
  if (source && !visited.has(source.id)) {
    const attribution = runAttribution(state, source, visited);
    message.budgetProjectId = attribution.projectId; message.budgetRootRunId = attribution.rootRunId;
    if (attribution.teamId !== undefined) message.budgetTeamId = attribution.teamId;
    return attribution;
  }
  if (message.replyToId) {
    const original = state.messages.find(item => item.id === message.replyToId);
    if (original && original.id !== message.id) {
      const attribution = peerAttribution(state, original, visited);
      message.budgetProjectId = attribution.projectId; message.budgetRootRunId = attribution.rootRunId;
      if (attribution.teamId !== undefined) message.budgetTeamId = attribution.teamId;
      return attribution;
    }
  }
  const projectId = projectForScope(state, message.scope);
  const teamId = historicalPeerTeam(state, message, new Set());
  message.budgetProjectId = projectId; message.budgetRootRunId = null;
  if (teamId !== undefined) message.budgetTeamId = teamId;
  return { projectId, rootRunId: null, teamId };
}
