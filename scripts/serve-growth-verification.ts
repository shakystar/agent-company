import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { BudgetPauseError, unknownUsage } from '../shared/telemetry.ts';
import { GrowthFixtureRuntime, growthResult, modelAttempt as fixtureModelAttempt, pairedEvidence as fixtureComparisonEvidence, type GrowthCall } from '../tests/growth-fixture.ts';

// Verification fixture only. Real HTTP/controller/PGlite, fabricated runtime evidence.
// No dotenv, user database, credentials, Docker, provider or model process is used.
const requested = process.argv[2];
const directory = requested ? resolve(requested) : resolve('.browser', `growth-verify-${randomUUID()}`);
if (dirname(directory) !== resolve('.browser') || !/^growth-verify-[a-f0-9-]{36}$/.test(basename(directory))) throw new Error('Only an owned growth fixture directory can be reopened');
if (requested) {
  const prior = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'));
  if (prior.directory !== directory || prior.modelCalls !== 0 || prior.directDatabaseSeeds !== 0) throw new Error('Existing fixture ownership metadata does not match');
}
await mkdir(directory, { recursive: true });
const key = randomUUID();
const runtime = new GrowthFixtureRuntime();
const completed = new Set<GrowthCall>();
const app = await createApp({ dataDir: join(directory, 'db'), runtime,
  scheduler: new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
    defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } }),
  recovery: { maxAttempts: 1 } });
await app.register(fastifyStatic, { root: resolve('dist') });
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
  ? reply.code(404).send({ error: 'API not found' }) : reply.sendFile('index.html'));
app.get('/verification/state', async () => ({ modelCalls: 0, directDatabaseSeeds: 0,
  calls: runtime.calls.map(call => ({ runId: call.input.run.id, kind: call.input.run.kind ?? 'task',
    prompt: call.input.run.prompt, completed: completed.has(call), aborted: call.hooks.signal.aborted })) }));
app.post('/verification/complete', async (request, reply) => {
  if (request.headers['x-verification-key'] !== key) return reply.code(403).send({ error: 'Fixture key required' });
  const { runId, scenario } = z.object({ runId: z.uuid(), scenario: z.enum(['learn', 'concern', 'regression', 'repair-fail', 'budget', 'failure', 'success']) }).strict().parse(request.body);
  const call = runtime.calls.findLast(item => item.input.run.id === runId);
  if (!call || completed.has(call) || call.hooks.signal.aborted) return reply.code(409).send({ error: 'No pending fixture call' });
  const mode = call.input.growth?.mode;
  if ((scenario === 'regression' && mode !== 'review') || (scenario === 'repair-fail' && mode !== 'repair')
    || (['learn', 'concern', 'budget', 'failure', 'success'].includes(scenario) && mode)) return reply.code(409).send({ error: 'Fixture scenario does not match run kind' });
  await call.hooks.onEvent('[TEST FIXTURE] Fabricated model observations; actual model calls = 0.');
  if (scenario === 'budget') {
    await call.hooks.onAttempt!(fixtureModelAttempt(call, 'task', { kind: 'fixture-unknown', durationMs: null, usage: unknownUsage() }));
    await call.hooks.onCheckpoint!({ phase: 'evaluate', previousResult: growthResult({ result: '[TEST FIXTURE] Preserved task result before budget wait' }) });
    completed.add(call); call.reject(new BudgetPauseError('[TEST FIXTURE] Model-start allowance exhausted; no provider call was made.'));
  } else if (scenario === 'failure') {
    await call.hooks.onAttempt!(fixtureModelAttempt(call, 'task', { kind: 'fixture-partial-failure', status: 'failed', durationMs: 1250,
      usage: { ...unknownUsage(), status: 'partial', inputTokens: 42, outputTokens: 7 }, error: '[TEST FIXTURE] Interrupted <script>not executable</script>' }));
    completed.add(call); call.reject(new Error('[TEST FIXTURE] Failed work with partial observation'));
  } else if (scenario === 'concern') {
    const skill = call.input.skills[0];
    if (!skill) return reply.code(409).send({ error: 'An active fixture skill is required' });
    await call.hooks.onAttempt!(fixtureModelAttempt(call, 'task', { kind: 'fixture-unknown', durationMs: null, usage: unknownUsage() }));
    completed.add(call); call.resolve(growthResult({ result: '[TEST FIXTURE] Task exposed a potential regression',
      skillConcerns: [{ skillId: skill.id, reason: '[TEST FIXTURE] Suspected missing output', evidence: '[TEST FIXTURE] Requires separate comparison; concern alone is not rollback proof' }] }));
  } else if (scenario === 'success') {
    await call.hooks.onAttempt!(fixtureModelAttempt(call, 'task', { kind: 'fixture-reported-zero', durationMs: 0,
      usage: { status: 'reported', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } }));
    completed.add(call); call.resolve(growthResult({ result: '[TEST FIXTURE] Ordinary task remains available while repair is held' }));
  } else {
    const candidate = scenario === 'regression' ? call.input.growth!.candidate : {
      name: 'Fixture procedure', description: '[TEST FIXTURE] Reusable procedure',
      content: scenario === 'learn' ? '[TEST FIXTURE] Candidate v2: preserve a useful step but later expose missing output'
        : '[TEST FIXTURE] Repair candidate: the same missing output remains',
    };
    if (scenario !== 'regression') await call.hooks.onAttempt!(fixtureModelAttempt(call, scenario === 'learn' ? 'task' : 'repair', {
      kind: `fixture-${scenario}`, durationMs: 1700,
      usage: { ...unknownUsage(), status: 'partial', inputTokens: 120, outputTokens: null } }));
    const comparison = await fixtureComparisonEvidence(call, candidate, scenario === 'learn' ? 'improved' : 'regressed', {
      usefulChanges: ['[TEST FIXTURE] Useful formatting retained'], failures: scenario === 'learn' ? [] : ['[TEST FIXTURE] Required output is still missing'],
      mutateAttempt: (attempt, index) => {
        attempt.reason = '[TEST FIXTURE] Fabricated independent-comparison observation, not real model performance';
        if (index === 0) { attempt.usage = unknownUsage(); attempt.durationMs = null; }
        if (index === 1) attempt.usage = { ...unknownUsage(), status: 'partial', inputTokens: 18, outputTokens: null };
      },
    });
    comparison.reason = `[TEST FIXTURE] Fabricated comparison outcome: ${comparison.verdict}`;
    comparison.evidence = ['[TEST FIXTURE] Matching comparison records validate controller/UI behavior only; no real model trial ran'];
    completed.add(call);
    call.resolve(growthResult({ result: `[TEST FIXTURE] ${scenario} completed`, ...(scenario === 'regression'
      ? { growthReview: comparison } : { skills: [{ ...candidate, passed: true, evaluation: '[TEST FIXTURE] Author claim only', comparison }] }) }));
  }
  return { accepted: true, runId, scenario, modelCalls: 0 };
});
app.post('/verification/stop', async (request, reply) => {
  if (request.headers['x-verification-key'] !== key) return reply.code(403).send({ error: 'Fixture key required' });
  setTimeout(() => { void app.close(); }, 100); return { stopping: true };
});
await writeFile(join(directory, 'fixture.json'), JSON.stringify({ directory, key, port: 4313, modelCalls: 0, directDatabaseSeeds: 0 }));
await app.listen({ host: '127.0.0.1', port: 4313 });
console.log(JSON.stringify({ directory, port: 4313, pid: process.pid, modelCalls: 0 }));
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void app.close(); });
