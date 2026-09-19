import type { Connection, Run } from '../shared/types.ts';
import type { WorkspaceState } from './store.ts';
import { runAttribution } from './budget-attribution.ts';
import { canAccessCollaborationScope } from './collaboration.ts';

export class RepositoryAccessError extends Error { readonly statusCode = 403; }

export function repositoryAccess(state: WorkspaceState, run: Run, connectionId: string, write = false): Connection {
  const agent = state.agents.find(a => a.id === run.agentId);
  const frozen = state.executionStates[run.id]?.input;
  const previous = frozen?.connections.find(c => c.id === connectionId);
  const connection = state.connections.find(c => c.id === connectionId);
  const denied = () => new RepositoryAccessError('현재 실행·에이전트·팀·프로젝트에 허용된 GitHub 접근 범위가 아닙니다.');
  if (!agent?.repositoryIds.includes(connectionId) || !frozen?.agent.repositoryIds.includes(connectionId)
    || !previous?.github || !connection?.github || previous.github.status !== 'connected' || connection.github.status !== 'connected'
    || previous.github.generation !== connection.github.generation || previous.github.repositoryId !== connection.github.repositoryId
    || previous.repository !== connection.repository || previous.github.defaultBranch !== connection.github.defaultBranch) throw denied();
  const attribution = runAttribution(state, run);
  const matches = (c: Connection) => c.grants?.some(g => g.agentId === agent.id
    && g.teamId === attribution.teamId && g.projectId === attribution.projectId
    && (!write || g.access === 'write' && c.access === 'write')
    && state.teams.some(t => t.id === g.teamId && t.memberIds.includes(agent.id))
    && state.projects.some(p => p.id === g.projectId && p.teamIds.includes(g.teamId))
    && canAccessCollaborationScope(state, agent.id, { type: 'project', id: g.projectId }));
  if (!matches(previous) || !matches(connection)) throw denied();
  return connection;
}

export function availableRepositories(state: WorkspaceState, run: Run): Connection[] {
  return (state.executionStates[run.id]?.input.connections ?? []).flatMap(c => {
    try { return [repositoryAccess(state, run, c.id)]; } catch { return []; }
  });
}

/** A PR URL or matching branch prefix is not authority. Bind the original
 * publisher's frozen scope to the already-authorized caller; the service then
 * requires the independent, completed installation journal receipt as proof.
 * No current membership of the old author is required for a team handoff.
 */
export function repositoryPublicationOrigin(state: WorkspaceState, run: Run, connection: Connection, branch: string) {
  const match = /^agent-company\/([a-f0-9-]{36})\/([a-z0-9][a-z0-9-]{0,59})$/.exec(branch);
  const denied = () => new RepositoryAccessError('이 PR의 원래 게시와 현재 프로젝트·팀·연결 세대가 일치하지 않습니다.');
  const origin = match && state.runs.find(item => item.id === match[1]);
  const frozen = origin ? state.executionStates[origin.id]?.input : undefined;
  const prior = frozen?.connections.find(item => item.id === connection.id);
  if (!origin || !frozen || frozen.agent.id !== origin.agentId
    || !frozen.agent.repositoryIds.includes(connection.id) || !prior?.github || prior.github.status !== 'connected'
    || prior.github.generation !== connection.github?.generation || prior.github.repositoryId !== connection.github.repositoryId
    || prior.repository !== connection.repository || prior.github.defaultBranch !== connection.github.defaultBranch) throw denied();
  const currentScope = runAttribution(state, run), oldScope = runAttribution(state, origin);
  if (!oldScope.projectId || !oldScope.teamId || oldScope.projectId !== currentScope.projectId || oldScope.teamId !== currentScope.teamId
    || prior.access !== 'write' || !prior.grants?.some(grant => grant.agentId === origin.agentId && grant.access === 'write'
      && grant.projectId === oldScope.projectId && grant.teamId === oldScope.teamId)) throw denied();
  return { origin, operationId: match![2], generation: prior.github.generation };
}
