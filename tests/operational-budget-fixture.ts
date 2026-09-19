import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';
import { ResourceScheduler } from '../server/resources.ts';

export const output = (text = 'Budget fixture result', extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
  result: text, memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 3, ...extra,
});
export type BudgetCall = { input: ExecutionInput; hooks: ExecutionHooks;
  finish: (result?: ExecutionResult) => void; fail: (error: Error) => void };

/** No model/process/container starts. Admission uses the same service hook as an actual worker. */
export class OperationalFixtureRuntime implements RuntimeDriver {
  calls: BudgetCall[] = [];
  entries: ExecutionInput[] = [];
  available = true;
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', available: this.available, authenticated: true,
    image: 'operational-budget-test-only', model: 'fixture', version: 'fixture', message: 'Injected runtime; no model calls' }; }
  async settle() {}
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    this.entries.push(input);
    const request: ModelStartRequest = { runId: input.run.id, phase: input.growth?.mode === 'repair' ? 'repair' : 'task',
      kind: input.run.kind ?? 'task', reason: 'Controlled model admission fixture' };
    await hooks.beforeModelStart?.(request);
    return new Promise((resolveResult, reject) => {
      const abort = () => reject(new Error('Fixture interrupted'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks,
        finish: (result = output()) => { hooks.signal.removeEventListener('abort', abort); resolveResult(result); },
        fail: error => { hooks.signal.removeEventListener('abort', abort); reject(error); } });
    });
  }
}

export const resources = (slots = 3) => new ResourceScheduler({ capacity: { memoryMiB: 1024 * slots, cpus: slots },
  defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
export async function waitFor(check: () => boolean | Promise<boolean>, label = 'budget fixture state') {
  const deadline = Date.now() + 12_000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`); await delay(10); }
}
export async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-operational-budget-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-operational-budget-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
