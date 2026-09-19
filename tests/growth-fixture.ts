import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { growthTaskPrompt, type ComparisonEvidence, type GrowthVerdict } from '../shared/growth.ts';
import type { ModelAttempt } from '../shared/telemetry.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo, Skill } from '../shared/types.ts';
import { skillRevisionHash } from '../server/growth.ts';

export const growthResult = (overrides: Partial<ExecutionResult> = {}): ExecutionResult => ({
  result: 'Fixture task completed', appliedSteeringCount: 0, memories: [], skills: [], artifacts: [],
  inputTokens: 0, outputTokens: 0, ...overrides,
});
export type GrowthCall = { input: ExecutionInput; hooks: ExecutionHooks;
  resolve: (result: ExecutionResult) => void; reject: (error: Error) => void };

/** No process, container, network or model is started by this runtime. */
export class GrowthFixtureRuntime implements RuntimeDriver {
  calls: GrowthCall[] = [];
  async inspect(): Promise<RuntimeInfo> {
    return { mode: 'docker', available: true, authenticated: true, image: 'fixture-growth-image',
      model: 'fixture-growth-model', version: 'fixture', message: 'Pure service test fixture; no model calls.' };
  }
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  async settle() {}
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error('Fixture execution aborted'));
      hooks.signal.addEventListener('abort', aborted, { once: true });
      this.calls.push({ input, hooks,
        resolve: result => { hooks.signal.removeEventListener('abort', aborted); resolve(result); },
        reject: error => { hooks.signal.removeEventListener('abort', aborted); reject(error); } });
    });
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, label = 'fixture state'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

export function modelAttempt(call: GrowthCall, phase: ModelAttempt['phase'], overrides: Partial<ModelAttempt> = {}): ModelAttempt {
  const timestamp = new Date().toISOString();
  return { id: randomUUID(), runId: call.input.run.id, phase, kind: `fixture-${phase}`, reason: 'Independent service fixture',
    model: call.input.agent.model, status: 'succeeded', startedAt: timestamp, completedAt: timestamp, durationMs: 11,
    usage: { status: 'reported', inputTokens: 17, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: null },
    observations: [], observationsTruncated: false, error: null, ...overrides };
}

export async function pairedEvidence(call: GrowthCall, next: Pick<Skill, 'name' | 'description' | 'content'>,
  verdict: GrowthVerdict, options: { recordCount?: number; mutateAttempt?: (attempt: ModelAttempt, index: number) => void;
    usefulChanges?: string[]; failures?: string[] } = {}): Promise<ComparisonEvidence> {
  const baseline = call.input.growth ? call.input.growth.baseline : call.input.skills.find(item => item.name === next.name) ?? null;
  const attempts = [modelAttempt(call, 'trial'), modelAttempt(call, 'trial'), modelAttempt(call, 'evaluate')];
  for (const [index, attempt] of attempts.entries()) {
    options.mutateAttempt?.(attempt, index);
    if (index < (options.recordCount ?? 3)) await call.hooks.onAttempt!(attempt);
  }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return { fingerprint: {
    promptHash: hash(JSON.stringify(call.input.growth?.originalPrompt ?? growthTaskPrompt(call.input.run.prompt, call.input.run.steering))),
    inputHash: hash(JSON.stringify({ agent: call.input.agent, skills: call.input.skills, memories: call.input.memories })),
    model: call.input.agent.model, image: 'fixture-growth-image',
    baselineSkillHash: baseline ? skillRevisionHash(baseline) : null, candidateSkillHash: skillRevisionHash(next),
  }, baseline: { attemptId: attempts[0].id, resultHash: hash('baseline output'), completed: true },
  candidate: { attemptId: attempts[1].id, resultHash: hash('candidate output'), completed: true }, judgeAttemptId: attempts[2].id,
  verdict, reason: `Independent paired fixture: ${verdict}`, evidence: ['Same task input; independent baseline/candidate trials and judge'],
  usefulChanges: options.usefulChanges ?? [], failures: options.failures ?? [], verified: true };
}
