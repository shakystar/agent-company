import type { OperatorRequest } from '../shared/operator-requests.ts';
import { z } from 'zod';
import type { Run } from '../shared/types.ts';
import type { WorkspaceState } from './store.ts';
import { canAccessOperatorRequestScope } from './operator-requests.ts';
import { environmentSpecHash, selectEnvironment } from './environments.ts';

const nonempty = z.string().min(1);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const githubVerificationIdentity = z.object({ repository: nonempty, access: z.enum(['read', 'write']),
  github: z.object({ repositoryId: z.number().int().positive(), generation: nonempty, defaultBranch: nonempty }),
  scopedGrants: z.array(z.object({ agentId: nonempty, projectId: nonempty, teamId: nonempty,
    access: z.enum(['read', 'write']) })).min(1).max(100) });
const environmentVerificationIdentity = z.object({ revisionId: nonempty, buildRunId: nonempty,
  contentHash: fingerprint, reportHash: fingerprint, specHash: fingerprint });

export function operatorRequestVerified(request: OperatorRequest): boolean {
  return request.decision.status === 'approved' && request.decision.contentVersion === request.contentVersion
    && request.processing.status === 'verified' && request.verification?.passed === true
    && request.verification.contentVersion === request.contentVersion;
}

/** Current scope and concrete resource must still be usable at the resume boundary. */
export function operatorResourceBlock(state: WorkspaceState, request: OperatorRequest, run?: Run): string | null {
  if (!canAccessOperatorRequestScope(state, request.requesterAgentId, request.scope)) return '현재 요청 범위 접근 권한을 기다립니다.';
  const verification = request.verification;
  if (!verification) return '실제 처리 결과 검증을 기다립니다.';
  if (verification.method === 'github') {
    const connection = state.connections.find(item => item.id === verification.resourceId);
    const agent = state.agents.find(item => item.id === request.requesterAgentId);
    const projectId = run?.budgetProjectId ?? (request.scope.type === 'project' ? request.scope.id : null);
    let identity: z.infer<typeof githubVerificationIdentity>;
    try { identity = githubVerificationIdentity.parse(JSON.parse(verification.evidence)); }
    catch { return 'GitHub 검증 근거의 리소스·권한 식별자를 확인할 수 없습니다.'; }
    if (!connection || connection.github?.status !== 'connected' || !agent?.repositoryIds.includes(connection.id)
      || identity.repository !== connection.repository || identity.github?.repositoryId !== connection.github.repositoryId
      || identity.github?.generation !== connection.github.generation || identity.github?.defaultBranch !== connection.github.defaultBranch
      || identity.access === 'write' && connection.access !== 'write'
      || !identity.scopedGrants.every(verifiedGrant => verifiedGrant.agentId === agent.id && verifiedGrant.projectId === projectId
        && (!run?.budgetTeamId || verifiedGrant.teamId === run.budgetTeamId)
        && connection.grants?.some(grant => grant.agentId === verifiedGrant.agentId && grant.projectId === verifiedGrant.projectId
          && grant.teamId === verifiedGrant.teamId && grant.access === verifiedGrant.access)
        && state.teams.some(team => team.id === verifiedGrant.teamId && team.memberIds.includes(agent.id))
        && state.projects.some(project => project.id === verifiedGrant.projectId && project.teamIds.includes(verifiedGrant.teamId)))) {
      return 'GitHub 실제 연결과 해당 프로젝트·팀의 현재 권한을 기다립니다.';
    }
  }
  if (verification.method === 'environment') {
    try {
      const selected = selectEnvironment(state, request.requesterAgentId, verification.resourceId);
      if (!selected || !selected.report.checks.every(check => check.passed)
        || !state.runs.some(item => item.id === selected.buildRunId && item.status === 'succeeded')) return '성공한 환경 구축 결과가 필요합니다.';
      const identity = environmentVerificationIdentity.parse(JSON.parse(verification.evidence));
      if (identity.revisionId !== selected.revisionId || identity.buildRunId !== selected.buildRunId
        || identity.contentHash !== selected.report.contentHash || identity.reportHash !== environmentSpecHash(selected.report)
        || identity.specHash !== environmentSpecHash(selected.spec)) return '검증 당시 환경 구성·보고서와 현재 환경이 일치하지 않습니다.';
    } catch { return '검증된 실행 환경을 기다립니다.'; }
  }
  return null;
}

export function validOperatorContinuation(state: WorkspaceState, run: Run): Run | undefined {
  if (!run.continuedFromRunId || !run.operatorRequestId) return;
  const source = state.runs.find(item => item.id === run.continuedFromRunId);
  const request = state.operatorRequests.find(item => item.id === run.operatorRequestId);
  if (!source || !request || source.status !== 'superseded' || source.continuedByRunId !== run.id
    || source.agentId !== run.agentId || request.requesterAgentId !== run.agentId
    || source.budgetRootRunId !== run.budgetRootRunId || source.budgetTeamId !== run.budgetTeamId
    || source.budgetProjectId !== run.budgetProjectId || source.objectiveId !== run.objectiveId) return;
  const receipt = request.resumeReceipts.find(item => item.runId === source.id && item.continuedRunId === run.id);
  if (!receipt || !request.history.some(item => item.verification?.id === receipt.verificationId
    && item.verification.passed && item.verification.contentVersion === receipt.contentVersion)) return;
  return source;
}
