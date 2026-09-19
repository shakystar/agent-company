import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { WorkspaceStore } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { DesktopUpdatePreparation, MAX_DESKTOP_UPDATE_ATTEMPTS } from '../server/desktop-update-preparation.ts';
import type { DeploymentStatus } from '../shared/deployment.ts';
import { ResourceScheduler } from '../server/resources.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, Run, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';

const pin = { image: `sha256:${'7'.repeat(64)}`, manifestId: '8'.repeat(64) };
const output: ExecutionResult = { result: 'Preserved fixture result', artifacts: [], memories: [], skills: [],
  inputTokens: 3, outputTokens: 2, appliedSteeringCount: 0 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Isolated update preparation timed out'); await delay(10); }
}
class Runtime implements RuntimeDriver {
  defaultReleasePin = pin;
  pinError = false;
  pinGate?: ReturnType<typeof deferred>;
  validationEntered = 0;
  idleEntered = 0;
  idleGate?: ReturnType<typeof deferred>;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; resolve: (result: ExecutionResult) => void; reject: (error: Error) => void }> = [];
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', simulation: true, available: true, authenticated: true,
    image: pin.image, model: 'fixture', version: 'fixture', message: 'No Docker or model process' }; }
  async validateRunRelease(run: Run) {
    this.validationEntered++; await this.pinGate?.promise;
    if (this.pinError || !run.runtimeRelease) throw Object.assign(new Error('PRIVATE_RUNTIME_PIN_DETAIL'), { code: 'RUNTIME_RELEASE_BLOCKED' });
  }
  async confirmDeploymentIdle() { this.idleEntered++; await this.idleGate?.promise; }
  async settle() {}
  async canResume(input: ExecutionInput) { return Boolean(input.checkpoint || input.previousResult); }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      hooks.signal.addEventListener('abort', () => reject(new Error('Fixture closed')), { once: true });
      this.calls.push({ input, hooks, resolve, reject });
    });
  }
}
const scheduler = () => new ResourceScheduler({ capacity: { cpus: 1, memoryMiB: 1024 }, defaultRequest: {
  minimum: { cpus: 1, memoryMiB: 1024 }, preferred: { cpus: 1, memoryMiB: 1024 },
} });
const signal = () => new AbortController().signal;

test('native update lease drains the admitted turn and preserves queued work, pin and checkpoint until its cancel', async () => {
  const runtime = new Runtime(), resources = scheduler();
  const service = await AgentService.create({ runtime, scheduler: resources });
  try {
    const a = await service.createAgent({ name: 'Current turn', persona: 'fixture' });
    const b = await service.createAgent({ name: 'Queued turn', persona: 'fixture' });
    const first = await service.startRun(a.id, 'Preserve the current session');
    const second = await service.startRun(b.id, 'Preserve the queued task');
    await until(() => runtime.calls.length === 1 && resources.snapshot().waiting.length === 1);
    const current = runtime.calls[0];
    await current.hooks.beforeModelStart!({ runId: first.id, phase: 'task', kind: 'fixture', reason: 'admitted turn' });
    const lease = await service.acquireDesktopUpdate();
    assert.equal((await lease.status()).phase, 'draining');
    assert.equal(current.hooks.signal.aborted, false);
    assert.throws(() => current.hooks.assertModelStart!(), { code: 'DEPLOYMENT_PAUSED' });
    await assert.rejects(service.resumeDeployment(), { statusCode: 409 });
    await assert.rejects(service.acquireDesktopUpdate(), { statusCode: 409 });
    await until(() => resources.snapshot().waiting.length === 0);
    await current.hooks.onCheckpoint!({ phase: 'evaluate', sessionId: 'unchanged-session', previousResult: output, appliedSteeringCount: 0 });
    let stopped: Error | undefined;
    try { await current.hooks.beforeModelStart!({ runId: first.id, phase: 'evaluate', kind: 'fixture', reason: 'next phase' }); }
    catch (error) { stopped = error as Error; }
    assert.equal((stopped as Error & { code: string }).code, 'DEPLOYMENT_PAUSED'); current.reject(stopped!);
    await until(async () => (await lease.status()).phase === 'ready');
    const state = await service.workspace();
    for (const id of [first.id, second.id]) {
      const run = state.runs.find(item => item.id === id)!;
      assert.equal(run.status, 'queued'); assert.equal(run.error, null); assert.equal(run.completedAt, null);
      assert.deepEqual(run.runtimeRelease, pin);
    }
    assert.equal(runtime.calls.length, 1); assert.equal(resources.snapshot().reserved.memoryMiB, 0);
    assert.equal((await lease.status()).pendingRunCount, 2);
    assert.equal((await lease.cancel()).phase, 'running');
    await until(() => runtime.calls.length === 2);
    const resumed = runtime.calls[1];
    if (resumed.input.run.id !== first.id) {
      resumed.resolve(output); await until(() => runtime.calls.length === 3);
    }
    const continued = runtime.calls.slice(1).find(call => call.input.run.id === first.id)!;
    assert.equal(continued.input.checkpoint?.sessionId, 'unchanged-session');
    assert.deepEqual(continued.input.previousResult ?? continued.input.checkpoint?.previousResult, output);
    assert.deepEqual(continued.input.run.runtimeRelease, pin);
  } finally { await service.close(); }
});

test('an existing durable hold and an in-progress resume cannot be acquired by a native update', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime });
  const gate = deferred();
  try {
    runtime.idleGate = gate;
    await service.prepareDeployment();
    const held = await service.deploymentStatus();
    await assert.rejects(service.acquireDesktopUpdate(), { statusCode: 409 });
    assert.equal((await service.deploymentStatus()).requestedAt, held.requestedAt);
    await until(() => runtime.idleEntered > 0);
    const resuming = service.resumeDeployment();
    await assert.rejects(service.acquireDesktopUpdate(), { statusCode: 409 });
    gate.resolve(); assert.equal((await resuming).phase, 'running');
    const lease = await service.acquireDesktopUpdate();
    assert.notEqual((await lease.status()).phase, 'running');
    assert.equal((await lease.cancel()).phase, 'running');
  } finally { gate.resolve(); await service.close(); }
});

test('failed pin validation retains update ownership for the same cancellation retry and invalidates an old lease', async () => {
  const runtime = new Runtime(); runtime.pinError = true;
  const service = await AgentService.create({ runtime });
  try {
    const agent = await service.createAgent({ name: 'Retained task', persona: 'fixture' });
    const original = await service.startRun(agent.id, 'Do not consume another attempt');
    await until(async () => Boolean((await service.workspace()).runs[0].runtimeReleaseBlockedReason));
    const lease = await service.acquireDesktopUpdate();
    await assert.rejects(lease.cancel(), { code: 'RUNTIME_RELEASE_BLOCKED' });
    assert.notEqual((await lease.status()).phase, 'running');
    await assert.rejects(service.resumeDeployment(), { statusCode: 409 });
    await assert.rejects(service.acquireDesktopUpdate(), { statusCode: 409 });
    const waiting = (await service.workspace()).runs.find(run => run.id === original.id)!;
    assert.equal(waiting.attempt ?? 0, 0); assert.equal(waiting.error, null); assert.equal(runtime.calls.length, 0);
    runtime.pinError = false;
    assert.equal((await lease.cancel()).phase, 'running');
    await until(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0].input.run.id, original.id);
    const next = await service.acquireDesktopUpdate();
    await assert.rejects(lease.cancel(), { statusCode: 409 });
    await assert.rejects(lease.status(), { statusCode: 409 });
    assert.notEqual((await next.status()).phase, 'running');
  } finally { await service.close(); }
});

test('private update identifiers are idempotent, scoped to the owning lease, and expose counts without internal reasons', async () => {
  const runtime = new Runtime(), service = await AgentService.create({ runtime });
  try {
    const preparation = new DesktopUpdatePreparation(service), updateId = randomUUID(), other = randomUUID();
    const request = { type: 'prepare-update' as const, updateId };
    const first = await preparation.control(request, signal());
    assert.deepEqual(Object.keys(first).sort(), ['activeRunCount', 'pendingRunCount', 'phase']);
    const requestedAt = (await service.deploymentStatus()).requestedAt;
    await preparation.control(request, signal());
    assert.equal((await service.deploymentStatus()).requestedAt, requestedAt);
    for (const type of ['prepare-update', 'update-status', 'cancel-update'] as const) {
      await assert.rejects(preparation.control({ type, updateId: other }, signal()), /DESKTOP_UPDATE_NOT_OWNED/);
    }
    const canceled = await preparation.control({ type: 'cancel-update', updateId }, signal());
    assert.equal(canceled.phase, 'running');
    assert.deepEqual(await preparation.control({ type: 'cancel-update', updateId }, signal()), canceled);
    await assert.rejects(preparation.control(request, signal()), /DESKTOP_UPDATE_ALREADY_CANCELLED/);
    await assert.rejects(preparation.control({ type: 'update-status', updateId }, signal()), /DESKTOP_UPDATE_NOT_OWNED/);
    await preparation.control({ type: 'prepare-update', updateId: other }, signal());
    await assert.rejects(preparation.control({ type: 'cancel-update', updateId }, signal()), /DESKTOP_UPDATE_NOT_OWNED/);
    await preparation.control({ type: 'cancel-update', updateId: other }, signal());
    await assert.rejects(preparation.control(request, signal()), /DESKTOP_UPDATE_ALREADY_CANCELLED/);
    assert.equal(runtime.calls.length, 0);
  } finally { await service.close(); }
});

test('overlapping private control is rejected and an aborted in-flight prepare finishes before retaining its durable hold', async () => {
  const service = await AgentService.create({ runtime: new Runtime() });
  const acquired = deferred(), gate = deferred(), controller = new AbortController();
  try {
    const preparation = new DesktopUpdatePreparation({
      acquireDesktopUpdate: async () => { const lease = await service.acquireDesktopUpdate(); acquired.resolve(); await gate.promise; return lease; },
      deploymentStatus: () => service.deploymentStatus(),
      beginClose: () => service.beginClose(),
    });
    const updateId = randomUUID(); let settled = false;
    const pending = preparation.control({ type: 'prepare-update', updateId }, controller.signal).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, /Fixture parent EOF/);
    await acquired.promise;
    await assert.rejects(preparation.control({ type: 'update-status', updateId }, signal()), /DESKTOP_UPDATE_CONTROL_BUSY/);
    controller.abort(new Error('Fixture parent EOF'));
    await delay(10); assert.equal(settled, false);
    gate.resolve(); await rejected;
    assert.notEqual((await service.deploymentStatus()).phase, 'running');
    await assert.rejects(service.resumeDeployment(), { statusCode: 409 });
    assert.equal((await preparation.control({ type: 'cancel-update', updateId }, signal())).phase, 'running');
  } finally { gate.resolve(); await service.close(); }
});

test('private control keeps the same identifier after a failed cancellation and permits its explicit retry', async () => {
  const runtime = new Runtime(); runtime.pinError = true;
  const service = await AgentService.create({ runtime });
  try {
    const agent = await service.createAgent({ name: 'Control retry', persona: 'fixture' });
    const original = await service.startRun(agent.id, 'Preserve registration');
    await until(async () => Boolean((await service.workspace()).runs[0].runtimeReleaseBlockedReason));
    const preparation = new DesktopUpdatePreparation(service), updateId = randomUUID();
    await preparation.control({ type: 'prepare-update', updateId }, signal());
    await assert.rejects(preparation.control({ type: 'cancel-update', updateId }, signal()), { code: 'RUNTIME_RELEASE_BLOCKED' });
    const status = await preparation.control({ type: 'update-status', updateId }, signal());
    assert.notEqual(status.phase, 'running'); assert.equal(status.pendingRunCount, 1);
    assert.ok(!JSON.stringify(status).includes('PRIVATE_RUNTIME_PIN_DETAIL'));
    await assert.rejects(preparation.control({ type: 'prepare-update', updateId: randomUUID() }, signal()), /DESKTOP_UPDATE_NOT_OWNED/);
    runtime.pinError = false;
    assert.equal((await preparation.control({ type: 'cancel-update', updateId }, signal())).phase, 'running');
    await until(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0].input.run.id, original.id);
  } finally { await service.close(); }
});

test('beginClose during cancellation waits for validation without clearing the hold or reopening queued work', async () => {
  const runtime = new Runtime(); runtime.pinError = true;
  const service = await AgentService.create({ runtime }), gate = deferred();
  try {
    const agent = await service.createAgent({ name: 'Close boundary', persona: 'fixture' });
    const original = await service.startRun(agent.id, 'Retain while the parent closes');
    await until(async () => Boolean((await service.workspace()).runs[0].runtimeReleaseBlockedReason));
    const preparation = new DesktopUpdatePreparation(service), updateId = randomUUID(), controller = new AbortController();
    await preparation.control({ type: 'prepare-update', updateId }, signal());
    runtime.pinError = false; runtime.pinGate = gate;
    const validations = runtime.validationEntered; let settled = false;
    const pending = preparation.control({ type: 'cancel-update', updateId }, controller.signal).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, { statusCode: 409 });
    await until(() => runtime.validationEntered > validations);
    preparation.beginClose(); controller.abort(new Error('Fixture shutdown'));
    await delay(10); assert.equal(settled, false);
    gate.resolve(); await rejected;
    assert.notEqual((await service.deploymentStatus()).phase, 'running');
    assert.equal(runtime.calls.length, 0);
    const retained = (await service.workspace()).runs.find(run => run.id === original.id)!;
    assert.equal(retained.status, 'queued'); assert.equal(retained.attempt ?? 0, 0); assert.equal(retained.error, null);
  } finally { gate.resolve(); await service.close(); }
});

test('restarting loses only ephemeral update ownership and preserves the durable hold, original Run and checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-desktop-update-'));
  let service: AgentService | undefined;
  try {
    const runtime = new Runtime(); service = await AgentService.create({ runtime, dataDir: directory });
    const agent = await service.createAgent({ name: 'Restart', persona: 'fixture' });
    const original = await service.startRun(agent.id, 'Keep the same task');
    await until(() => runtime.calls.length === 1);
    const current = runtime.calls[0];
    await current.hooks.onCheckpoint!({ phase: 'task', sessionId: 'restart-session' });
    await service.acquireDesktopUpdate(); await service.close(); service = undefined;
    const store = await WorkspaceStore.open(directory);
    let holdId: string;
    try { const state = await store.read(); assert.ok(state.deploymentHold); holdId = state.deploymentHold.id;
      assert.equal(state.runs[0].id, original.id); assert.equal(state.runs[0].status, 'queued'); }
    finally { await store.close(); }
    const replacement = new Runtime(); service = await AgentService.create({ runtime: replacement, dataDir: directory });
    await until(async () => (await service!.deploymentStatus()).phase === 'ready');
    assert.equal(replacement.calls.length, 0);
    await assert.rejects(service.acquireDesktopUpdate(), { statusCode: 409 });
    const before = (await service.workspace()).runs.find(run => run.id === original.id)!;
    assert.equal(before.snapshotId, original.snapshotId); assert.deepEqual(before.runtimeRelease, pin);
    assert.ok(holdId!);
    assert.equal((await service.resumeDeployment()).phase, 'running', 'a new controller must not inherit the former private owner');
    await until(() => replacement.calls.length === 1);
    assert.equal(replacement.calls[0].input.run.id, original.id);
    assert.equal(replacement.calls[0].input.checkpoint?.sessionId, 'restart-session');
  } finally {
    await service?.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /ac-desktop-update-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});

test('closing admission blocks both model gates before asynchronous shutdown reaches an active Run', async () => {
  for (const gate of ['beforeModelStart', 'assertModelStart'] as const) {
    const runtime = new Runtime(), service = await AgentService.create({ runtime });
    try {
      const agent = await service.createAgent({ name: 'Close admission', persona: 'fixture' });
      const run = await service.startRun(agent.id, 'Keep the interrupted task');
      await until(() => runtime.calls.length === 1);
      const call = runtime.calls[0];
      service.beginClose();
      assert.throws(() => service.admitExternalRequest(), { statusCode: 409 });
      if (gate === 'assertModelStart') assert.throws(() => call.hooks.assertModelStart!(), { name: 'AbortError' });
      else await assert.rejects(call.hooks.beforeModelStart!({ runId: run.id, phase: 'evaluate', kind: 'fixture', reason: 'next phase' }), { name: 'AbortError' });
      assert.equal(call.hooks.signal.aborted, true);
      assert.equal(runtime.calls.length, 1);
    } finally { await service.close(); }
  }
});

test('the real HTTP resume route cannot release a private native update hold', async () => {
  let service!: AgentService;
  const app = await createApp({ runtime: new Runtime(), desktopUpdate: value => { service = value; } });
  try {
    const preparation = new DesktopUpdatePreparation(service), updateId = randomUUID();
    await preparation.control({ type: 'prepare-update', updateId }, signal());
    const resumed = await app.inject({ method: 'POST', url: '/api/deployment/resume', payload: {} });
    assert.equal(resumed.statusCode, 409);
    assert.equal((await app.inject('/api/deployment')).statusCode, 200);
    assert.equal((await app.inject('/api/workspace')).statusCode, 200);
    assert.notEqual((await preparation.control({ type: 'update-status', updateId }, signal())).phase, 'running');
    assert.equal((await preparation.control({ type: 'cancel-update', updateId }, signal())).phase, 'running');
    assert.equal((await app.inject({ method: 'POST', url: '/api/deployment/resume', payload: {} })).statusCode, 200);
  } finally { await app.close(); }
});

test('the 256-attempt session limit rejects new acquisition while retaining prior cancellation replies', async () => {
  assert.equal(MAX_DESKTOP_UPDATE_ATTEMPTS, 256);
  let acquisitions = 0, cancellations = 0, phase: DeploymentStatus['phase'] = 'running';
  const status = async (): Promise<DeploymentStatus> => ({ phase, requestedAt: null, readyAt: null,
    activeRunIds: [], pendingRunCount: 0, reason: null });
  const preparation = new DesktopUpdatePreparation({
    deploymentStatus: status, beginClose() {},
    acquireDesktopUpdate: async () => {
      acquisitions++; phase = 'ready';
      return { status, cancel: async () => { cancellations++; phase = 'running'; return status(); } };
    },
  });
  const completed: string[] = [];
  for (let index = 0; index < MAX_DESKTOP_UPDATE_ATTEMPTS; index++) {
    const updateId = randomUUID(); completed.push(updateId);
    assert.equal((await preparation.control({ type: 'prepare-update', updateId }, signal())).phase, 'ready');
    assert.equal((await preparation.control({ type: 'cancel-update', updateId }, signal())).phase, 'running');
  }
  await assert.rejects(preparation.control({ type: 'prepare-update', updateId: randomUUID() }, signal()), /DESKTOP_UPDATE_SESSION_LIMIT/);
  for (const updateId of [completed[0], completed.at(-1)!]) {
    await assert.rejects(preparation.control({ type: 'prepare-update', updateId }, signal()), /DESKTOP_UPDATE_ALREADY_CANCELLED/);
    assert.deepEqual(await preparation.control({ type: 'cancel-update', updateId }, signal()),
      { phase: 'running', activeRunCount: 0, pendingRunCount: 0 });
  }
  assert.equal(acquisitions, 256); assert.equal(cancellations, 256);
});
