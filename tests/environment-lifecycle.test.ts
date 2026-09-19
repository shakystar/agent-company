import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { EnvironmentBuildReport, EnvironmentProposal, EnvironmentToolCall } from '../shared/environment.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';

const proposal = (version = '1.2.3'): EnvironmentProposal => ({ reason: `Test pinned environment ${version}`, requestedAccess: [], spec: {
  packages: [{ name: '@fixture/mcp', version }],
  servers: [{ name: 'fixture', package: '@fixture/mcp', bin: 'fixture-mcp', args: [], probe: { tool: 'echo', arguments: { text: 'probe' } } }],
} });
const result = (patch: Partial<ExecutionResult> = {}): ExecutionResult => ({ result: 'Explicit mock result', memories: [], skills: [], artifacts: [],
  inputTokens: 0, outputTokens: 0, appliedSteeringCount: 0, ...patch });
const buildReport = (input: ExecutionInput): EnvironmentBuildReport => ({ imageId: `sha256:${'a'.repeat(64)}`, contentHash: 'b'.repeat(64), lockfileHash: 'c'.repeat(64),
  packages: structuredClone(input.environmentBuild!.spec.packages),
  tools: [{ server: 'fixture', name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
  checks: [{ name: 'probe', passed: true, detail: 'Explicit mock probe, no Docker or model' }], createdAt: new Date().toISOString() });

class EnvironmentRuntime implements RuntimeDriver {
  readonly workspacePersistence = true;
  available = true;
  readonly calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; resolve: (value: ExecutionResult) => void; reject: (error: Error) => void }> = [];
  readonly resumeChecks: ExecutionInput[] = [];
  readonly toolCalls: Array<{ input: ExecutionInput; call: EnvironmentToolCall; signal: AbortSignal }> = [];
  toolReply: (() => Promise<unknown>) | undefined;
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', available: this.available, authenticated: true,
    image: 'explicit-environment-test-runtime', model: 'fixture-model', version: 'fixture', message: 'No Docker or model calls' }; }
  async settle(): Promise<void> {}
  async canResume(input: ExecutionInput): Promise<boolean> { this.resumeChecks.push(input); return Boolean(input.environmentBuild || input.checkpoint || input.previousResult); }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolveOutput, rejectOutput) => {
      const abort = () => rejectOutput(new Error('Explicit mock interruption'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks,
        resolve: value => { hooks.signal.removeEventListener('abort', abort); resolveOutput(value); },
        reject: error => { hooks.signal.removeEventListener('abort', abort); rejectOutput(error); } });
    });
  }
  async callEnvironmentTool(input: ExecutionInput, call: EnvironmentToolCall, signal: AbortSignal): Promise<unknown> {
    this.toolCalls.push({ input, call, signal });
    return this.toolReply ? this.toolReply() : { content: [{ type: 'text', text: String(call.arguments.text) }] };
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, label = 'environment state'): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`); await delay(5); }
}
async function fixture(t: TestContext, persistent = false, maxAttempts = 1) {
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'ac-environment-lifecycle-')) : undefined;
  const runtime = new EnvironmentRuntime();
  const options = () => ({ runtime, dataDir: directory ? join(directory, 'db') : undefined, recovery: { maxAttempts, retryDelayMs: 0 },
    scheduler: new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
      defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } }) });
  let service = await AgentService.create(options()), closed = false;
  t.after(async () => {
    if (!closed) await service.close();
    if (directory) {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /ac-environment-lifecycle-[^\\/]+$/);
      const entry = await lstat(directory); assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      await rm(directory, { recursive: true });
    }
  });
  return { runtime, get service() { return service; },
    close: async () => { await service.close(); closed = true; },
    reopen: async () => { assert.ok(directory); if (!closed) await service.close(); service = await AgentService.create(options()); closed = false; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function terminal(f: Fixture, id: string) {
  await waitFor(async () => {
    const state = await f.service.workspace(), run = state.runs.find(item => item.id === id)!;
    return ['succeeded', 'failed', 'cancelled'].includes(run.status) && state.agents.find(item => item.id === run.agentId)!.status !== 'running';
  }, 'terminal and released');
  return f.service.workspace();
}
async function nextCall(f: Fixture, index: number) { await waitFor(() => f.runtime.calls.length > index, 'mock runtime execution'); return f.runtime.calls[index]; }
async function ready(f: Fixture, agentId: string, version = '1.2.3') {
  const index = f.runtime.calls.length;
  const revision = await f.service.proposeEnvironment(agentId, proposal(version));
  const call = await nextCall(f, index);
  assert.equal(call.input.environmentBuild!.revisionId, revision.id); assert.equal(call.input.run.kind, 'environment');
  call.resolve(result({ environmentBuild: buildReport(call.input) }));
  const state = await terminal(f, call.input.run.id);
  const saved = state.environmentRevisions!.find(item => item.id === revision.id)!;
  assert.equal(saved.status, 'ready'); assert.equal(state.agents.find(item => item.id === agentId)!.environmentRevisionId, revision.id);
  return saved;
}

test('task proposals automatically build without model records and apply only to the next run', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Automatic setup', persona: 'Use a bounded helper' });
  await f.service.addMemory(agent.id, { kind: 'fact', title: 'User data', content: 'Must survive environment activation' });
  const task = await f.service.startRun(agent.id, 'Propose a useful environment');
  const first = await nextCall(f, 0);
  assert.equal(first.input.environment, undefined);
  first.resolve(result({ environmentProposal: proposal() }));
  const build = await nextCall(f, 1);
  let state = await f.service.workspace();
  const candidate = state.environmentRevisions![0];
  assert.equal(candidate.sourceRunId, task.id); assert.equal(candidate.status, 'building');
  assert.equal(state.runs.find(item => item.id === task.id)!.status, 'succeeded');
  assert.equal(state.agents[0].environmentRevisionId, undefined);
  assert.equal(build.input.environment, undefined); assert.equal(build.input.run.workspaceSourceRunId, null);
  build.resolve(result({ environmentBuild: buildReport(build.input), memories: [{ kind: 'fact', title: 'Build leakage', content: 'Not user knowledge' }] }));
  state = await terminal(f, build.input.run.id);
  assert.equal(state.agents[0].environmentRevisionId, candidate.id); assert.equal(state.agents[0].version, build.input.run.agentVersion + 1);
  assert.equal(state.memories.length, 1); assert.equal(state.memories[0].title, 'User data');
  assert.equal(state.modelAttempts!.length, 0, 'explicit build mock records no model process');
  assert.equal(first.input.environment, undefined, 'completed task input must not change');
  const followup = await f.service.startRun(agent.id, 'Use the selected environment');
  const next = await nextCall(f, 2);
  assert.equal(next.input.environment!.revisionId, candidate.id);
  assert.equal(next.input.environment!.buildRunId, build.input.run.id);
  assert.deepEqual(next.input.collaboration!.tools.map(tool => tool.name).filter(name => !name.startsWith('operator_request_')), ['environment_call']);
  assert.ok(next.input.collaboration!.tools.some(tool => tool.name === 'operator_request_create'));
  next.resolve(result()); await terminal(f, followup.id);
});

test('persisted identical queued proposals are deduplicated before any runtime start', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Idempotency', persona: 'One candidate' });
  await f.service.updateAgent(agent.id, { status: 'paused' });
  const first = await f.service.proposeEnvironment(agent.id, proposal());
  const again = await f.service.proposeEnvironment(agent.id, proposal());
  assert.equal(first.id, again.id); assert.equal((await f.service.workspace()).environmentRevisions!.length, 1);
  assert.equal(f.runtime.calls.length, 0);
});

test('failed, mismatched and cancelled builds preserve the previous ready environment', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Keep known environment', persona: 'Preserve previous' });
  const original = await ready(f, agent.id);
  for (const [index, failure] of ['runtime', 'check', 'package', 'probe', 'cancel'].entries()) {
    const offset = f.runtime.calls.length, revision = await f.service.proposeEnvironment(agent.id, proposal(`1.2.${index + 4}`));
    const call = await nextCall(f, offset);
    if (failure === 'runtime') call.reject(new Error('Controlled installation failure'));
    else if (failure === 'cancel') await f.service.cancelEnvironment(revision.id);
    else {
      const report = buildReport(call.input);
      if (failure === 'check') report.checks[0].passed = false;
      if (failure === 'package') report.packages[0].version = '99.0.0';
      if (failure === 'probe') report.tools = [];
      call.resolve(result({ environmentBuild: report }));
    }
    const state = await terminal(f, call.input.run.id), saved = state.environmentRevisions!.find(item => item.id === revision.id)!;
    assert.equal(saved.status, failure === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(state.agents[0].environmentRevisionId, original.id);
    assert.deepEqual(state.environmentRevisions!.find(item => item.id === original.id), original);
  }
});

test('requested access never starts a build or replaces the active environment', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'No access expansion', persona: 'Bounded' });
  const original = await ready(f, agent.id), count = f.runtime.calls.length;
  const blocked = await f.service.proposeEnvironment(agent.id, { ...proposal('2.0.0'), requestedAccess: ['new GitHub account', 'read another agent workspace'] });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.buildRunId, null);
  await assert.rejects(() => f.service.selectEnvironment(agent.id, blocked.id));
  await delay(20);
  assert.equal(f.runtime.calls.length, count); assert.equal((await f.service.workspace()).agents[0].environmentRevisionId, original.id);
  const cancelled = await f.service.cancelEnvironment(blocked.id); assert.equal(cancelled.status, 'cancelled');
});

test('a completed resumable bundle never replays a functional build rejection', async t => {
  for (const code of ['ENVIRONMENT_REJECTED', undefined]) {
    await t.test(code ?? 'untagged functional rejection', async t => {
      const f = await fixture(t, false, 3), agent = await f.service.createAgent({ name: 'Do not replay rejection', persona: 'Preserve the working environment' });
      const original = await ready(f, agent.id), offset = f.runtime.calls.length;
      const revision = await f.service.proposeEnvironment(agent.id, proposal('2.0.0'));
      const call = await nextCall(f, offset);
      assert.equal(await f.runtime.canResume(call.input), true, 'An intact installed bundle can still fail its declared MCP probe');
      const resumeChecks = f.runtime.resumeChecks.length;
      const error = new Error('MCP tool not declared by this server');
      if (code) Object.assign(error, { code });
      call.reject(error);
      await waitFor(async () => f.runtime.calls.length > offset + 1
        || (await f.service.workspace()).runs.find(run => run.id === call.input.run.id)!.status === 'failed', 'functional rejection or erroneous replay');
      assert.equal(f.runtime.calls.length, offset + 1, 'A deterministic probe failure must execute exactly once despite a retry budget of three');
      const state = await terminal(f, call.input.run.id);
      assert.equal(state.runs.find(run => run.id === call.input.run.id)!.status, 'failed');
      assert.match(state.runs.find(run => run.id === call.input.run.id)!.error!, /tool not declared/);
      assert.equal(state.environmentRevisions!.find(item => item.id === revision.id)!.status, 'failed');
      assert.equal(state.agents[0].environmentRevisionId, original.id);
      assert.deepEqual(state.environmentRevisions!.find(item => item.id === original.id), original);
      assert.equal(f.runtime.resumeChecks.length, resumeChecks, 'Bundle completeness cannot turn rejection into recovery');
      assert.equal(state.modelAttempts!.length, 0);
    });
  }
});

test('an interrupted environment build resumes the same pinned candidate and activates only after success', async t => {
  const f = await fixture(t, false, 3), agent = await f.service.createAgent({ name: 'Resume interrupted setup', persona: 'Preserve progress' });
  const original = await ready(f, agent.id), offset = f.runtime.calls.length;
  const revision = await f.service.proposeEnvironment(agent.id, proposal('2.0.0'));
  const first = await nextCall(f, offset), pinned = structuredClone(first.input.environmentBuild);
  first.reject(Object.assign(new Error('Environment helper interrupted by SIGTERM'), { code: 'ENVIRONMENT_INTERRUPTED' }));
  const resumed = await nextCall(f, offset + 1);
  assert.equal(resumed.input.run.id, first.input.run.id);
  assert.deepEqual(resumed.input.environmentBuild, pinned);
  assert.equal(resumed.input.environmentBuild!.revisionId, revision.id);
  assert.ok(f.runtime.resumeChecks.some(input => input.run.id === first.input.run.id));
  const during = await f.service.workspace();
  assert.equal(during.agents[0].environmentRevisionId, original.id);
  assert.notEqual(during.environmentRevisions!.find(item => item.id === revision.id)!.status, 'ready');
  resumed.resolve(result({ environmentBuild: buildReport(resumed.input) }));
  const state = await terminal(f, resumed.input.run.id);
  assert.equal(f.runtime.calls.length, offset + 2);
  assert.equal(state.runs.find(run => run.id === resumed.input.run.id)!.status, 'succeeded');
  assert.equal(state.environmentRevisions!.find(item => item.id === revision.id)!.status, 'ready');
  assert.equal(state.agents[0].environmentRevisionId, revision.id);
  assert.deepEqual(state.environmentRevisions!.find(item => item.id === original.id), original);
  assert.equal(state.modelAttempts!.length, 0);
});

test('an agent version change during verification preserves the verified candidate without activating it', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Version race', persona: 'First persona' });
  const original = await ready(f, agent.id);
  const revision = await f.service.proposeEnvironment(agent.id, proposal('2.0.0'));
  const call = await nextCall(f, 1);
  await f.service.updateAgent(agent.id, { persona: 'Next task persona' });
  call.resolve(result({ environmentBuild: buildReport(call.input) }));
  const state = await terminal(f, call.input.run.id), saved = state.environmentRevisions!.find(item => item.id === revision.id)!;
  assert.equal(saved.status, 'ready'); assert.ok(saved.error); assert.equal(state.agents[0].environmentRevisionId, original.id);
  assert.equal(state.agents[0].persona, 'Next task persona');
  await f.service.selectEnvironment(agent.id, saved.id); assert.equal((await f.service.workspace()).agents[0].environmentRevisionId, saved.id);
});

test('a queued proposal based on the previous environment cannot start after another candidate activates', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Queued base race', persona: 'One current base' });
  const original = await ready(f, agent.id);
  await f.service.updateAgent(agent.id, { status: 'paused' });
  const first = await f.service.proposeEnvironment(agent.id, proposal('2.0.0'));
  const stale = await f.service.proposeEnvironment(agent.id, proposal('3.0.0'));
  assert.equal(first.baseRevisionId, original.id); assert.equal(stale.baseRevisionId, original.id);
  await f.service.updateAgent(agent.id, { status: 'idle' });
  const call = await nextCall(f, 1);
  assert.equal(call.input.environmentBuild!.revisionId, first.id);
  call.resolve(result({ environmentBuild: buildReport(call.input) }));
  await terminal(f, call.input.run.id);
  await waitFor(async () => (await f.service.workspace()).environmentRevisions!.find(item => item.id === stale.id)!.status === 'blocked');
  const state = await f.service.workspace();
  assert.equal(state.agents[0].environmentRevisionId, first.id);
  assert.equal(state.environmentRevisions!.find(item => item.id === stale.id)!.buildRunId, null);
  assert.equal(f.runtime.calls.length, 2);
});

test('explicit environment selection cancels unstarted stale proposals', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Manual selection wins', persona: 'Retain user choice' });
  const original = await ready(f, agent.id);
  await f.service.updateAgent(agent.id, { status: 'paused' });
  const pending = await f.service.proposeEnvironment(agent.id, proposal('2.0.0'));
  await f.service.selectEnvironment(agent.id, null);
  const state = await f.service.workspace();
  assert.equal(state.agents[0].environmentRevisionId, null);
  assert.equal(state.environmentRevisions!.find(item => item.id === pending.id)!.status, 'cancelled');
  assert.deepEqual(state.environmentRevisions!.find(item => item.id === original.id), original);
  assert.equal(f.runtime.calls.length, 1);
});

test('snapshot fork and restore retain separate manifests and immutable bundle references', async t => {
  const f = await fixture(t), owner = await f.service.createAgent({ name: 'Source', persona: 'Original' });
  const original = await ready(f, owner.id), snapshot = await f.service.createSnapshot(owner.id, 'Known environment');
  const before = structuredClone(original);
  const clone = await f.service.forkAgent(owner.id, { name: 'Clone', snapshotId: snapshot.id });
  let state = await f.service.workspace();
  const forked = state.environmentRevisions!.find(item => item.id === clone.environmentRevisionId)!;
  assert.notEqual(forked.id, original.id); assert.equal(forked.agentId, clone.id); assert.equal(forked.sourceRevisionId, original.id);
  assert.equal(forked.buildRunId, original.buildRunId); assert.deepEqual(forked.report, original.report);
  await assert.rejects(() => f.service.selectEnvironment(clone.id, original.id));
  await assert.rejects(() => f.service.selectEnvironment(owner.id, forked.id));
  const newEnvironment = await ready(f, owner.id, '2.0.0');
  await f.service.restoreAgent(owner.id, { snapshotId: snapshot.id, restoreEnvironment: false });
  assert.equal((await f.service.workspace()).agents.find(item => item.id === owner.id)!.environmentRevisionId, newEnvironment.id);
  await f.service.restoreAgent(owner.id, { snapshotId: snapshot.id, restoreEnvironment: true });
  state = await f.service.workspace();
  assert.equal(state.agents.find(item => item.id === owner.id)!.environmentRevisionId, original.id);
  assert.equal(state.agents.find(item => item.id === clone.id)!.environmentRevisionId, forked.id);
  assert.deepEqual(state.environmentRevisions!.find(item => item.id === original.id), before);
  assert.deepEqual(state.environmentRevisions!.find(item => item.id === forked.id), forked);
});

test('reopened task input keeps its selected environment and session after persona changes', async t => {
  const f = await fixture(t, true), agent = await f.service.createAgent({ name: 'Durable environment', persona: 'Original task persona' });
  const original = await ready(f, agent.id), run = await f.service.startRun(agent.id, 'Continue with the selected environment');
  const call = await nextCall(f, 1), pinned = structuredClone(call.input.environment);
  await call.hooks.onCheckpoint!({ phase: 'task', sessionId: 'preserved-test-session', appliedSteeringCount: 0 });
  await f.service.updateAgent(agent.id, { persona: 'Future task persona' });
  await f.reopen();
  const resumed = await nextCall(f, 2);
  assert.equal(resumed.input.run.id, run.id); assert.equal(resumed.input.checkpoint!.sessionId, 'preserved-test-session');
  assert.deepEqual(resumed.input.environment, pinned); assert.equal(resumed.input.environment!.revisionId, original.id);
  assert.equal(resumed.input.agent.persona, call.input.agent.persona);
  resumed.resolve(result()); await terminal(f, run.id);
});

test('cancelled pending environments stay cancelled across restart and consume no execution', async t => {
  const f = await fixture(t, true), agent = await f.service.createAgent({ name: 'Pending cancellation', persona: 'No restart' });
  await f.service.updateAgent(agent.id, { status: 'paused' });
  const revision = await f.service.proposeEnvironment(agent.id, proposal());
  await f.service.cancelEnvironment(revision.id); await f.reopen();
  await f.service.updateAgent(agent.id, { status: 'idle' });
  await delay(1100);
  const state = await f.service.workspace();
  assert.equal(state.environmentRevisions![0].status, 'cancelled'); assert.equal(state.environmentRevisions![0].buildRunId, null);
  assert.equal(state.runs.length, 0); assert.equal(f.runtime.calls.length, 0);
});

test('cancelled building environments stay cancelled after database reopen', async t => {
  const f = await fixture(t, true), agent = await f.service.createAgent({ name: 'Active build cancellation', persona: 'No automatic retry' });
  const original = await ready(f, agent.id);
  const cancelled = await f.service.proposeEnvironment(agent.id, proposal('2.0.0'));
  const call = await nextCall(f, 1);
  await assert.rejects(() => call.hooks.onTool!('environment_call', { server: 'fixture', tool: 'echo', arguments: { text: 'not an ordinary task' } }));
  await f.service.cancelEnvironment(cancelled.id); await terminal(f, call.input.run.id);
  await f.reopen(); await delay(1100);
  const state = await f.service.workspace();
  assert.equal(state.environmentRevisions!.find(item => item.id === cancelled.id)!.status, 'cancelled');
  assert.equal(state.runs.find(item => item.id === call.input.run.id)!.status, 'cancelled');
  assert.equal(state.agents[0].environmentRevisionId, original.id);
  assert.equal(f.runtime.calls.length, 2); assert.equal(f.runtime.toolCalls.length, 0);
});

test('personal MCP dispatch rejects other tools and drops responses after cancellation', async t => {
  const f = await fixture(t), agent = await f.service.createAgent({ name: 'Scoped MCP', persona: 'One tool only' });
  const original = await ready(f, agent.id), run = await f.service.startRun(agent.id, 'Call a registered tool');
  const call = await nextCall(f, 1);
  for (const args of [{ server: 'other', tool: 'echo', arguments: {} }, { server: 'fixture', tool: 'unregistered', arguments: {} }]) {
    await assert.rejects(() => call.hooks.onTool!('environment_call', args));
  }
  assert.equal(f.runtime.toolCalls.length, 0);
  assert.deepEqual(await call.hooks.onTool!('environment_call', { server: 'fixture', tool: 'echo', arguments: { text: 'actual call' } }),
    { content: [{ type: 'text', text: 'actual call' }] });
  assert.equal(f.runtime.toolCalls[0].input.environment!.revisionId, original.id);
  let finishReply!: (value: unknown) => void;
  f.runtime.toolReply = () => new Promise(resolve => { finishReply = resolve; });
  const pending = call.hooks.onTool!('environment_call', { server: 'fixture', tool: 'echo', arguments: { text: 'late' } });
  const rejected = assert.rejects(pending, /취소|종료/);
  await waitFor(() => f.runtime.toolCalls.length === 2);
  await f.service.cancelRun(run.id); finishReply({ untrustedLateResult: true }); await rejected;
  await terminal(f, run.id);
  await assert.rejects(() => call.hooks.onTool!('environment_call', { server: 'fixture', tool: 'echo', arguments: { text: 'after cancel' } }));
  assert.equal(f.runtime.toolCalls.length, 2);
});
