import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ContainerRuntime, dockerArguments, taskResultSchema, workspaceVolume, type RuntimeConfig } from '../server/runtime.ts';
import { DockerEnvironments, environmentResources } from '../server/environment-runtime.ts';
import type { Command, CommandOptions } from '../server/process.ts';
import type { DockerWorkspaces } from '../server/workspaces.ts';
import type { EnvironmentBuildReport, EnvironmentSpec } from '../shared/environment.ts';
import type { ExecutionInput, ExecutionHooks } from '../shared/types.ts';

const config: RuntimeConfig = { mode: 'docker', auth: 'none', authFile: 'must-not-read-auth', image: 'worker:environment-test', model: 'test', timeoutMs: 10_000, workspaceKey: 'environment-test', persistentWorkspaces: true };
const imageId = `sha256:${'1'.repeat(64)}`;
const spec: EnvironmentSpec = { packages: [{ name: 'test-mcp', version: '1.2.3' }], servers: [{ name: 'echo', package: 'test-mcp', bin: 'test-mcp', args: [], probe: { tool: 'echo', arguments: { message: 'probe' } } }] };
const bundle = { packages: spec.packages, contentHash: '2'.repeat(64), lockfileHash: '3'.repeat(64) };
const report: EnvironmentBuildReport = { ...bundle, imageId, tools: [{ server: 'echo', name: 'echo', description: 'test', inputSchema: { type: 'object' } }], checks: [{ name: 'test', passed: true, detail: 'test' }], createdAt: new Date().toISOString() };
const at = '2026-09-06T00:00:00.000Z';
const input: ExecutionInput = {
  agent: { id: 'agent-a', name: 'one', description: 'private description', persona: 'private persona', color: '#345555', model: 'test', status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: ['private-repository'], createdAt: at, updatedAt: at },
  run: { id: 'build-run', agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot-a', prompt: 'private task', status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null, kind: 'environment' },
  memories: [{ id: 'memory', agentId: 'agent-a', kind: 'fact', title: 'private memory', content: 'private content', sourceRunId: null, createdAt: at, updatedAt: at }], skills: [], connections: [],
  environmentBuild: { revisionId: 'environment-a', spec }, resources: { memoryMiB: 768, cpus: 0.8 },
};
const hooks = (): ExecutionHooks => ({ signal: new AbortController().signal, onEvent: async () => {}, getSteering: async () => [], beforeModelStart: async () => assert.fail('environment installation must not start a model') });
function harness() {
  const calls: Array<{ args: string[]; options: CommandOptions }> = [], volumes = new Map<string, unknown>();
  let failOperation = '', failureCode = 1, invalidId = false, cleanupFails = false, writable = false, live = 0, maxLive = 0;
  const command: Command = async (_file, args, options = {}) => {
    calls.push({ args, options }); const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'version') return ok('29.1.3');
    if (args[0] === 'image') return ok(imageId);
    if (args[0] === 'ps') return ok(writable && args.includes(`volume=${workspaceVolume(config, 'build-run')}`) ? 'a'.repeat(12) : '');
    if (args[0] === 'inspect') return ok(JSON.stringify([{ Name: workspaceVolume(config, 'build-run'), RW: true }]));
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return ok();
      if (args[1] === 'inspect') return volumes.has(args[2]) ? ok(JSON.stringify(volumes.get(args[2]))) : { code: 1, stdout: '', stderr: 'No such volume' };
      if (args[1] === 'create') {
        const labels: Record<string, string> = {}; args.forEach((value, index) => { if (value === '--label') { const [key, ...parts] = args[index + 1].split('='); labels[key] = parts.join('='); } });
        volumes.set(args.at(-1)!, labels); return ok();
      }
    }
    if (args[0] === 'rm') return cleanupFails && args.at(-1)!.startsWith('ac-env-') ? { code: 1, stdout: '', stderr: 'engine unavailable' } : ok();
    if (args[0] === 'run') {
      const request = JSON.parse(options.input!);
      if (args.at(-1) === '/app/workspace.mjs') return ok(JSON.stringify({ version: 1, state: 'ready', runId: request.runId, sourceRunId: request.sourceRunId, files: 0, bytes: 0, reused: false }));
      if (args.at(-1) === '/app/environment.mjs') {
        if (request.operation === failOperation) return { code: failureCode, stdout: '', stderr: 'controlled failure' };
        if (request.operation === 'call') { live++; maxLive = Math.max(maxLive, live); await delay(15); live--; }
        return ok(JSON.stringify({ id: invalidId ? 'forged-id' : request.id, value: request.operation === 'call' ? { ...bundle, tools: report.tools, result: { content: [{ type: 'text', text: 'probe' }] }, sessionMode: 'stateless-per-call' } : bundle }));
      }
    }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const own = (runId = input.run.id) => volumes.set(workspaceVolume(config, runId), { app: 'agent-company', 'agent-company.workspace': config.workspaceKey, 'agent-company.run': runId });
  return { command, calls, volumes, own, fail: (value: string, code = 1) => { failOperation = value; failureCode = code; }, invalidId: () => { invalidId = true; }, cleanup: (value: boolean) => { cleanupFails = value; }, writable: () => { writable = true; }, maxLive: () => maxLive };
}
const selected = (): ExecutionInput => ({ ...structuredClone(input), run: { ...input.run, id: 'task-run', kind: 'task' }, environmentBuild: undefined, environment: { revisionId: 'environment-a', buildRunId: input.run.id, spec, report } });

test('environment builds use zero model starts, no authentication or user data, and separated install/probe containers', async () => {
  const h = harness(), runtime = new ContainerRuntime(config, h.command);
  const result = await runtime.execute(input, hooks());
  assert.equal(result.inputTokens + result.outputTokens, 0); assert.equal(result.environmentBuild?.tools[0].name, 'echo');
  const helpers = h.calls.filter(call => call.args.at(-1) === '/app/environment.mjs');
  assert.deepEqual(helpers.map(call => JSON.parse(call.options.input!).operation), ['install', 'verify', 'call']);
  for (const { args, options } of helpers) {
    const request = JSON.parse(options.input!);
    assert.ok(args.includes(request.operation === 'install' ? '--network=bridge' : '--network=none'));
    assert.ok(args.includes('--user=1000:1000') && args.includes('--read-only') && args.includes('--cap-drop=ALL'));
    assert.ok(args.includes(`agent-company.run=${input.run.id}`));
    assert.ok(!JSON.stringify({ args, request }).includes('private'));
    assert.ok(!args.some(arg => /OPENAI|CODEX|docker.sock|PATH=/.test(arg)));
    assert.ok(args.some(arg => arg.includes(`source=${workspaceVolume(config, input.run.id)}`)));
    assert.equal(request.auth, undefined);
  }
  assert.ok(h.volumes.has(workspaceVolume(config, input.run.id)));
});

test('model manifests mount only the selected bundle read-only and split the lease without PATH injection', () => {
  const current = selected(), args = dockerArguments(config, 'worker', current, true);
  assert.ok(args.includes('--memory=384m') && args.includes('--cpus=0.4'));
  assert.ok(args.includes(`type=volume,source=${workspaceVolume(config, input.run.id)},target=/opt/agent-environment,readonly,volume-nocopy`));
  assert.ok(!args.some(arg => /NODE_PATH|NODE_OPTIONS|PYTHONPATH|--env=PATH/.test(arg)));
  const split = environmentResources(current.resources);
  assert.equal(split.worker.memoryMiB + split.helper.memoryMiB, current.resources!.memoryMiB);
  assert.equal(split.worker.cpus + split.helper.cpus, current.resources!.cpus);
  assert.throws(() => environmentResources({ memoryMiB: 128, cpus: 0.1 }));
});

test('installation failure preserves its owned partial volume and never proceeds to probes', async () => {
  const h = harness(); h.fail('install'); const runtime = new ContainerRuntime(config, h.command);
  await assert.rejects(runtime.execute(input, hooks()), /controlled failure/);
  assert.ok(h.volumes.has(workspaceVolume(config, input.run.id)));
  assert.equal(h.calls.filter(call => call.args.at(-1) === '/app/environment.mjs').length, 1);
  assert.ok(h.calls.some(call => call.args[0] === 'rm' && call.args.at(-1)!.startsWith('ac-env-')));
});

test('environment helper exits distinguish functional rejection from SIGKILL and SIGTERM interruption', async () => {
  for (const exitCode of [1, 2, 125, 126, 127, 137, 143]) {
    const h = harness(); h.fail('call', exitCode);
    const runtime = new ContainerRuntime(config, h.command);
    await assert.rejects(runtime.execute(input, hooks()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`call 실패 \\(${exitCode}\\)`));
      assert.equal((error as Error & { code: string }).code, [137, 143].includes(exitCode) ? 'ENVIRONMENT_INTERRUPTED' : 'ENVIRONMENT_REJECTED');
      return true;
    });
    const operations = h.calls.filter(call => call.args.at(-1) === '/app/environment.mjs').map(call => JSON.parse(call.options.input!).operation);
    assert.deepEqual(operations, ['install', 'verify', 'call']);
    assert.equal(await runtime.canResume(input), true, 'Completed bundle verification remains true after either kind of failed MCP probe');
    assert.ok(h.volumes.has(workspaceVolume(config, input.run.id)));
    const started = h.calls.filter(call => call.args[0] === 'run' && call.args.at(-1) === '/app/environment.mjs');
    for (const call of started) {
      const name = call.args[call.args.indexOf('--name') + 1];
      assert.ok(h.calls.some(cleanup => cleanup.args[0] === 'rm' && cleanup.args.at(-1) === name));
    }
  }
});

test('MCP response IDs, writable bundles, and calls outside active model runs are rejected', async () => {
  const h = harness(); h.own(); h.invalidId(); const runtime = new ContainerRuntime(config, h.command);
  await assert.rejects(runtime.execute(input, hooks()));
  const second = harness(); second.own(); second.writable();
  const environments = new DockerEnvironments(config, second.command, () => ({} as DockerWorkspaces), runId => workspaceVolume(config, runId), async () => true);
  await assert.rejects(environments.verify(selected(), new AbortController().signal), /쓰기 중인/);
  await assert.rejects(runtime.callEnvironmentTool(selected(), { server: 'echo', tool: 'echo', arguments: {} }, new AbortController().signal), /진행 중인/);
});

test('helper cleanup failure is quarantined until settle confirms termination', async () => {
  const h = harness(); h.cleanup(true); const runtime = new ContainerRuntime(config, h.command);
  await assert.rejects(runtime.execute(input, hooks()), (error: any) => error.code === 'RUNTIME_CLEANUP_PENDING');
  await assert.rejects(runtime.settle(input.run.id), /정리/);
  h.cleanup(false); await runtime.settle(input.run.id);
  assert.ok(h.volumes.has(workspaceVolume(config, input.run.id)));
});

test('only an intact completed owned build is considered resumable', async () => {
  const h = harness(), runtime = new ContainerRuntime(config, h.command);
  assert.equal(await runtime.canResume(input), false);
  h.own(); assert.equal(await runtime.canResume(input), true);
  const probe = h.calls.find(call => call.args.at(-1) === '/app/environment.mjs')!;
  assert.ok(probe.args.includes('--memory=128m') && probe.args.includes('--cpus=0.1'));
  h.fail('verify'); assert.equal(await runtime.canResume(input), false);
});

test('per-run MCP calls are serialized inside one reserved helper allocation', async () => {
  const h = harness(); h.own();
  const environments = new DockerEnvironments(config, h.command, () => ({} as DockerWorkspaces), runId => workspaceVolume(config, runId), async () => true);
  const signal = new AbortController().signal, call = { server: 'echo', tool: 'echo', arguments: {} };
  await Promise.all([environments.call(selected(), call, signal), environments.call(selected(), call, signal)]);
  assert.equal(h.maxLive(), 1);
  await assert.rejects(async () => environments.call(selected(), { ...call, tool: 'undeclared' }, signal), /없는/);
});

test('runtime task result parsing preserves a validated environment proposal', () => {
  const proposal = { reason: 'use the task parser', spec, requestedAccess: [] };
  const result = taskResultSchema.parse({ result: 'done', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0, environmentProposal: proposal });
  assert.deepEqual(result.environmentProposal, proposal);
});
