import { createHash, randomUUID } from 'node:crypto';
import { environmentBuildReportSchema, environmentProposalSchema, type EnvironmentProposal, type EnvironmentRevision, type EnvironmentSelection } from '../shared/environment.ts';
import type { Agent } from '../shared/types.ts';
import type { WorkspaceState } from './store.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const environmentSpecHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function selectEnvironment(state: WorkspaceState, agentId: string, id: string | null | undefined): EnvironmentSelection | undefined {
  if (!id) return;
  const revision = state.environmentRevisions.find(item => item.id === id && item.agentId === agentId);
  if (!revision || revision.status !== 'ready' || !revision.report || !revision.buildRunId || revision.requestedAccess.length) throw new Error('검증된 자신의 실행 환경만 선택할 수 있습니다.');
  return structuredClone({ revisionId: id, buildRunId: revision.buildRunId, spec: revision.spec, report: environmentBuildReportSchema.parse(revision.report) });
}
export function proposeEnvironment(state: WorkspaceState, agent: Agent, raw: EnvironmentProposal, sourceRunId: string | null): EnvironmentRevision {
  const proposal = environmentProposalSchema.parse(raw);
  const base = agent.environmentRevisionId ?? null;
  const current = state.environmentRevisions.find(item => item.id === base && item.agentId === agent.id && item.status === 'ready');
  if (current && !proposal.requestedAccess.length && environmentSpecHash(current.spec) === environmentSpecHash(proposal.spec)) return current;
  const duplicate = state.environmentRevisions.find(item => item.agentId === agent.id && item.baseRevisionId === base
    && item.sourceRunId === sourceRunId && environmentSpecHash(item.spec) === environmentSpecHash(proposal.spec)
    && JSON.stringify(item.requestedAccess) === JSON.stringify(proposal.requestedAccess)
    && (sourceRunId !== null || ['queued', 'building', 'blocked'].includes(item.status)));
  if (duplicate) return duplicate;
  const revision: EnvironmentRevision = { id: randomUUID(), agentId: agent.id, baseRevisionId: base, sourceRunId, buildRunId: null,
    ...structuredClone(proposal), status: proposal.requestedAccess.length ? 'blocked' : 'queued',
    error: proposal.requestedAccess.length ? '새 접근 범위가 필요합니다. 이번 실행기는 네트워크·계정·개인 파일 접근 없는 MCP만 지원하며 권한을 자동 확대하지 않습니다.' : null,
    createdAt: new Date().toISOString(), completedAt: null };
  state.environmentRevisions.unshift(revision); return revision;
}
export function forkEnvironment(state: WorkspaceState, sourceAgentId: string, target: Agent): void {
  const selected = selectEnvironment(state, sourceAgentId, target.environmentRevisionId);
  if (!selected) { target.environmentRevisionId = null; return; }
  const source = state.environmentRevisions.find(item => item.id === selected.revisionId)!;
  const revision: EnvironmentRevision = { ...structuredClone(source), id: randomUUID(), agentId: target.id,
    sourceRevisionId: source.id, baseRevisionId: null, sourceRunId: null, reason: '선택한 시점의 읽기 전용 환경에서 분기했습니다.', createdAt: new Date().toISOString() };
  state.environmentRevisions.unshift(revision); target.environmentRevisionId = revision.id;
}
