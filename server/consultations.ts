import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionResult, Run } from '../shared/types.ts';
import type { ConversationMessage } from '../shared/conversations.ts';
import type { WorkspaceState } from './store.ts';
import { canAccessConversation } from './conversations.ts';
import { canAccessCollaborationScope } from './collaboration.ts';
import { runAttribution } from './budget-attribution.ts';
import { objectiveRunBlock } from './objectives.ts';

const unfinished = (run: Run) => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status);
export function operatorDiscussion(message: ConversationMessage): boolean {
  return message.senderAgentId === null && message.mode === 'discuss' && !message.recordOnly;
}
export function hasSavedWait(run: Run): boolean {
  return Boolean(run.waitingFor || run.waitingForOperatorRequest);
}
function scopeAvailable(state: WorkspaceState, run: Run): boolean {
  const attribution = runAttribution(state, run);
  // The billing team of a project delegation is its original team, not a
  // membership grant to that team. Preserve it while checking actual project access.
  if (attribution.projectId) return canAccessCollaborationScope(state, run.agentId, { type: 'project', id: attribution.projectId })
    && Boolean(attribution.teamId && state.projects.find(item => item.id === attribution.projectId)?.teamIds.includes(attribution.teamId));
  return (!attribution.teamId || canAccessCollaborationScope(state, run.agentId, { type: 'team', id: attribution.teamId }))
    && !attribution.projectId;
}
/** Only an explicit operator consultation may coexist with one quiescent waiting task. */
export function consultationSource(state: WorkspaceState, agentId: string, message: ConversationMessage): Run | undefined {
  if (!operatorDiscussion(message) || state.operatorPaused || !canAccessConversation(state, agentId, message.conversationId)) return;
  const runs = state.runs.filter(run => run.agentId === agentId && unfinished(run));
  const run = runs.length === 1 ? runs[0] : undefined;
  if (!run || run.consultationOfRunId || run.status !== 'waiting' || !hasSavedWait(run)
    || run.pauseRequestedAt || run.modelBudgetPaused || run.objectivePaused || run.cleanupPending
    || (run.kind && run.kind !== 'task') || state.agents.find(agent => agent.id === agentId)?.status === 'paused') return;
  const attribution = runAttribution(state, run);
  if (attribution.projectId !== (message.budgetProjectId ?? null) || attribution.teamId !== message.budgetTeamId
    || !scopeAvailable(state, run) || objectiveRunBlock(state, run)) return;
  return run;
}
/** Rechecked at admission, tool calls and result publication, never grants new scope. */
export function consultationBlock(state: WorkspaceState, run: Run): string | null {
  if (!run.consultationOfRunId) return null;
  const source = state.runs.find(item => item.id === run.consultationOfRunId);
  const message = state.conversationMessages.find(item => item.id === run.conversationMessageId);
  if (!source || source.agentId !== run.agentId || source.consultationOfRunId || !message || !operatorDiscussion(message)
    || run.interactionMode !== 'discuss') return '상담 원본과 사용자 요청이 일치하지 않습니다.';
  if (state.operatorPaused || source.pauseRequestedAt || source.status === 'paused'
    || state.agents.find(agent => agent.id === run.agentId)?.status === 'paused') return '원래 작업이 일시정지되어 상담을 중단합니다.';
  if (!['waiting', 'queued'].includes(source.status) || source.modelBudgetPaused || source.objectivePaused || source.cleanupPending) {
    return '원래 작업의 대기·실행 상태가 변경되어 상담을 중단합니다.';
  }
  const original = runAttribution(state, source), current = runAttribution(state, run);
  if (original.projectId !== current.projectId || original.teamId !== current.teamId || original.rootRunId !== current.rootRunId
    || message.conversationId !== run.conversationId || (message.budgetProjectId ?? null) !== current.projectId || message.budgetTeamId !== current.teamId
    || !run.conversationId || !canAccessConversation(state, run.agentId, run.conversationId)
    || !scopeAvailable(state, source) || !scopeAvailable(state, run)) return '상담의 현재 팀·프로젝트·대화 권한이 유효하지 않습니다.';
  return objectiveRunBlock(state, source)?.reason ?? null;
}
export function preserveCheckpointResult(run: Run, result: ExecutionResult): void {
  const attempt = run.attempt ?? 0;
  // A completed checkpoint replay must not publish the same attempt twice.
  if (run.checkpointResults?.some(item => item.attempt === attempt)) return;
  const entry = { id: randomUUID(), attempt, createdAt: new Date().toISOString(), result: result.result,
    artifacts: result.artifacts.map(item => ({ ...structuredClone(item), id: randomUUID() })) };
  run.checkpointResults = [...(run.checkpointResults ?? []), entry];
}

const checkpointResultsSchema = z.array(z.object({ id: z.uuid(), attempt: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  result: z.string().min(1).max(2_000_000), artifacts: z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(250),
    content: z.string().max(2_000_000), mediaType: z.string().min(1).max(100) }).strict()).max(25) }).strict());
/** Validate historical references without requiring historical scopes to remain granted. */
export function validateConsultationState(state: WorkspaceState): void {
  for (const run of state.runs) {
    if (run.checkpointResults !== undefined) {
      const entries = checkpointResultsSchema.parse(run.checkpointResults);
      if (new Set(entries.map(item => item.attempt)).size !== entries.length || new Set(entries.map(item => item.id)).size !== entries.length
        || entries.some(item => new Set(item.artifacts.map(artifact => artifact.id)).size !== item.artifacts.length)) throw new Error('대기 결과의 실행 차수나 식별자가 중복됩니다.');
    }
    if (run.consultationOfRunId === undefined) continue;
    z.uuid().parse(run.consultationOfRunId);
    const source = state.runs.find(item => item.id === run.consultationOfRunId);
    const message = state.conversationMessages.find(item => item.id === run.conversationMessageId);
    if (!source || source.consultationOfRunId || source.id === run.id || source.agentId !== run.agentId || run.interactionMode !== 'discuss'
      || run.workspaceSourceRunId || source.budgetRootRunId !== run.budgetRootRunId || source.budgetTeamId !== run.budgetTeamId
      || source.budgetProjectId !== run.budgetProjectId || !message || !operatorDiscussion(message)
      || message.conversationId !== run.conversationId || !message.deliveries.some(item => item.agentId === run.agentId && item.runId === run.id)) {
      throw new Error('상담 실행의 원본·사용자 요청·예산 귀속 기록이 올바르지 않습니다.');
    }
  }
  for (const message of state.conversationMessages) {
    if (message.consultationOfRunId !== undefined) {
      const run = state.runs.find(item => item.id === message.sourceRunId);
      if (!run || run.consultationOfRunId !== message.consultationOfRunId || run.agentId !== message.senderAgentId
        || run.conversationId !== message.conversationId) throw new Error('상담 응답과 실행 원본이 일치하지 않습니다.');
    }
    for (const delivery of message.deliveries) {
      if (delivery.consultationOfRunId === undefined) continue;
      z.uuid().parse(delivery.consultationOfRunId);
      const source = state.runs.find(item => item.id === delivery.consultationOfRunId);
      const consultation = delivery.runId ? state.runs.find(item => item.id === delivery.runId) : undefined;
      if (!source || source.agentId !== delivery.agentId || source.consultationOfRunId || !operatorDiscussion(message)
        || consultation && consultation.consultationOfRunId !== source.id) throw new Error('상담 전달의 원래 실행 참조가 올바르지 않습니다.');
    }
  }
}
