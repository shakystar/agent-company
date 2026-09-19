import { createHash, randomUUID } from 'node:crypto';
import type { Run } from '../shared/types.ts';
import { createObjectiveSchema, objectiveAssessmentSchema, type Objective, type ObjectiveEvaluation, type ObjectiveEvaluationInput, type ObjectiveEvidence } from '../shared/objectives.ts';
import { z } from 'zod';
import type { WorkspaceState } from './store.ts';
import { canAccessCollaborationScope } from './collaboration.ts';
import { validOperatorContinuation } from './operator-request-resume.ts';
import { runControlBlocked } from './run-control.ts';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const objectiveHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const evidenceContentHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');
const artifactEvidenceHash = (evidence: ObjectiveEvidence[]) => objectiveHash([...new Set(evidence.filter(item => item.kind !== 'task_report')
  .map(item => canonical({ kind: item.kind, title: item.title, sha256: item.sha256 })))].sort());
const scopeMatches = (a: { type: string; id: string }, b: { type: string; id: string }) => a.type === b.type && a.id === b.id;
const unfinished = (run: Run) => ['queued', 'starting', 'running', 'waiting', 'paused'].includes(run.status) || Boolean(run.cleanupPending);

export function objectiveForRun(state: WorkspaceState, run: Run): Objective | undefined {
  const root = state.runs.find(item => item.id === run.budgetRootRunId);
  const id = run.objectiveId ?? root?.objectiveId;
  return id ? state.objectives?.find(item => item.id === id) : undefined;
}

/** A shared project request delegates work, never membership or ownership of its source task. */
function hasObjectiveDelegation(state: WorkspaceState, run: Run, objective: Objective, visited = new Set<string>()): boolean {
  if (objective.scope.type !== 'project' || visited.has(run.id) || run.objectiveEvaluationId || run.teamTaskId || run.taskDiscovery
    || run.budgetProjectId !== objective.scope.id || run.budgetTeamId !== objective.teamId || !run.budgetRootRunId
    || !canAccessCollaborationScope(state, run.agentId, objective.scope)) return false;
  const root = state.runs.find(item => item.id === run.budgetRootRunId);
  if (!root || root.objectiveId !== objective.id || root.budgetRootRunId !== root.id
    || root.budgetProjectId !== objective.scope.id || root.budgetTeamId !== objective.teamId
    || runControlBlocked(state, root.id)
    || !state.teams.find(team => team.id === objective.teamId)?.memberIds.includes(root.agentId)) return false;
  const next = new Set(visited).add(run.id);
  if (run.consultationOfRunId) {
    const source = state.runs.find(item => item.id === run.consultationOfRunId);
    const message = state.conversationMessages.find(item => item.id === run.conversationMessageId);
    if (!source || source.consultationOfRunId || source.agentId !== run.agentId || run.interactionMode !== 'discuss'
      || !['waiting', 'queued'].includes(source.status) || source.pauseRequestedAt || source.modelBudgetPaused || source.cleanupPending
      || !message || message.senderAgentId !== null || message.mode !== 'discuss' || message.recordOnly
      || message.conversationId !== run.conversationId || message.budgetProjectId !== run.budgetProjectId || message.budgetTeamId !== run.budgetTeamId
      || source.budgetRootRunId !== run.budgetRootRunId || source.budgetProjectId !== run.budgetProjectId || source.budgetTeamId !== run.budgetTeamId) return false;
    return hasObjectiveDelegation(state, source, objective, next);
  }
  const continuedSource = validOperatorContinuation(state, run);
  if (continuedSource) return hasObjectiveDelegation(state, continuedSource, objective, next);
  if (run.kind === 'review' || run.kind === 'repair') {
    const saved = state.executionStates[run.id]?.input;
    const growth = saved?.growth;
    const source = growth?.sourceRunId ? state.runs.find(item => item.id === growth.sourceRunId) : undefined;
    if (!source || growth?.mode !== run.kind || saved?.agent.id !== run.agentId || source.agentId !== run.agentId
      || source.status !== 'succeeded' || source.pauseRequestedAt || source.cleanupPending
      || objectiveForRun(state, source)?.id !== objective.id || source.budgetRootRunId !== root.id
      || source.budgetProjectId !== objective.scope.id || source.budgetTeamId !== objective.teamId
      || saved.growthReplay && saved.growthReplay.sourceRunId !== source.id) return false;
    return hasObjectiveDelegation(state, source, objective, next);
  }
  return (run.messageIds ?? []).some(id => {
    const message = state.messages.find(item => item.id === id);
    if (!message || state.deliveryRuns[id] !== run.id || message.recipientAgentId !== run.agentId || !message.senderAgentId
      || message.senderAgentId === run.agentId || !scopeMatches(message.scope, objective.scope)
      || message.budgetProjectId !== objective.scope.id || message.budgetTeamId !== objective.teamId
      || message.budgetRootRunId !== root.id) return false;
    const source = state.runs.find(item => item.id === state.messageOrigins[id]);
    if (!source || source.agentId !== message.senderAgentId || objectiveForRun(state, source)?.id !== objective.id
      || source.budgetRootRunId !== root.id || source.budgetProjectId !== objective.scope.id || source.budgetTeamId !== objective.teamId
      || runControlBlocked(state, source.id)
      || !canAccessCollaborationScope(state, source.agentId, objective.scope)) return false;
    return Boolean(state.teams.find(team => team.id === objective.teamId)?.memberIds.includes(source.agentId))
      || hasObjectiveDelegation(state, source, objective, next);
  });
}

export function objectiveRunBlock(state: WorkspaceState, run: Run): { reason: string; terminal: boolean } | null {
  const id = run.objectiveId ?? state.runs.find(item => item.id === run.budgetRootRunId)?.objectiveId;
  if (!id) return null;
  const objective = state.objectives?.find(item => item.id === id);
  if (!objective || objective.status === 'cancelled' || objective.status === 'completed') return { terminal: true, reason: '목적이 종료되어 추가 실행을 시작하지 않습니다.' };
  if (objective.status === 'paused') return { terminal: false, reason: '사용자가 목적을 일시정지했습니다.' };
  if (!objectiveScopeValid(state, objective) || !state.teams.find(team => team.id === objective.teamId)?.memberIds.includes(run.agentId)
      && !hasObjectiveDelegation(state, run, objective)
    || !canAccessCollaborationScope(state, run.agentId, objective.scope)) return { terminal: false, reason: '현재 목적의 팀·프로젝트 접근 권한을 기다립니다.' };
  return null;
}
export function objectiveScopeValid(state: WorkspaceState, objective: Pick<Objective, 'teamId' | 'scope'>): boolean {
  const team = state.teams.find(item => item.id === objective.teamId);
  return Boolean(team && team.memberIds.length && (objective.scope.type === 'team' ? objective.scope.id === team.id
    : state.projects.some(project => project.id === objective.scope.id && project.teamIds.includes(team.id))));
}

/** Content is frozen once, never silently truncated or re-read by the evaluator. */
export function objectiveInput(state: WorkspaceState, objective: Objective): ObjectiveEvaluationInput {
  const team = state.teams.find(item => item.id === objective.teamId);
  const artifacts = state.sharedArtifacts.filter(item => scopeMatches(item.scope, objective.scope)).sort((a, b) => a.id.localeCompare(b.id));
  const tasks = state.teamTasks.filter(item => scopeMatches(item.scope, objective.scope)).sort((a, b) => a.id.localeCompare(b.id));
  const evidence: ObjectiveEvidence[] = artifacts.map(item => ({ id: `artifact:${item.id}:${item.version}`, kind: 'artifact',
    sourceId: item.id, version: item.version, title: item.name, content: item.content, sha256: evidenceContentHash(item.content), hashEncoding: 'utf8' }));
  for (const task of tasks.filter(item => item.status === 'done')) evidence.push({ id: `task:${task.id}:${task.version}`, kind: 'task_report',
    sourceId: task.id, version: task.version, title: task.title, content: task.outcome, sha256: evidenceContentHash(task.outcome), hashEncoding: 'utf8' });
  for (const confirmation of objective.confirmations) evidence.push({ id: `confirmation:${confirmation.conditionId}`, kind: 'user_confirmation',
    sourceId: confirmation.conditionId, version: objective.version, title: '사용자 확인', content: confirmation.note, sha256: evidenceContentHash(confirmation.note), hashEncoding: 'utf8' });
  const fields = { objectiveId: objective.id, objectiveVersion: objective.version, title: objective.title, purpose: objective.purpose,
    constraints: objective.constraints, conditions: objective.conditions, evidence,
    teamContext: { workflow: team?.workflow ?? '',
      members: state.agents.filter(agent => team?.memberIds.includes(agent.id)).map(({ id, name, description, allowWeb }) => ({ id, name, description, allowWeb })),
      repositories: state.connections.filter(connection => connection.github?.status === 'connected').flatMap(connection => (connection.grants ?? [])
        .filter(grant => grant.teamId === objective.teamId && objective.scope.type === 'project' && grant.projectId === objective.scope.id
          && team?.memberIds.includes(grant.agentId) && state.agents.find(agent => agent.id === grant.agentId)?.repositoryIds.includes(connection.id))
        .map(grant => ({ connectionId: connection.id, repository: connection.repository, agentId: grant.agentId,
          access: connection.access === 'write' && grant.access === 'write' ? 'write' as const : 'read' as const }))) },
    priorTasks: tasks.map(item => ({ id: item.id, title: item.title, description: item.description, status: item.status, conditionIds: item.objectiveConditionIds ?? [] })) };
  if (evidence.length > 300 || tasks.length > 300 || Buffer.byteLength(canonical(fields)) > 1024 * 1024) throw new Error('목적 평가 자료가 1MiB 또는 300개 한도를 넘었습니다. 목적의 공유 범위를 정리한 뒤 재평가할 수 있습니다.');
  const scopeVersion = { team: team?.version ?? 0, project: state.projects.find(item => objective.scope.type === 'project' && item.id === objective.scope.id)?.version ?? null };
  return { ...fields, scopeVersion, artifactHash: artifactEvidenceHash(evidence),
    inputHash: objectiveHash({ ...fields, scopeVersion }) };
}

export function objectiveHasPendingWork(state: WorkspaceState, objective: Objective): boolean {
  return state.runs.some(run => objectiveForRun(state, run)?.id === objective.id && unfinished(run))
    || state.teamTasks.some(task => task.objectiveId === objective.id && task.status !== 'done');
}

export function applyObjectiveAssessment(state: WorkspaceState, objective: Objective, evaluation: ObjectiveEvaluation,
  input: ObjectiveEvaluationInput, raw: unknown, timestamp: string): void {
  const result = objectiveAssessmentSchema.parse(raw);
  if (evaluation.status !== 'queued') return;
  if (objective.status !== 'active' || objective.version !== input.objectiveVersion || objectiveInput(state, objective).inputHash !== input.inputHash) {
    evaluation.status = 'stale'; evaluation.reason = '평가 중 목적 또는 근거가 변경되어 결과를 적용하지 않았습니다.';
    evaluation.assessment = result; evaluation.completedAt = timestamp; return;
  }
  if (result.inputHash !== input.inputHash || result.conditions.length !== objective.conditions.length
    || new Set(result.conditions.map(item => item.conditionId)).size !== objective.conditions.length
    || result.conditions.some(item => !objective.conditions.some(condition => condition.id === item.conditionId))) throw new Error('목적 평가의 입력 또는 완료 조건이 일치하지 않습니다.');
  for (const item of result.conditions) {
    if (item.evidenceIds.some(id => !input.evidence.some(evidence => evidence.id === id))) throw new Error('평가가 고정 자료에 없는 근거를 참조했습니다.');
    const condition = objective.conditions.find(value => value.id === item.conditionId)!;
    if (item.status === 'met' && (!item.evidenceIds.length || condition.requiresUserConfirmation
      && !item.evidenceIds.includes(`confirmation:${condition.id}`))) throw new Error('완료 판정에 필요한 근거 또는 사용자 확인이 없습니다.');
  }
  const covered = new Set<string>();
  const titles = new Set<string>();
  for (const followUp of result.followUps) {
    const title = followUp.title.trim().toLocaleLowerCase();
    if (titles.has(title)) throw new Error('같은 평가에서 중복 제목의 과제를 생성할 수 없습니다.');
    titles.add(title);
    for (const id of followUp.conditionIds) {
      if (result.conditions.find(item => item.conditionId === id)?.status !== 'unmet' || covered.has(id)) throw new Error('후속 과제는 중복 없이 미완료 조건에만 연결해야 합니다.');
      covered.add(id);
    }
    if (state.teamTasks.some(task => scopeMatches(task.scope, objective.scope) && task.status !== 'done'
      && task.title.trim().toLocaleLowerCase() === followUp.title.trim().toLocaleLowerCase())) throw new Error('같은 열린 과제가 이미 있어 중복 생성하지 않았습니다.');
  }
  const previous = state.objectiveEvaluations?.find(item => item.objectiveId === objective.id && item.status === 'applied' && item.taskIds.length > 0);
  const unchanged = previous && previous.objectiveVersion === objective.version && previous.artifactHash === input.artifactHash
    && result.conditions.filter(item => item.status === 'met').every(item => previous.assessment?.conditions.some(old => old.conditionId === item.conditionId && old.status === 'met'));
  evaluation.assessment = result; evaluation.status = 'applied'; evaluation.reason = result.reason; evaluation.completedAt = timestamp;
  objective.lastEvaluationId = evaluation.id; objective.updatedAt = timestamp;
  const pending = result.conditions.filter(item => item.status !== 'met');
  if (!pending.length) {
    objective.status = 'completed'; objective.blockedReason = null; return;
  }
  if (unchanged && result.followUps.length) {
    objective.blockedReason = '후속 작업 이후 새 자료나 완료 조건의 진전이 없어 반복 생성을 보류했습니다. 새 근거나 사용자 재평가를 기다립니다.';
    evaluation.reason = objective.blockedReason; return;
  }
  for (const followUp of result.followUps) {
    const taskId = randomUUID();
    state.teamTasks.unshift({ id: taskId, idempotencyKey: `objective:${evaluation.id}:${evaluation.taskIds.length}`, scope: structuredClone(objective.scope),
      title: followUp.title, description: `사용자 목적: ${objective.purpose}\n작업 범위: ${objective.constraints || '등록된 목적과 기존 권한 범위'}\n완료 조건: ${followUp.conditionIds.map(id => objective.conditions.find(item => item.id === id)!.text).join('; ')}\n\n${followUp.description}`,
      status: 'open', assigneeAgentId: null, createdByAgentId: null, version: 1, outcome: '', artifactIds: [], claimedRunId: null, claimRunIds: [],
      budgetTeamId: objective.teamId, budgetProjectId: objective.scope.type === 'project' ? objective.scope.id : null, budgetRootRunId: evaluation.runId,
      objectiveId: objective.id, objectiveConditionIds: followUp.conditionIds, objectiveEvaluationId: evaluation.id,
      createdAt: timestamp, updatedAt: timestamp, completedAt: null });
    evaluation.taskIds.push(taskId);
  }
  objective.blockedReason = evaluation.taskIds.length ? null : pending.map(item => item.reason).join('\n');
}

/** Backups keep historical evaluation inputs even after the purpose or scope changes. */
export function validateObjectiveState(state: WorkspaceState): void {
  if (state.objectives === undefined) state.objectives = [];
  if (state.objectiveEvaluations === undefined) state.objectiveEvaluations = [];
  const objectiveSchema = createObjectiveSchema.extend({ id: z.uuid(), confirmations: z.array(z.object({ conditionId: z.string(), note: z.string(), createdAt: z.iso.datetime() }).strict()),
    status: z.enum(['active', 'paused', 'completed', 'cancelled']), version: z.number().int().positive(),
    blockedReason: z.string().nullable(), lastInputHash: z.string().nullable(), lastEvaluationId: z.uuid().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
  z.array(objectiveSchema).max(10_000).parse(state.objectives);
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  const evidenceSchema = z.object({ id: z.string().min(1).max(200), kind: z.enum(['artifact', 'task_report', 'user_confirmation']),
    sourceId: z.string().min(1).max(200), version: z.number().int().positive(), title: z.string().max(200), sha256: digest,
    hashEncoding: z.literal('utf8').optional() }).strict();
  const evaluationSchema = z.object({ id: z.uuid(), objectiveId: z.uuid(), objectiveVersion: z.number().int().positive(), inputHash: digest,
    artifactHash: digest, runId: z.uuid(), status: z.enum(['queued', 'applied', 'stale', 'failed']), assessment: objectiveAssessmentSchema.nullable(),
    taskIds: z.array(z.uuid()).max(10).refine(ids => new Set(ids).size === ids.length), reason: z.string().max(20_000),
    createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), evidence: z.array(evidenceSchema).max(300) }).strict();
  z.array(evaluationSchema).max(100_000).parse(state.objectiveEvaluations);
  for (const items of [state.objectives, state.objectiveEvaluations]) if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('목적 기록 식별자가 중복됐습니다.');
  for (const evaluation of state.objectiveEvaluations) {
    z.uuid().parse(evaluation.id);
    const objective = state.objectives.find(item => item.id === evaluation.objectiveId);
    const run = state.runs.find(item => item.id === evaluation.runId);
    const input = state.executionStates[evaluation.runId]?.input.objectiveEvaluation;
    if (!objective || !run || run.objectiveEvaluationId !== evaluation.id || run.objectiveId !== objective.id || !input
      || input.objectiveId !== objective.id || input.objectiveVersion !== evaluation.objectiveVersion || input.inputHash !== evaluation.inputHash
      || input.artifactHash !== evaluation.artifactHash || !Array.isArray(input.evidence) || input.evidence.length > 300) throw new Error('목적 평가의 원본 입력·실행 참조가 일치하지 않습니다.');
    const { inputHash, artifactHash: _artifactHash, ...content } = input;
    if (objectiveHash(content) !== inputHash || Buffer.byteLength(canonical(input)) > 1100 * 1024) throw new Error('목적 평가의 고정 입력 해시가 일치하지 않습니다.');
    if (artifactEvidenceHash(input.evidence) !== evaluation.artifactHash) throw new Error('목적 평가의 진전 비교 해시가 일치하지 않습니다.');
    if (objectiveHash(input.evidence.map(({ content: _text, ...metadata }) => metadata)) !== objectiveHash(evaluation.evidence)) throw new Error('목적 평가의 근거 원문과 메타데이터가 일치하지 않습니다.');
    for (const evidence of input.evidence) {
      const expectedHash = evidence.hashEncoding === 'utf8' ? evidenceContentHash(evidence.content) : objectiveHash(evidence.content);
      if (expectedHash !== evidence.sha256) throw new Error(evidence.hashEncoding === 'utf8'
        ? '목적 평가 근거의 UTF-8 원문 SHA-256이 일치하지 않습니다.' : '과거 목적 평가 근거의 JSON 문자열 해시가 일치하지 않습니다.');
      if (evidence.kind === 'artifact') {
        const artifact = state.sharedArtifacts.find(item => item.id === evidence.sourceId);
        const source = artifact?.version === evidence.version ? artifact : artifact?.history.find(item => item.version === evidence.version);
        if (!source || source.content !== evidence.content) throw new Error('목적 평가가 참조한 산출물의 고정 버전이 없습니다.');
      }
    }
    if (evaluation.assessment) objectiveAssessmentSchema.parse(evaluation.assessment);
    if (evaluation.taskIds.some(id => !state.teamTasks.some(task => task.id === id && task.objectiveId === objective.id && task.objectiveEvaluationId === evaluation.id))) throw new Error('목적 평가의 후속 과제 참조가 없습니다.');
  }
  for (const run of state.runs) {
    if (run.objectiveId && !state.objectives.some(item => item.id === run.objectiveId)) throw new Error('실행의 목적 참조가 없습니다.');
    if (run.objectiveEvaluationId && !state.objectiveEvaluations.some(item => item.id === run.objectiveEvaluationId && item.runId === run.id)) throw new Error('실행의 목적 평가 참조가 없습니다.');
  }
  for (const task of state.teamTasks) {
    if (task.objectiveId && !state.objectives.some(item => item.id === task.objectiveId)) throw new Error('과제의 목적 참조가 없습니다.');
    if (task.objectiveEvaluationId && !state.objectiveEvaluations.some(item => item.id === task.objectiveEvaluationId && item.taskIds.includes(task.id))) throw new Error('과제의 목적 평가 참조가 없습니다.');
  }
  for (const objective of state.objectives) if (objective.lastEvaluationId && !state.objectiveEvaluations.some(item => item.id === objective.lastEvaluationId && item.objectiveId === objective.id)) throw new Error('목적의 마지막 평가 참조가 없습니다.');
}
