import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ContainerRuntime, dockerArguments, kubernetesResources, workspaceVolume, type RuntimeConfig } from '../server/runtime.ts';
import { createWorkerReleaseManifest, workerSourceFiles, type WorkerReleaseCatalog, type WorkerReleasePin } from '../shared/runtime-releases.ts';
import type { ExecutionCheckpoint, ExecutionHooks, ExecutionInput } from '../shared/types.ts';
import type { Command, CommandOptions } from '../server/process.ts';

const imageA = `sha256:${'a'.repeat(64)}`, imageB = `sha256:${'b'.repeat(64)}`;
const sources = Object.fromEntries(workerSourceFiles.map(name => [name, '1'.repeat(64)]));
const a = createWorkerReleaseManifest({ image: imageA, sourceHashes: sources, runtimeBaseHash: '2'.repeat(64) });
const b = createWorkerReleaseManifest({ image: imageB, sourceHashes: { ...sources, 'entry.mjs': '3'.repeat(64) }, runtimeBaseHash: '2'.repeat(64) });
const pinA = { image: imageA, manifestId: a.id }, pinB = { image: imageB, manifestId: b.id };
const catalog: WorkerReleaseCatalog = { version: 1, active: pinB, manifests: [a, b] };
const config: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'fixture', authFile: '', image: imageB,
  model: 'fixture-model', workspaceKey: 'release-fixture', timeoutMs: 10_000, persistentWorkspaces: true, releaseCatalog: catalog };
const modern = createWorkerReleaseManifest({ image: `sha256:${'c'.repeat(64)}`, sourceHashes: sources, runtimeBaseHash: '6'.repeat(64) });
const modernPin = { image: modern.image, manifestId: modern.id };
const historicalConfig: RuntimeConfig = { ...config, image: modern.image,
  releaseCatalog: { version: 1, active: modernPin, manifests: [modern] }, historicalReleaseCatalogs: [catalog] };
const at = '2026-09-11T00:00:00.000Z';
function input(id: string, pin: WorkerReleasePin = pinA): ExecutionInput {
  return { agent: { id: 'agent-a', name: 'fixture', description: '', persona: '', model: 'fixture-model', color: '#123456',
    status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at },
    run: { id, agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot-a', prompt: 'fixture', status: 'running', result: '', error: null,
      inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null, runtimeRelease: pin },
    connections: [], memories: [], skills: [], resources: { cpus: 1, memoryMiB: 1024 } };
}
const result = (text = 'done') => ({ result: text, memories: [], skills: [], artifacts: [], inputTokens: 1, outputTokens: 1 });
const hooks = (): ExecutionHooks => ({ signal: new AbortController().signal, onEvent: async () => {}, getSteering: async () => [] });
const blocked = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'RUNTIME_RELEASE_BLOCKED');
function harness(options: { missing?: string[]; model?: (payload: any, options: CommandOptions) => unknown | Promise<unknown>; stale?: string; residue?: () => string } = {}) {
  const calls: Array<{ args: string[]; options: CommandOptions }> = [], volumes = new Map<string, Record<string, string>>();
  let recoverScans = 0;
  const command: Command = async (_file, args, commandOptions = {}) => {
    calls.push({ args, options: commandOptions });
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'version') return ok('29.1.3');
    if (args[0] === 'image') return options.missing?.includes(args[2]) ? { code: 1, stdout: '', stderr: 'No such image' } : ok(args[2]);
    if (args[0] === 'ps') {
      if (args.includes('-aq')) { recoverScans++; return ok(options.residue?.() ?? (recoverScans === 1 ? options.stale : '') ?? ''); }
      return ok();
    }
    if (args[0] === 'rm') return ok();
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return ok(args.some(arg => arg.includes('workspace-role=trial')) ? '' : [...volumes.keys()].join('\n'));
      if (args[1] === 'inspect') return volumes.has(args[2]) ? ok(JSON.stringify(volumes.get(args[2]))) : { code: 1, stdout: '', stderr: 'No such volume' };
      if (args[1] === 'create') {
        const labels: Record<string, string> = {};
        args.forEach((value, index) => { if (value === '--label') { const [key, ...rest] = args[index + 1].split('='); labels[key] = rest.join('='); } });
        volumes.set(args.at(-1)!, labels); return ok();
      }
      if (args[1] === 'rm') { volumes.delete(args.at(-1)!); return ok(); }
    }
    if (args[0] === 'run') {
      if (args.includes('--check-session')) return ok();
      const payload = JSON.parse(commandOptions.input!);
      if (args.at(-1) === '/app/workspace.mjs') return ok(JSON.stringify({ version: 1, state: 'ready', runId: payload.runId,
        sourceRunId: payload.sourceRunId, files: 0, bytes: 0, reused: false }));
      if (args.at(-1) === '/app/storage.mjs') return ok(JSON.stringify({ bytes: 0, files: 0 }));
      if (args.at(-1) === '/app/environment.mjs') return ok(JSON.stringify({ id: payload.id, value: {
        packages: payload.spec.packages, contentHash: '4'.repeat(64), lockfileHash: '5'.repeat(64) } }));
      const output = options.model ? await options.model(payload, commandOptions) : result();
      await commandOptions.onLine?.(JSON.stringify({ type: 'result', result: output })); return ok();
    }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  };
  return { calls, command, volumes, recoverScans: () => recoverScans,
    own: (id: string) => volumes.set(workspaceVolume(config, id), { app: 'agent-company', 'agent-company.workspace': config.workspaceKey!, 'agent-company.run': id }) };
}

test('Docker and Kubernetes manifests use the Run pin instead of the new active release', () => {
  assert.equal(dockerArguments(config, 'worker', input('old')).at(-1), imageA);
  assert.equal(dockerArguments(config, 'worker', input('new', pinB)).at(-1), imageB);
  assert.throws(() => dockerArguments(config, 'worker'), blocked);
  const missing = input('missing'); delete missing.run.runtimeRelease;
  assert.throws(() => dockerArguments(config, 'worker', missing), blocked);
  const k8s = { ...config, mode: 'kubernetes' as const, context: 'ctx', namespace: 'ns', authSecret: 'auth' };
  const resources = kubernetesResources(k8s, 'worker', { input: input('old') });
  assert.equal((resources.items[1] as any).spec.template.spec.containers[0].image, imageA);
});

test('missing, unknown, mismatched and unavailable pins block before any model or default-image fallback', async () => {
  for (const mutation of ['missing', 'unknown', 'mismatch', 'unavailable'] as const) {
    const selected = input(mutation), h = harness({ missing: mutation === 'unavailable' ? [imageA] : [] });
    if (mutation === 'missing') delete selected.run.runtimeRelease;
    if (mutation === 'unknown') selected.run.runtimeRelease = { image: `sha256:${'c'.repeat(64)}`, manifestId: 'f'.repeat(64) };
    if (mutation === 'mismatch') selected.run.runtimeRelease = { ...pinA, manifestId: pinB.manifestId };
    let starts = 0;
    await assert.rejects(new ContainerRuntime(config, h.command).execute(selected, { ...hooks(), beforeModelStart: async () => { starts++; } }), blocked);
    assert.equal(starts, 0); assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 0);
    assert.equal(h.calls.some(call => call.args[0] === 'image' && call.args[2] === imageB), false);
  }
  await assert.rejects(new ContainerRuntime({ ...config, releaseCatalog: undefined }, harness().command).validateRunRelease(input('orphan').run), blocked);
});

test('one recovery coordinator permits simultaneous old/new pinned tasks without deleting the other image worker', async () => {
  let releaseOld!: () => void, oldEntered!: () => void;
  const entered = new Promise<void>(resolve => { oldEntered = resolve; }), held = new Promise<void>(resolve => { releaseOld = resolve; });
  const h = harness({ stale: 'd'.repeat(12), model: async payload => {
    if (payload.input.run.id === 'old') { oldEntered(); await held; } return result(payload.input.run.id);
  } });
  const runtime = new ContainerRuntime(config, h.command);
  assert.deepEqual(runtime.defaultReleasePin, pinB); assert.deepEqual(runtime.forkWorkspace('forked').defaultReleasePin, pinB);
  assert.equal(runtime.forkWorkspace(config.workspaceKey!), runtime, 'same-workspace helper views must share startup/cleanup coordination');
  const running = runtime.execute(input('old'), hooks()); await entered;
  await assert.rejects(runtime.confirmDeploymentIdle(), /남아/);
  assert.equal((await runtime.execute(input('new', pinB), hooks())).result, 'new');
  assert.equal(h.recoverScans(), 1);
  assert.equal(h.calls.filter(call => call.args[0] === 'rm' && call.args.includes('ac-old-task')).length, 0);
  const models = h.calls.filter(call => call.args[0] === 'run' && call.options.input && JSON.parse(call.options.input).phase);
  assert.deepEqual(models.map(call => call.args.at(-1)), [imageA, imageB]);
  const prepares = h.calls.filter(call => call.args.at(-1) === '/app/workspace.mjs');
  assert.ok(prepares[0].args.includes(imageA)); assert.ok(prepares[1].args.includes(imageB));
  releaseOld(); assert.equal((await running).result, 'old'); await runtime.confirmDeploymentIdle();
  assert.equal(h.recoverScans(), 2, 'drain confirmation performs a fresh live inventory');
});

test('old release executes and probes its session when the new default image is unavailable', async () => {
  const h = harness({ missing: [imageB] }), runtime = new ContainerRuntime(config, h.command);
  assert.equal((await runtime.inspect()).available, false);
  assert.equal((await runtime.execute(input('old'), hooks())).result, 'done');
  const selected = input('resume'); h.own('resume');
  selected.checkpoint = { phase: 'task', sessionId: 'f129b6b4-a825-4205-a48c-193aa5083c66' };
  assert.equal(await runtime.canResume(selected), true);
  const probe = h.calls.find(call => call.args.includes('--check-session'))!;
  assert.ok(probe.args.includes(imageA)); assert.ok(!probe.args.includes(imageB));
});

test('growth task, both trial workspaces and judge retain the original pinned image and fingerprint', async () => {
  const h = harness({ model: payload => payload.phase === 'task' ? { ...result(), skills: [{ name: 'candidate', description: 'fixture', content: 'procedure' }] }
    : payload.phase === 'trial' ? result(payload.input.skills.length ? 'candidate' : 'baseline')
    : { verdict: 'equivalent', reason: 'same scoped quality', evidence: ['both completed'], usefulChanges: [], failures: [], inputTokens: 1, outputTokens: 1 } });
  const output = await new ContainerRuntime(config, h.command).execute(input('growth'), hooks());
  assert.equal(output.skills[0].comparison?.fingerprint.image, imageA);
  const models = h.calls.filter(call => call.args[0] === 'run' && call.options.input && JSON.parse(call.options.input).phase);
  assert.equal(models.length, 4); assert.ok(models.every(call => call.args.at(-1) === imageA));
  assert.ok(h.calls.filter(call => call.args.at(-1) === '/app/workspace.mjs').every(call => call.args.includes(imageA)));
});

test('environment build and resume helpers use the environment Run pin without model starts', async () => {
  const h = harness(), runtime = new ContainerRuntime(config, h.command), selected = input('environment');
  selected.run.kind = 'environment'; selected.environmentBuild = { revisionId: 'environment-a', spec: { packages: [{ name: 'test-package', version: '1.0.0' }], servers: [] } };
  const output = await runtime.execute(selected, { ...hooks(), beforeModelStart: async () => assert.fail('environment build starts no model') });
  assert.equal(output.environmentBuild?.imageId, imageA); assert.equal(await runtime.canResume(selected), true);
  const helpers = h.calls.filter(call => call.args.at(-1) === '/app/environment.mjs' || call.args.at(-1) === '/app/workspace.mjs');
  assert.ok(helpers.length >= 4); assert.ok(helpers.every(call => call.args.includes(imageA)));
});

test('deployment idle confirmation rejects residue or failed inspection and never performs cleanup', async () => {
  let residue = '';
  const h = harness({ residue: () => residue }), runtime = new ContainerRuntime(config, h.command);
  await runtime.recover(); const removals = h.calls.filter(call => call.args[0] === 'rm').length;
  residue = 'e'.repeat(12); await assert.rejects(runtime.confirmDeploymentIdle(), /컨테이너가 남아/);
  assert.equal(h.calls.filter(call => call.args[0] === 'rm').length, removals);
  residue = ''; await runtime.confirmDeploymentIdle();
  const failed = new ContainerRuntime(config, async () => ({ code: 1, stdout: '', stderr: 'engine unavailable' }));
  await assert.rejects(failed.confirmDeploymentIdle(), /확인하지 못/);
});

test('deployment idle confirmation waits for a queued inventory helper even with no model worker', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), h = harness();
  const runtime = new ContainerRuntime(config, async (file, args, options) => {
    if (args[0] === 'volume' && args[1] === 'ls') await gate;
    return h.command(file, args, options);
  });
  const listing = runtime.listWorkspaceVolumes(); await delay(0);
  await assert.rejects(runtime.confirmDeploymentIdle(), /정리가 남아/);
  finish(); await listing; await runtime.confirmDeploymentIdle();
});

async function cleanupDrainHarness() {
  const h = harness(); h.own('cleanup');
  let failCleanup = true, inspection: 'absent' | 'present' | 'failed' | 'thrown' | 'ambiguous' = 'absent';
  let onInspection: (() => Promise<void>) | undefined;
  let onRemoval: (() => Promise<void>) | undefined;
  const runtime = new ContainerRuntime(config, async (file, args, options) => {
    if (args.at(-1) === '/app/workspace.mjs' && JSON.parse(options!.input!).operation === 'read') {
      h.calls.push({ args, options: options ?? {} });
      return { code: 0, stdout: JSON.stringify({ path: 'artifact.txt', text: 'saved', bytes: 5 }), stderr: '' };
    }
    if (args[0] === 'rm' && args.at(-1)!.startsWith('ac-ws-') && failCleanup) throw new Error('helper cleanup timed out');
    if (args[0] === 'rm') await onRemoval?.();
    if (args[0] === 'ps' && args.some(value => value.startsWith('name=^/'))) {
      h.calls.push({ args, options: options ?? {} });
      await onInspection?.();
      if (inspection === 'thrown') throw new Error('engine unavailable');
      return { code: inspection === 'failed' ? 1 : 0,
        stdout: inspection === 'present' ? 'e'.repeat(12) : '',
        stderr: inspection === 'failed' || inspection === 'ambiguous' ? 'inspection incomplete' : '' };
    }
    return h.command(file, args, options);
  });
  await assert.rejects(runtime.readWorkspace('cleanup', 'artifact.txt'), /보조 컨테이너 종료/);
  failCleanup = false;
  return { h, runtime, inspect: (value: typeof inspection) => { inspection = value; },
    duringRemoval: (callback: () => Promise<void>) => { onRemoval = callback; },
    duringInspection: (callback: () => Promise<void>) => { onInspection = callback; } };
}

test('deployment rechecks a timed-out helper by exact name and clears only absent bookkeeping without deleting resources', async () => {
  const { h, runtime } = await cleanupDrainHarness();
  await assert.rejects(runtime.listWorkspaceVolumes(), /정리 확인/);
  const before = h.calls.length;
  await runtime.confirmDeploymentIdle();
  const calls = h.calls.slice(before);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(call => call.args[0] === 'ps'), 'drain never removes containers or volumes');
  assert.match(calls.at(-1)!.args.at(-1)!, /^name=\^\/ac-ws-[a-f0-9-]{36}\$$/);
  await runtime.readWorkspace('cleanup', 'artifact.txt');
  const next = h.calls.length;
  await runtime.confirmDeploymentIdle();
  assert.equal(h.calls.slice(next).filter(call => call.args.some(value => value.startsWith('name='))).length, 0);
});

test('deployment retains cleanup bookkeeping when an exact-name container exists or inspection is failed or ambiguous', async () => {
  for (const state of ['present', 'failed', 'thrown', 'ambiguous'] as const) {
    const { h, runtime, inspect } = await cleanupDrainHarness(); inspect(state);
    const before = h.calls.length;
    await assert.rejects(runtime.confirmDeploymentIdle(), state === 'present' ? /pending_cleanup/ : /cleanup_inspection_failed/);
    await assert.rejects(runtime.listWorkspaceVolumes(), /정리 확인/);
    assert.ok(h.calls.slice(before).every(call => call.args[0] === 'ps'));
    inspect('absent'); await runtime.confirmDeploymentIdle(); await runtime.readWorkspace('cleanup', 'artifact.txt');
  }
});

test('deployment keeps absent cleanup records when a concurrent workspace operation starts and finishes during inspection', async () => {
  const { runtime, duringInspection } = await cleanupDrainHarness();
  duringInspection(async () => { assert.equal(await runtime.canResume({ ...input('concurrent'), previousResult: result() }), true); });
  await assert.rejects(runtime.confirmDeploymentIdle(), /activity_changed/);
  await assert.rejects(runtime.listWorkspaceVolumes(), /정리 확인/);
  duringInspection(async () => {});
  await runtime.confirmDeploymentIdle(); await runtime.readWorkspace('cleanup', 'artifact.txt');
});

test('deployment reports the active workspace operation count and code if activity begins during inventory', async () => {
  const h = harness();
  let release!: () => void, started!: () => void, releaseScan!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const scan = new Promise<void>(resolve => { releaseScan = resolve; });
  const runtime = new ContainerRuntime(config, async (file, args, options) => {
    if (args[0] === 'ps' && args.includes('-aq')) { started(); await scan; }
    if (args[0] === 'volume' && args[1] === 'ls') await hold;
    return h.command(file, args, options);
  });
  const checking = runtime.confirmDeploymentIdle(); await entered;
  const listing = runtime.listWorkspaceVolumes(); releaseScan();
  await assert.rejects(checking, error => {
    const failure = error as Error & { code: string; blockers: Array<{ code: string; count: number }> };
    assert.equal(failure.code, 'DEPLOYMENT_RUNTIME_BUSY');
    assert.match(failure.message, /작업공간 작업 1건 \[workspace_operations\]/);
    assert.deepEqual(failure.blockers, [{ code: 'workspace_operations', label: '작업공간 작업', count: 1 }]);
    return true;
  });
  release(); await listing; await runtime.confirmDeploymentIdle();
});

test('deployment refuses to reconcile while normal settlement is still awaiting helper termination', async () => {
  const { runtime, duringRemoval } = await cleanupDrainHarness();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  duringRemoval(async () => { started(); await held; });
  const settling = runtime.settle('cleanup'); await entered;
  await assert.rejects(runtime.confirmDeploymentIdle(), /실행 종료 정리 1건 \[settlement_operations\]/);
  release(); await settling; await runtime.confirmDeploymentIdle();
});

test('deployment preparation during attempt persistence blocks the actual model launch and settles telemetry', async () => {
  for (const mode of ['docker', 'kubernetes'] as const) {
  const h = harness();
  let creates = 0;
  const runner: Command = async (file, args, options) => {
    if (file === 'kubectl') { if (args.includes('create')) creates++; return { code: 0, stdout: 'fixture', stderr: '' }; }
    return h.command(file, args, options);
  };
  const runtime = new ContainerRuntime({ ...config, mode, context: 'ctx', namespace: 'ns', authSecret: 'auth' }, runner);
  const stopped = Object.assign(new Error('deployment hold'), { code: 'DEPLOYMENT_PAUSED' });
  let held = false;
  const statuses: string[] = [];
  await assert.rejects(runtime.execute(input('admission-race'), {
    ...hooks(), beforeModelStart: async () => assert.equal(held, false),
    onAttempt: async attempt => { statuses.push(attempt.status); if (attempt.status === 'started') { await delay(0); held = true; } },
    assertModelStart: () => { if (held) throw stopped; },
  }), error => error === stopped);
  assert.deepEqual(statuses, ['started', 'failed']);
  assert.equal(h.calls.filter(call => call.args[0] === 'run' && call.options.input && JSON.parse(call.options.input).phase).length, 0);
  assert.equal(creates, 0);
  if (mode === 'docker') await runtime.confirmDeploymentIdle();
  }
});

test('growth propagates deployment pause and resumes the saved baseline without completing it as inconclusive', async () => {
  const h = harness({ model: payload => payload.phase === 'task' ? { ...result(), skills: [{ name: 'candidate', description: 'fixture', content: 'procedure' }] }
    : payload.phase === 'trial' ? result(payload.input.skills.length ? 'candidate' : 'baseline')
    : { verdict: 'equivalent', reason: 'same scoped quality', evidence: ['both completed'], usefulChanges: [], failures: [], inputTokens: 1, outputTokens: 1 } });
  const runtime = new ContainerRuntime(config, h.command), selected = input('growth-drain');
  let checkpoint: ExecutionCheckpoint | undefined, trialStarts = 0;
  const stopped = Object.assign(new Error('deployment hold'), { code: 'DEPLOYMENT_PAUSED' });
  await assert.rejects(runtime.execute(selected, { ...hooks(),
    beforeModelStart: async request => { if (request.phase === 'trial' && ++trialStarts === 2) throw stopped; },
    onCheckpoint: async value => { checkpoint = structuredClone(value); },
  }), error => error === stopped);
  assert.equal(checkpoint?.phase, 'evaluate');
  const saved = Object.values(checkpoint!.growthProgress!)[0] as { trials: unknown[]; completed?: unknown };
  assert.equal(saved.trials.length, 1); assert.equal(saved.completed, undefined);
  const resumed = await runtime.execute({ ...selected, checkpoint }, hooks());
  assert.equal(resumed.skills[0].comparison?.verdict, 'equivalent');
  const models = h.calls.filter(call => call.args[0] === 'run' && call.options.input && JSON.parse(call.options.input).phase);
  assert.deepEqual(models.map(call => JSON.parse(call.options.input!).phase), ['task', 'trial', 'trial', 'evaluate']);
});

test('separate historical catalogs route task, session, fork and new environment selection without changing active provider', async () => {
  const h = harness(), runtime = new ContainerRuntime(historicalConfig, h.command);
  const selected = input('history'), before = structuredClone(selected);
  assert.deepEqual(runtime.defaultReleasePin, modernPin);
  assert.deepEqual(runtime.selectReleasePinForEnvironment(imageA), pinA);
  assert.deepEqual(runtime.selectReleasePinForEnvironment(), modernPin);
  assert.throws(() => runtime.selectReleasePinForEnvironment(`sha256:${'f'.repeat(64)}`), blocked);
  assert.deepEqual(runtime.forkWorkspace('new-generation').selectReleasePinForEnvironment(imageA), pinA);
  await runtime.execute(selected, hooks()); await runtime.execute(input('modern', modernPin), hooks());
  selected.checkpoint = { phase: 'task', sessionId: 'f129b6b4-a825-4205-a48c-193aa5083c66' }; h.own(selected.run.id);
  assert.equal(await runtime.canResume(selected), true);
  const models = h.calls.filter(call => call.options.input && JSON.parse(call.options.input).phase);
  assert.deepEqual(models.map(call => call.args.at(-1)), [imageA, modern.image]);
  assert.ok(h.calls.find(call => call.args.includes('--check-session'))!.args.includes(imageA));
  assert.deepEqual(selected.run, before.run); assert.deepEqual(runtime.defaultReleasePin, modernPin);
  await runtime.confirmDeploymentIdle();
});

test('historical environment builds and consumption use their own base and reject a cross-base mount before helpers', async () => {
  const h = harness(), runtime = new ContainerRuntime(historicalConfig, h.command), build = input('historical-environment');
  build.run.kind = 'environment'; build.environmentBuild = { revisionId: 'environment-old', spec: { packages: [], servers: [] } };
  const result = await runtime.execute(build, hooks());
  assert.equal(result.environmentBuild!.imageId, imageA);
  const selected = input('historical-consumer');
  selected.environment = { revisionId: 'environment-old', buildRunId: build.run.id, spec: build.environmentBuild.spec, report: result.environmentBuild! };
  await runtime.execute(selected, hooks());
  const count = h.calls.length, mismatched = { ...selected, run: { ...selected.run, runtimeRelease: modernPin } };
  await assert.rejects(runtime.execute(mismatched, hooks()), blocked);
  await assert.rejects(runtime.canResume({ ...mismatched, previousResult: result }), blocked);
  assert.throws(() => dockerArguments(historicalConfig, 'mismatched', mismatched), blocked);
  assert.equal(h.calls.length, count);
  assert.ok(h.calls.filter(call => call.args.at(-1) === '/app/environment.mjs').every(call => call.args.includes(imageA)));
});

test('historical image absence is blocked even when the active provider exists', async () => {
  const h = harness({ missing: [imageA] }), runtime = new ContainerRuntime(historicalConfig, h.command);
  await assert.rejects(runtime.execute(input('missing-old'), hooks()), blocked);
  assert.equal(h.calls.some(call => call.args[0] === 'run'), false);
  assert.throws(() => new ContainerRuntime({ ...historicalConfig, releaseCatalog: undefined }, h.command), blocked);
});

test('historical growth trials and judge retain the old image across distinct runtime bases', async () => {
  const h = harness({ model: payload => payload.phase === 'task' ? { ...result(), skills: [{ name: 'candidate', description: 'fixture', content: 'procedure' }] }
    : payload.phase === 'trial' ? result(payload.input.skills.length ? 'candidate' : 'baseline')
    : { verdict: 'equivalent', reason: 'same scoped quality', evidence: ['both completed'], usefulChanges: [], failures: [], inputTokens: 1, outputTokens: 1 } });
  const runtime = new ContainerRuntime(historicalConfig, h.command);
  const output = await runtime.execute(input('historical-growth'), hooks());
  assert.equal(output.skills[0].comparison?.fingerprint.image, imageA);
  const models = h.calls.filter(call => call.args[0] === 'run' && call.options.input && JSON.parse(call.options.input).phase);
  assert.equal(models.length, 4); assert.ok(models.every(call => call.args.at(-1) === imageA));
  assert.ok(h.calls.filter(call => call.args.at(-1) === '/app/workspace.mjs').every(call => call.args.includes(imageA)));
  assert.deepEqual(runtime.defaultReleasePin, modernPin);
});
