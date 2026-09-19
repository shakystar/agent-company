import type { Run } from '../shared/types.ts';
import type { TeamTask } from '../shared/collaboration.ts';
import type { WorkspaceState } from './store.ts';
import { canAccessCollaborationScope } from './collaboration.ts';
import { objectiveRunBlock } from './objectives.ts';
import { currentRun } from './run-control.ts';

const unfinished = (run: Run) => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status);
export interface DiscoveryBlock { reason: string; terminal: boolean }

function sourceBlock(state: WorkspaceState, task: TeamTask): DiscoveryBlock | null {
  if (task.objectiveId) {
    const objective = state.objectives?.find(item => item.id === task.objectiveId);
    if (!objective || objective.status !== 'active') return { reason: '목적이 중지되었거나 완료되어 과제를 자동 탐색하지 않습니다.', terminal: objective?.status !== 'paused' };
  }
  if (!task.budgetRootRunId) return null;
  const root = currentRun(state, task.budgetRootRunId);
  if (!root || root.status === 'cancelled') return { reason: '원래 작업이 없거나 사용자가 취소했습니다. 새 과제 탐색을 시작하지 않습니다.', terminal: true };
  if (root.status === 'paused' || root.pauseRequestedAt) return { reason: '원래 작업의 사용자 일시정지가 해제될 때까지 과제 탐색을 기다립니다.', terminal: false };
  return null;
}

function scopeAllowed(state: WorkspaceState, task: TeamTask, agentId: string): boolean {
  return canAccessCollaborationScope(state, agentId, task.scope)
    && (task.budgetProjectId === null || typeof task.budgetProjectId === 'string'
      && canAccessCollaborationScope(state, agentId, { type: 'project', id: task.budgetProjectId }));
}

/** Read-only candidate selection; receipt + Run creation must share the workspace transaction. */
export function discoverableTasks(state: WorkspaceState): Array<{ task: TeamTask; agentId: string; teamId: string }> {
  if (state.operatorPaused) return [];
  const candidates: Array<{ task: TeamTask; agentId: string; teamId: string }> = [];
  for (const task of [...state.teamTasks].reverse()) {
    const team = state.teams.find(team => team.id === task.budgetTeamId);
    if (!team?.autoDiscoverTasks || task.status !== 'open' || sourceBlock(state, task)) continue;
    for (const agentId of team.memberIds) {
      if (state.agents.find(agent => agent.id === agentId)?.status !== 'idle'
        || state.runs.some(run => run.agentId === agentId && (unfinished(run) || run.cleanupPending))
        || !scopeAllowed(state, task, agentId)
        || state.taskDiscoveries?.some(receipt => receipt.taskId === task.id && receipt.taskVersion === task.version && receipt.agentId === agentId)) continue;
      candidates.push({ task, agentId, teamId: team.id });
    }
  }
  return candidates;
}

/** Revalidate delayed admission. Opt-out never interrupts an already admitted discovery. */
export function taskDiscoveryBlock(state: WorkspaceState, run: Run): DiscoveryBlock | null {
  const objectiveBlock = objectiveRunBlock(state, run);
  if (objectiveBlock) return objectiveBlock;
  const discovery = run.taskDiscovery;
  if (!discovery) return null;
  const task = state.teamTasks.find(task => task.id === discovery.taskId);
  const team = state.teams.find(team => team.id === discovery.teamId);
  if (!task || !team?.memberIds.includes(run.agentId) || !scopeAllowed(state, task, run.agentId)) {
    return { reason: '공동 과제의 현재 접근 권한이 없어 탐색을 종료합니다.', terminal: true };
  }
  const source = sourceBlock(state, task);
  if (source && task.budgetRootRunId !== run.id) return source;
  if (!discovery.admittedAt) {
    if (!team.autoDiscoverTasks) return { reason: '팀의 자동 과제 탐색이 꺼져 있어 아직 시작하지 않은 탐색을 종료합니다.', terminal: true };
    if (task.status !== 'open' || task.version !== discovery.taskVersion) return { reason: '알림 이후 공동 과제의 상태가 변경되어 중복 탐색을 시작하지 않습니다.', terminal: true };
  }
  return null;
}
