import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ContainerRuntime, type RuntimeConfig } from '../server/runtime.ts';
import { BudgetPauseError, type ModelAttempt } from '../shared/telemetry.ts';
import type { Command } from '../server/process.ts';
import type { ExecutionInput } from '../shared/types.ts';
const { createModelTelemetry, qualityTask, synchronizeSkills } = await import(new URL('../worker/growth.mjs', import.meta.url).href);
const at = '2026-09-06T00:00:00.000Z';
const config: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'test-only', authFile: '', image: 'worker:test', model: 'test-model', timeoutMs: 10_000 };
const input: ExecutionInput = {
  agent: { id: 'agent-a', name: 'one', description: '', persona: 'Research', color: '#345555', model: 'test-model', status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at },
  run: { id: 'run-a', agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot-a', prompt: 'a task', status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null },
  memories: [], skills: [], connections: [],
};
const task = { result: 'completed', memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 4 };
test('worker telemetry preserves unknown, observed zero, partial failure and cache usage without inventing missing values', () => {
  const unknown = createModelTelemetry();
  assert.equal(unknown.finish(false).usage.inputTokens, null);
  assert.equal(unknown.snapshot().usage.status, 'unknown');
  unknown.accept({ type: 'turn.started' });
  unknown.accept({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } });
  assert.deepEqual(unknown.finish(true).usage, { status: 'reported', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: null });
  unknown.accept({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 1000 } });
  assert.equal(unknown.snapshot().usage.inputTokens, 0);
  unknown.accept({ type: 'turn.started' });
  unknown.accept({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5, cached_input_tokens: 9 } });
  unknown.accept({ type: 'turn.started' });
  unknown.accept({ type: 'turn.failed', error: { message: 'quota' } });
  assert.equal(unknown.finish(false).usage.status, 'partial');
  assert.equal(unknown.snapshot().usage.inputTokens, 12);
  assert.equal(unknown.snapshot().usage.cachedInputTokens, 9);
});
test('only completed command events become observed evidence and telemetry emits bounded deltas', () => {
  const meter = createModelTelemetry();
  meter.accept({ type: 'item.completed', item: { id: 'claim', type: 'agent_message', text: 'I ran 500 tests' } });
  meter.accept({ type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'python test.py' } });
  meter.accept({ type: 'item.completed', item: { id: 'command-1', type: 'command_execution', status: 'completed', exit_code: 1, aggregated_output: 'test failed' } });
  assert.equal(meter.drain().observations.length, 1); assert.equal(meter.drain().observations.length, 0);
  assert.equal(meter.snapshot().observations[0].exitCode, 1);
  assert.equal(meter.snapshot().observations[0].command, 'python test.py');
  for (let index = 0; index < 110; index++) meter.accept({ type: 'item.completed', item: { id: `id-${index}`, type: 'command_execution', command: 'x'.repeat(3000), aggregated_output: 'x'.repeat(6000) } });
  assert.equal(meter.snapshot().observations.length, 100); assert.equal(meter.snapshot().observationsTruncated, true);
  assert.ok(meter.snapshot().observations.every((item: { command: string; outputExcerpt: string }) => item.command.length <= 2000 && item.outputExcerpt.length <= 4000));
});

test('missing usage from any completed turn remains partial after a later successful turn', () => {
  const meter = createModelTelemetry();
  meter.accept({ type: 'turn.started' }); meter.accept({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } });
  meter.accept({ type: 'turn.started' }); meter.accept({ type: 'turn.completed', usage: { input_tokens: 20 } });
  assert.equal(meter.finish(true).usage.status, 'partial');
  assert.equal(meter.snapshot().usage.inputTokens, 30); assert.equal(meter.snapshot().usage.outputTokens, 4);
});
test('evaluation data whitelists quality content and excludes usage or duration even from nested candidate metadata', () => {
  const clean = qualityTask({ ...task, durationMs: 900, inputTokens: 100, outputTokens: 200, telemetry: { usage: {} }, skills: [{ name: 'a', description: 'b', content: 'c', inputTokens: 123 }] });
  assert.equal(/inputTokens|outputTokens|durationMs|telemetry/.test(JSON.stringify(clean)), false);
});

test('judge prompt excludes intentionally suppressed growth writes from completion and quality penalties', async () => {
  const source = await readFile(new URL('../worker/entry.mjs', import.meta.url), 'utf8');
  const trial = source.slice(source.indexOf('const taskPrompt ='), source.indexOf('const evaluationPrompt ='));
  const judge = source.slice(source.indexOf('const evaluationPrompt ='), source.indexOf('const repairPrompt ='));
  assert.match(trial, /기억·스킬·skillConcerns 배열은 비워 둡니다/);
  assert.match(judge, /memories·skills·skillConcerns 배열을 의도적으로 비웁니다/);
  assert.match(judge, /기억 갱신·스킬 제안·스킬 문제 보고 요청이 있어도/);
  assert.match(judge, /성장 쓰기의 생략은 과제 누락이나 품질 저하가 아니며 감점 근거로 삼지 않습니다/);
  assert.match(judge, /그 밖의 사용자 요구는 result·artifacts와 관찰 근거로 평가합니다/);
});
test('injected skill directories match active input while unrelated directories remain intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-company-growth-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)); await rm(root, { recursive: true, force: true }); });
  const skill = { name: 'one', description: 'specific', content: 'old', status: 'active' };
  await synchronizeSkills(root, [skill, { ...skill, name: 'two' }]);
  await mkdir(join(root, '.agents', 'skills', 'user-owned'));
  await writeFile(join(root, '.agents', 'skills', 'user-owned', 'SKILL.md'), 'keep');
  await synchronizeSkills(root, [{ ...skill, content: 'new' }]);
  assert.deepEqual((await readdir(join(root, '.agents', 'skills'))).sort(), ['skill-0', 'user-owned']);
  assert.match(await readFile(join(root, '.agents', 'skills', 'skill-0', 'SKILL.md'), 'utf8'), /new/);
  assert.equal(await readFile(join(root, '.agents', 'skills', 'user-owned', 'SKILL.md'), 'utf8'), 'keep');
});
test('runtime persists streamed usage on failure and cancellation; budget pause starts no model and is not a rejection', async () => {
  for (const cancelled of [false, true]) {
    const attempts: ModelAttempt[] = [], controller = new AbortController();
    const runner: Command = async (_file, args, options = {}) => {
      if (args[0] !== 'run') return { code: 0, stdout: 'ok', stderr: '' };
      await options.onLine?.(JSON.stringify({ type: 'telemetry', usage: { status: 'partial', inputTokens: 12, outputTokens: 5, cachedInputTokens: null, reasoningOutputTokens: null }, observations: [], observationsTruncated: false }));
      if (cancelled) controller.abort();
      throw new Error('interrupted');
    };
    await assert.rejects(new ContainerRuntime(config, runner).execute(input, { signal: controller.signal, getSteering: async () => [], onEvent: async () => {}, onAttempt: async value => { attempts.push(value); } }), /interrupted/);
    assert.equal(attempts[0].status, 'started'); assert.equal(attempts.at(-1)!.status, cancelled ? 'cancelled' : 'failed');
    assert.equal(attempts.at(-1)!.usage.inputTokens, 12); assert.equal(attempts.at(-1)!.usage.status, 'partial');
  }
  let starts = 0;
  const runner: Command = async (_file, args) => { if (args[0] === 'run') starts++; return { code: 0, stdout: 'ok', stderr: '' }; };
  await assert.rejects(new ContainerRuntime(config, runner).execute(input, { signal: new AbortController().signal, getSteering: async () => [], onEvent: async () => {}, beforeModelStart: async () => { throw new BudgetPauseError(); } }), error => (error as BudgetPauseError).code === 'MODEL_BUDGET_PAUSED');
  assert.equal(starts, 0);
});
