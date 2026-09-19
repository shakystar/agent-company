import { createHash } from 'node:crypto';
import { growthReplayInputSchema, growthReplayProposalSchema, growthReplayTaskPrompt,
  type GrowthReplayInput, type GrowthReplayProposal } from '../shared/growth.ts';
import type { WorkspaceState } from './store.ts';
import { growthTaskPrompt } from '../shared/growth.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceContent = (value: Omit<GrowthReplayInput, 'sourceHash'>) => ({
  version: value.version, sourceRunId: value.sourceRunId, taskPrompt: value.taskPrompt,
  artifacts: value.artifacts.map(({ id, version, name, mediaType, content }) => ({ id, version, name, mediaType, content })),
});
export function growthReplayHash(value: Omit<GrowthReplayInput, 'sourceHash'>): string { return hash(sourceContent(value)); }
export function validateGrowthReplayInput(value: unknown): GrowthReplayInput {
  const parsed = growthReplayInputSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(sourceContent(parsed)), 'utf8') > 1024 * 1024) throw new Error('성장 검사 입력 자료가 1MiB 한도를 넘었습니다.');
  if (new Set(parsed.artifacts.map(artifact => artifact.id)).size !== parsed.artifacts.length) throw new Error('성장 검사 산출물 식별자가 중복됐습니다.');
  if (growthReplayHash(parsed) !== parsed.sourceHash) throw new Error('성장 검사 고정 자료의 해시가 일치하지 않습니다.');
  return parsed;
}
export function captureGrowthReplayInput(value: Omit<GrowthReplayInput, 'sourceHash'>): GrowthReplayInput {
  return validateGrowthReplayInput({ ...structuredClone(value), sourceHash: growthReplayHash(value) });
}
export function resolveGrowthReplay(value: GrowthReplayInput, proposal: GrowthReplayProposal | null | undefined,
  originalPrompt: string): { prompt: string; replayHash: string; sourceHash: string } {
  const source = validateGrowthReplayInput(value);
  if (source.taskPrompt !== originalPrompt) throw new Error('성장 검사 고정 작업과 최종 지시가 다릅니다. 새 지시를 포함하는 검사 입력이 필요합니다.');
  if (!proposal) throw new Error('고정 자료에 적용할 로컬 검사 제안이 없습니다. 후보를 보존했습니다.');
  const test = growthReplayProposalSchema.parse(proposal);
  if (test.applicability !== 'local') throw new Error('외부 실행이 필요한 스킬은 로컬 검사로 적용하지 않습니다. 후보를 보존했습니다.');
  if (new Set(test.artifactIds).size !== test.artifactIds.length || test.artifactIds.some(id => !source.artifacts.some(artifact => artifact.id === id))) {
    throw new Error('성장 검사에서 참조한 산출물이 고정 입력에 없거나 중복됐습니다.');
  }
  return { prompt: growthReplayTaskPrompt(source, test), replayHash: hash({ sourceHash: source.sourceHash, test }), sourceHash: source.sourceHash };
}

/** Validate backup copies without consulting current membership or rewriting evidence.
 * Later steering may make a captured test unusable, but must not make its history unrestorable.
 */
export function validatePersistedGrowthReplay(state: Pick<WorkspaceState, 'runs' | 'executionStates' | 'sharedArtifacts'>): void {
  for (const [runId, execution] of Object.entries(state.executionStates)) {
    const captured = execution?.input?.growthReplay;
    if (captured === undefined) continue;
    const input = execution.input, replay = validateGrowthReplayInput(captured);
    if (input.growthReplayUnavailable !== undefined) throw new Error('성장 검사 입력과 확보 실패 기록이 함께 존재합니다.');
    const run = state.runs.find(item => item.id === runId);
    if (!run || run.agentId !== input.agent.id) throw new Error('성장 검사 입력의 실행 소유자가 일치하지 않습니다.');
    const sourceId = input.growth?.sourceRunId ?? run.id;
    const source = state.runs.find(item => item.id === sourceId);
    if (!source || source.agentId !== run.agentId || replay.sourceRunId !== sourceId) throw new Error('성장 검사 원래 실행의 소유자·식별자가 일치하지 않습니다.');
    const sourceInput = state.executionStates[sourceId]?.input;
    if (!sourceInput?.growthReplay || validateGrowthReplayInput(sourceInput.growthReplay).sourceHash !== replay.sourceHash) {
      throw new Error('성장 검사 원래 실행의 고정 입력이 보존되지 않았습니다.');
    }
    const steering = source.steering ?? [];
    let admittedPrompt = replay.taskPrompt === source.prompt;
    if (!admittedPrompt) {
      const prefix = `${source.prompt}\n\n사용자의 추가 지시:\n`;
      if (replay.taskPrompt.startsWith(prefix)) try {
        const admitted: unknown = JSON.parse(replay.taskPrompt.slice(prefix.length));
        admittedPrompt = Array.isArray(admitted) && admitted.length > 0 && admitted.length <= steering.length
          && admitted.every((value, index) => typeof value === 'string' && value === steering[index])
          && growthTaskPrompt(source.prompt, admitted) === replay.taskPrompt;
      } catch { /* Malformed captured steering is rejected below. */ }
    }
    if (!admittedPrompt) {
      throw new Error('성장 검사 입력의 작업 맥락이 원래 실행과 일치하지 않습니다.');
    }
    for (const artifact of replay.artifacts) {
      const original = state.sharedArtifacts.find(item => item.id === artifact.id);
      const expectedScope = source.budgetProjectId ? { type: 'project', id: source.budgetProjectId }
        : source.budgetTeamId ? { type: 'team', id: source.budgetTeamId } : null;
      if (!original || !expectedScope || original.scope.type !== expectedScope.type || original.scope.id !== expectedScope.id) {
        throw new Error('성장 검사 산출물의 원래 공유 범위가 일치하지 않습니다.');
      }
      const content = artifact.version === original.version ? original.content
        : original.history.find(item => item.version === artifact.version)?.content;
      if (content !== artifact.content) throw new Error('성장 검사 산출물의 고정 원문·버전이 보존되지 않았습니다.');
    }
    if (input.growth?.replay !== undefined && input.growth.replay !== null) growthReplayProposalSchema.parse(input.growth.replay);
  }
}
