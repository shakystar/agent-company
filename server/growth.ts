import { createHash } from 'node:crypto';
import type { Skill } from '../shared/types.ts';
import type {
  ComparisonEvidence, GrowthPolicy, GrowthPurpose, GrowthReview, GrowthState,
  GrowthVerdict, RepairJob, SkillRevision, SkillRevisionOrigin,
} from '../shared/growth.ts';

export type GrowthDomainState = GrowthState & { skills: Skill[] };
export interface GrowthContext { now: string; newId: () => string }
export class GrowthError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'GrowthError'; }
}
const defaultPolicy: GrowthPolicy = { noProgressLimit: 2 };
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
export function skillRevisionHash(value: Pick<SkillRevision, 'name' | 'description' | 'content'>): string {
  return createHash('sha256').update(JSON.stringify({ name: value.name, description: value.description, content: value.content })).digest('hex');
}

function revision(state: GrowthState, id: string, agentId: string, skillId: string): SkillRevision {
  const found = state.skillRevisions.find(item => item.id === id);
  if (!found) throw new GrowthError(404, '스킬 버전을 찾을 수 없습니다.');
  if (found.agentId !== agentId || found.skillId !== skillId) throw new GrowthError(409, '다른 에이전트나 스킬의 버전은 적용할 수 없습니다.');
  return found;
}
function nextVersion(state: GrowthState, agentId: string, skillId: string, minimum = 1) {
  return Math.max(minimum, ...state.skillRevisions.filter(item => item.agentId === agentId && item.skillId === skillId).map(item => item.version + 1));
}
function activeSkill(state: GrowthDomainState, agentId: string, skillId: string) {
  return state.skills.find(item => item.agentId === agentId && item.id === skillId && item.status === 'active');
}
function knownNormal(state: GrowthState, value: SkillRevision, seen = new Set<string>()): boolean {
  if (seen.has(value.id)) return false;
  seen.add(value.id);
  if (value.inheritedFrom) {
    const source = state.skillRevisions.find(item => item.id === value.inheritedFrom!.revisionId && item.agentId === value.inheritedFrom!.agentId);
    return Boolean(source && knownNormal(state, source, seen));
  }
  return value.origin === 'legacy' || value.origin === 'manual'
    || state.growthReviews.some(review => review.agentId === value.agentId && review.skillId === value.skillId
      && review.candidateRevisionId === value.id && review.decision === 'activated');
}

/** Capture a legacy/manual projection before it is changed; never rewrite prior content. */
export function ensureSkillRevision(state: GrowthDomainState, skill: Skill, context: GrowthContext,
  origin: SkillRevisionOrigin = 'legacy'): SkillRevision {
  const previous = skill.activeRevisionId ? revision(state, skill.activeRevisionId, skill.agentId, skill.id) : undefined;
  if (previous && previous.version === skill.version && previous.name === skill.name && previous.description === skill.description && previous.content === skill.content) return previous;
  const value: SkillRevision = {
    id: context.newId(), agentId: skill.agentId, skillId: skill.id, name: skill.name,
    description: skill.description, content: skill.content,
    version: nextVersion(state, skill.agentId, skill.id, skill.version), parentRevisionId: previous?.id ?? null,
    sourceRunId: skill.sourceRunId, origin, createdAt: context.now,
  };
  state.skillRevisions.push(value); skill.activeRevisionId = value.id;
  return value;
}

export interface SkillCandidateInput {
  agentId: string; skillId: string; name: string; description: string; content: string;
  baselineRevisionId: string | null; sourceRunId: string; purpose: 'candidate' | 'repair';
}
export function registerSkillCandidate(state: GrowthDomainState, input: SkillCandidateInput, context: GrowthContext): SkillRevision {
  if (input.baselineRevisionId) revision(state, input.baselineRevisionId, input.agentId, input.skillId);
  const value: SkillRevision = {
    id: context.newId(), agentId: input.agentId, skillId: input.skillId, name: input.name,
    description: input.description, content: input.content, sourceRunId: input.sourceRunId,
    parentRevisionId: input.baselineRevisionId, origin: input.purpose,
    version: nextVersion(state, input.agentId, input.skillId), createdAt: context.now,
  };
  state.skillRevisions.push(value);
  return value;
}

function verifiedComparison(value: ComparisonEvidence | null): boolean {
  if (!value?.verified || !value.fingerprint || !value.baseline || !value.candidate) return false;
  const ids = [value.baseline.attemptId, value.candidate.attemptId, value.judgeAttemptId];
  return ids.every(id => typeof id === 'string' && id.trim().length > 0) && new Set(ids).size === 3
    && hash(value.fingerprint.promptHash) && hash(value.fingerprint.inputHash)
    && (value.fingerprint.baselineSkillHash === null || hash(value.fingerprint.baselineSkillHash)) && hash(value.fingerprint.candidateSkillHash)
    && Boolean(value.fingerprint.model?.trim() && value.fingerprint.image?.trim())
    && hash(value.baseline.resultHash) && hash(value.candidate.resultHash)
    && (!value.fingerprint.replayHash || hash(value.fingerprint.replayHash) && value.replay?.applicability === 'local' && value.replayApplicable === true)
    && typeof value.baseline.completed === 'boolean' && typeof value.candidate.completed === 'boolean'
    && Boolean(value.reason?.trim()) && Array.isArray(value.evidence) && value.evidence.some(item => typeof item === 'string' && item.trim())
    && ['improved', 'equivalent', 'regressed', 'inconclusive'].includes(value.verdict)
    && (value.verdict !== 'improved' || value.candidate.completed);
}

export interface GrowthAssessmentInput {
  agentId: string; skillId: string; baselineRevisionId: string | null; candidateRevisionId: string;
  sourceRunId: string; purpose: GrowthPurpose; comparison: ComparisonEvidence | null;
}
function projectRevision(state: GrowthDomainState, value: SkillRevision, review: GrowthReview, context: GrowthContext) {
  const current = state.skills.find(item => item.id === value.skillId && item.agentId === value.agentId);
  const projection: Skill = {
    id: value.skillId, agentId: value.agentId, name: value.name, description: value.description,
    content: value.content, version: value.version, status: 'active', evaluation: review.reason,
    sourceRunId: value.sourceRunId, createdAt: current?.createdAt ?? context.now, updatedAt: context.now,
    activeRevisionId: value.id,
  };
  if (current) Object.assign(current, projection); else state.skills.push(projection);
}

function updateRepairFromReview(state: GrowthDomainState, review: GrowthReview, context: GrowthContext, policy: GrowthPolicy) {
  let job = [...state.repairJobs].reverse().find(item => item.agentId === review.agentId && item.skillId === review.skillId
    && item.status !== 'resolved' && item.baselineRevisionId === review.baselineRevisionId);
  // A held job is an explicit boundary, including operator cancellation and the
  // no-progress limit. Later ordinary candidates still retain their own reviews,
  // but cannot resume, replace, or silently resolve that job automatically.
  if (job?.status === 'held') return;
  if (review.decision === 'activated') {
    if (job) { job.status = 'resolved'; job.candidateRevisionId = review.candidateRevisionId; job.sourceReviewId = review.id;
      if (review.purpose === 'repair') job.attempts += 1;
      job.noProgressCount = 0;
      job.preservedUsefulChanges = unique([...job.preservedUsefulChanges, ...review.usefulChanges]);
      job.failures = unique([...job.failures, ...review.failures]);
      job.updatedAt = context.now; job.reason = '독립 비교에서 개선을 확인하여 수정본을 적용했습니다.'; }
    return;
  }
  if (review.purpose === 'regression' && review.decision !== 'rolled_back') return;
  if (review.purpose === 'candidate' && !(review.comparison?.verified && review.verdict === 'regressed' && review.usefulChanges.length)) return;
  if (review.purpose === 'repair' && !job) return;
  if (!job) {
    job = { id: context.newId(), agentId: review.agentId, skillId: review.skillId,
      baselineRevisionId: review.baselineRevisionId, candidateRevisionId: review.candidateRevisionId,
      sourceReviewId: review.id, sourceRunId: review.sourceRunId, status: 'queued', attempts: 0, noProgressCount: 0,
      preservedUsefulChanges: [], failures: [], reason: '', createdAt: context.now, updatedAt: context.now };
    state.repairJobs.push(job);
  }
  const previousCandidate = state.skillRevisions.find(item => item.id === job!.candidateRevisionId);
  const currentCandidate = state.skillRevisions.find(item => item.id === review.candidateRevisionId);
  const newUseful = Boolean(review.comparison?.verified && review.verdict !== 'inconclusive'
    && previousCandidate?.content !== currentCandidate?.content
    && review.usefulChanges.some(item => !job!.preservedUsefulChanges.includes(item)));
  job.preservedUsefulChanges = unique([...job.preservedUsefulChanges, ...review.usefulChanges]);
  job.failures = unique([...job.failures, ...review.failures]);
  // Keep the original verification task even when later repair runs supply reviews.
  job.candidateRevisionId = review.candidateRevisionId; job.sourceReviewId = review.id;
  if (review.purpose === 'repair') { job.attempts += 1; job.noProgressCount = newUseful ? 0 : job.noProgressCount + 1; }
  job.status = job.noProgressCount >= policy.noProgressLimit ? 'held' : 'queued';
  job.updatedAt = context.now;
  job.reason = job.status === 'held' ? '새 개선 근거 없는 반복으로 이 스킬의 재수정만 보류했습니다. 일반 작업은 계속할 수 있습니다.'
    : '기존 정상 상태를 유지하며 보존한 개선점과 실패 근거로 다시 수정·평가합니다.';
}

/** Apply inside the service transaction after matching persisted ModelAttempt evidence. */
export function applyGrowthAssessment(state: GrowthDomainState, input: GrowthAssessmentInput, context: GrowthContext,
  policy: GrowthPolicy = defaultPolicy): GrowthReview {
  if (!Number.isSafeInteger(policy.noProgressLimit) || policy.noProgressLimit < 1) throw new GrowthError(400, '재수정 보류 기준은 양의 정수여야 합니다.');
  const candidate = revision(state, input.candidateRevisionId, input.agentId, input.skillId);
  const baseline = input.baselineRevisionId ? revision(state, input.baselineRevisionId, input.agentId, input.skillId) : null;
  if (candidate.parentRevisionId !== input.baselineRevisionId) throw new GrowthError(409, '후보의 비교 기준 버전이 일치하지 않습니다.');
  const previous = state.growthReviews.find(review => review.agentId === input.agentId && review.skillId === input.skillId
    && review.candidateRevisionId === input.candidateRevisionId && review.baselineRevisionId === input.baselineRevisionId
    && review.sourceRunId === input.sourceRunId && review.purpose === input.purpose
    && (review.comparison?.judgeAttemptId ?? null) === (input.comparison?.judgeAttemptId ?? null));
  if (previous) return previous;
  const comparison = input.comparison ? structuredClone(input.comparison) : null;
  const verified = verifiedComparison(comparison) && comparison!.fingerprint.candidateSkillHash === skillRevisionHash(candidate)
    && comparison!.fingerprint.baselineSkillHash === (baseline ? skillRevisionHash(baseline) : null);
  const verdict: GrowthVerdict = verified ? comparison!.verdict : 'inconclusive';
  const review: GrowthReview = {
    id: context.newId(), agentId: input.agentId, skillId: input.skillId,
    baselineRevisionId: input.baselineRevisionId, candidateRevisionId: input.candidateRevisionId,
    sourceRunId: input.sourceRunId, purpose: input.purpose, verdict, decision: 'kept',
    reason: verified ? comparison!.reason : '같은 조건의 독립 실행·판정 근거가 부족하여 기존 스킬을 유지했습니다.',
    comparison, usefulChanges: unique(comparison?.usefulChanges ?? []), failures: unique(comparison?.failures ?? []), createdAt: context.now,
  };
  const current = activeSkill(state, input.agentId, input.skillId);
  const currentId = current?.activeRevisionId ?? null;
  const currentRevision = currentId ? state.skillRevisions.find(item => item.id === currentId) : null;
  const currentCoherent = !current || Boolean(currentRevision && skillRevisionHash(current) === skillRevisionHash(currentRevision));
  if (verified && verdict === 'improved' && input.purpose !== 'regression') {
    if (currentCoherent && currentId === input.baselineRevisionId && (!baseline || knownNormal(state, baseline))) {
      review.decision = 'activated'; projectRevision(state, candidate, review, context);
    } else review.reason = '평가 이후 활성 스킬이나 비교 기준이 변경되어 과거 평가로 덮어쓰지 않았습니다.';
  } else if (verified && verdict === 'regressed' && input.purpose === 'regression') {
    if (currentCoherent && currentId === candidate.id && (!baseline || knownNormal(state, baseline))) {
      review.decision = 'rolled_back';
      if (baseline) projectRevision(state, baseline, review, context);
      else { current!.status = 'rejected'; current!.evaluation = review.reason; current!.updatedAt = context.now; }
    } else review.reason = '평가 대상과 현재 활성 버전 또는 직전 정상 버전이 일치하지 않아 자동 복귀하지 않았습니다.';
  }
  state.growthReviews.push(review);
  if (review.decision !== 'kept' || (input.purpose !== 'regression' && currentCoherent && currentId === input.baselineRevisionId
    && (!baseline || knownNormal(state, baseline)))) updateRepairFromReview(state, review, context, policy);
  return review;
}

/** Job state does not pause an Agent or mutate executable skill content. */
export function updateRepairJob(state: GrowthState, jobId: string,
  patch: Pick<RepairJob, 'status' | 'reason' | 'updatedAt'> & Pick<Partial<RepairJob>, 'runId'>): RepairJob {
  const job = state.repairJobs.find(item => item.id === jobId);
  if (!job) throw new GrowthError(404, '스킬 재수정 작업을 찾을 수 없습니다.');
  if (job.status === 'resolved' && patch.status !== 'resolved') throw new GrowthError(409, '완료된 재수정 작업을 다시 실행할 수 없습니다.');
  Object.assign(job, patch); return job;
}

/** Only selected snapshot lineages are inherited; no mutable job or review is shared. */
export function forkSkillRevisions(state: GrowthDomainState,
  input: { sourceAgentId: string; targetAgentId: string; skills: Array<{ source: Skill; target: Skill }> },
  context: GrowthContext): void {
  if (input.sourceAgentId === input.targetAgentId) throw new GrowthError(409, '복제본은 다른 에이전트여야 합니다.');
  for (const { source, target } of input.skills) {
    if (source.agentId !== input.sourceAgentId || target.agentId !== input.targetAgentId) throw new GrowthError(409, '복제할 스킬의 소유자가 일치하지 않습니다.');
    const selected = ensureSkillRevision(state, structuredClone(source), context);
    const mapped = new Map<string, string>(); const visiting = new Set<string>();
    const copy = (sourceRevision: SkillRevision): SkillRevision => {
      const existingId = mapped.get(sourceRevision.id);
      if (existingId) return revision(state, existingId, target.agentId, target.id);
      if (visiting.has(sourceRevision.id)) throw new GrowthError(409, '스킬 버전 계보에 순환 참조가 있습니다.');
      visiting.add(sourceRevision.id);
      const parent = sourceRevision.parentRevisionId ? copy(revision(state, sourceRevision.parentRevisionId, source.agentId, source.id)) : null;
      const value: SkillRevision = { ...structuredClone(sourceRevision), id: context.newId(), agentId: target.agentId,
        skillId: target.id, parentRevisionId: parent?.id ?? null, origin: 'fork', createdAt: context.now,
        inheritedFrom: { agentId: source.agentId, revisionId: sourceRevision.id } };
      state.skillRevisions.push(value); mapped.set(sourceRevision.id, value.id); visiting.delete(sourceRevision.id);
      return value;
    };
    target.activeRevisionId = copy(selected).id;
  }
}
