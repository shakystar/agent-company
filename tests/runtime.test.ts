import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ContainerRuntime, dockerArguments, kubernetesResources, runtimeConfig, taskResultSchema, workspaceVolume, type RuntimeConfig } from '../server/runtime.ts';
import { DockerWorkspaces } from '../server/workspaces.ts';
import type { Command } from '../server/process.ts';
import type { ExecutionInput } from '../shared/types.ts';

const config: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'test-only-not-a-secret', authFile: '', image: 'worker:test', model: 'test-model', timeoutMs: 10_000 };
const at = '2026-09-06T00:00:00.000Z';
const input: ExecutionInput = {
  agent: { id: 'agent-a', name: 'one', description: '', persona: 'Research', color: '#345555', model: 'test-model', status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: at, updatedAt: at },
  run: { id: 'run-a', agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot-a', prompt: 'a task', status: 'running', result: '', error: null, inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: at, startedAt: at, completedAt: null },
  memories: [], skills: [], connections: [],
};
const task = { result: 'completed', memories: [], skills: [{ name: 'useful', description: 'specific', content: 'a technique' }], artifacts: [], inputTokens: 10, outputTokens: 4 };
function harness(handler?: (payload: any, options: any) => unknown | Promise<unknown>) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const execute: Command = async (file, args, options = {}) => {
    calls.push({ file, args, input: options.input });
    if (args[0] === 'version') return { code: 0, stdout: '29.0.0', stderr: '' };
    if (args[0] === 'image' || args[0] === 'rm') return { code: 0, stdout: 'ok', stderr: '' };
    const payload = JSON.parse(options.input!);
    const result = handler ? await handler(payload, options) : payload.phase === 'task' ? task : { evaluations: [{ index: 0, passed: true, reason: 'useful', evidence: 'checked against a second task' }], inputTokens: 5, outputTokens: 2 };
    await options.onLine?.(JSON.stringify({ type: 'result', result }));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, execute };
}
const hooks = () => ({ signal: new AbortController().signal, onEvent: async (_message: string) => {}, getSteering: async () => [] as string[] });

test('Docker manifest has no host mounts, daemon socket, privilege or credential arguments', () => {
  const args = dockerArguments(config, 'ac-run-a-task');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges:true'));
  assert.ok(args.includes('--user=1000:1000'));
  assert.ok(!args.some(arg => /--privileged|--volume|--mount|docker.sock|test-only-not-a-secret/.test(arg)));
});

test('Kubernetes needs explicit destination, disables retries/token mount, separates scratch volumes', () => {
  assert.throws(() => kubernetesResources(config, 'ac-run-a-task', {}), /context/);
  const k8s = { ...config, mode: 'kubernetes' as const, namespace: 'agents', context: 'chosen-cluster', authSecret: 'existing-model-auth' };
  const manifests = kubernetesResources(k8s, 'ac-run-a-task', { input });
  const job = manifests.items[1] as any;
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.ok(job.spec.template.spec.volumes.every((volume: any) => !volume.hostPath));
  assert.ok(!JSON.stringify(manifests).includes(config.apiKey!));
});

test('auth is opt-in and config rejects invalid modes/timeouts', () => {
  assert.equal(runtimeConfig({}).auth, 'none');
  assert.throws(() => runtimeConfig({ AGENT_RUNTIME: 'host' }));
  assert.throws(() => runtimeConfig({ AGENT_TIMEOUT_SECONDS: 'NaN' }));
});

test('explicit WSL target uses argv, not a shell or implicit fallback', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const driver = new ContainerRuntime({ ...config, wslDistro: 'Ubuntu-22.04' }, async (file, args) => {
    calls.push({ file, args }); return { code: 0, stdout: 'engine-ok', stderr: '' };
  });
  assert.equal((await driver.inspect()).available, true);
  assert.equal(calls[0].file, 'wsl.exe');
  assert.deepEqual(calls[0].args.slice(0, 4), ['--distribution', 'Ubuntu-22.04', '--exec', 'docker']);
  assert.throws(() => runtimeConfig({ AGENT_DOCKER_WSL_DISTRO: '--help' }), /WSL/);
});

test('namespace profile is opt-in, cannot request unconfined, and is Docker-only', () => {
  assert.equal(runtimeConfig({}).dockerSandbox, 'default');
  assert.throws(() => runtimeConfig({ AGENT_DOCKER_SANDBOX: 'unconfined' }), /AGENT_DOCKER_SANDBOX/);
  assert.throws(() => runtimeConfig({ AGENT_RUNTIME: 'kubernetes', AGENT_DOCKER_SANDBOX: 'codex-userns' }), /Docker/);
  assert.throws(() => dockerArguments({ ...config, dockerSandbox: 'codex-userns' }, 'run'), /seccomp/);
  const secured = dockerArguments({ ...config, dockerSandbox: 'codex-userns', seccompProfile: '/chosen/profile.json' }, 'run');
  assert.ok(secured.includes('--security-opt=seccomp=/chosen/profile.json'));
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000']) assert.ok(secured.includes(flag));
});

test('approved namespace profile maps to the WSL client and secures the model task', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const driver = new ContainerRuntime({ ...config, dockerSandbox: 'codex-userns', wslDistro: 'Ubuntu-22.04' }, async (file, args, options) => {
    calls.push({ file, args });
    assert.equal(file, 'wsl.exe');
    const executable = args[3], rest = args.slice(4);
    if (executable === 'wslpath') return { code: 0, stdout: '/mnt/c/project/worker/security/codex-userns.json\n', stderr: '' };
    if (rest[0] === 'version') return { code: 0, stdout: rest[2].includes('Arch') ? '29.1.3/amd64' : '29.1.3', stderr: '' };
    if (rest[0] === 'run') {
      assert.ok(rest.includes('--security-opt=seccomp=/mnt/c/project/worker/security/codex-userns.json'));
      const payload = JSON.parse(options!.input!);
      await options!.onLine?.(JSON.stringify({ type: 'result', result: payload.phase === 'task' ? task : { evaluations: [], inputTokens: 0, outputTokens: 0 } }));
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  });
  await driver.execute(input, hooks());
  assert.equal(calls.filter(call => call.args[3] === 'wslpath').length, 1);
  assert.equal(calls.filter(call => call.args[4] === 'run').length, 1);
});

test('namespace profile refuses unverified engine versions without starting workers', async () => {
  const calls: string[][] = [];
  const driver = new ContainerRuntime({ ...config, dockerSandbox: 'codex-userns' }, async (_file, args) => {
    calls.push(args); return { code: 0, stdout: '30.0.0', stderr: '' };
  });
  await assert.rejects(driver.execute(input, hooks()), /재검증/);
  assert.equal(calls.filter(args => args[0] === 'run').length, 0);
});

test('worker limits exactly honor scheduler grants on Docker and Kubernetes', async () => {
  const allocated = { ...input, resources: { memoryMiB: 1024, cpus: 0.75 } };
  const h = harness();
  await new ContainerRuntime(config, h.execute).execute(allocated, hooks());
  for (const call of h.calls.filter(call => call.args[0] === 'run')) {
    assert.ok(call.args.includes('--memory=1024m'));
    assert.ok(call.args.includes('--cpus=0.75'));
  }
  const manifest = kubernetesResources({ ...config, namespace: 'a', context: 'b', authSecret: 'c' }, 'run', { input: allocated });
  const job = manifest.items[1] as any;
  assert.deepEqual(job.spec.template.spec.containers[0].resources.limits, { cpu: '0.75', memory: '1024Mi' });
});

test('persistent workspaces use run-owned named volumes, never host paths or auth', () => {
  const persistent = { ...config, workspaceKey: 'workspace-a', persistentWorkspaces: true };
  const args = dockerArguments(persistent, 'ac-run-a-task', input, true);
  assert.ok(args.includes(`type=volume,source=${workspaceVolume(persistent, input.run.id)},target=/workspace`));
  assert.notEqual(workspaceVolume(persistent, 'run-a'), workspaceVolume(persistent, 'run-b'));
  assert.notEqual(workspaceVolume(persistent, 'run-a'), workspaceVolume({ ...persistent, workspaceKey: 'other' }, 'run-a'));
  assert.ok(!args.join(' ').includes(config.apiKey!));
});

test('completed task checkpoint preserves its output when independent comparison is unavailable', async () => {
  const previousResult = { ...task, skills: task.skills.map(skill => ({ ...skill, passed: false, evaluation: 'pending' })) };
  const h = harness();
  const checkpoints: string[] = [];
  const driver = new ContainerRuntime(config, h.execute);
  const resumed = { ...input, checkpoint: { phase: 'evaluate' as const, previousResult, appliedSteeringCount: 0 } };
  assert.equal(await driver.canResume(resumed), true);
  const result = await driver.execute(resumed, { ...hooks(), onCheckpoint: async checkpoint => { checkpoints.push(checkpoint.phase); } });
  assert.equal(result.result, 'completed');
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 0);
  assert.equal(result.skills[0].passed, false);
  assert.equal(result.skills[0].comparison?.verdict, 'inconclusive');
  assert.deepEqual(checkpoints, ['evaluate', 'evaluate', 'complete']);
  assert.equal(result.learningReview?.status, 'deferred');
  assert.match(result.learningReview!.reason, /구형 실행기/);
});

test('task recovery rejects absent or wrong-owned workspace and invalid session', async () => {
  const driver = new ContainerRuntime({ ...config, workspaceKey: 'our-workspace', persistentWorkspaces: true }, async () => ({ code: 0, stdout: 'someone-else', stderr: '' }));
  assert.equal(await driver.canResume(input), false);
  assert.equal(await driver.canResume({ ...input, checkpoint: { phase: 'task', sessionId: '../auth' } }), false);
  assert.equal(await driver.canResume({ ...input, checkpoint: { phase: 'task', sessionId: '12345678-1234-1234-1234-123456789abc' } }), false);
});

test('resume session probe is labelled, read-only and cleaned after success or interrupted CLI', async () => {
  for (const interrupted of [false, true]) {
    const persistent = { ...config, workspaceKey: 'probe-workspace', persistentWorkspaces: true };
    const calls: string[][] = [];
    const driver = new ContainerRuntime(persistent, async (_file, args) => {
      calls.push(args);
      if (args[0] === 'volume') return { code: 0, stdout: JSON.stringify({ app: 'agent-company', 'agent-company.workspace': persistent.workspaceKey, 'agent-company.run': input.run.id }), stderr: '' };
      if (args[0] === 'run') {
        assert.ok(args.includes('app=agent-company')); assert.ok(args.includes(`agent-company.workspace=${persistent.workspaceKey}`));
        assert.ok(args.includes('--network=none')); assert.ok(args.some(arg => arg.endsWith('target=/workspace,readonly')));
        assert.ok(!args.some(arg => arg.includes(config.apiKey!)));
        if (interrupted) throw new Error('CLI timed out');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    assert.equal(await driver.canResume({ ...input, checkpoint: { phase: 'task', sessionId: '12345678-1234-1234-1234-123456789abc' } }), !interrupted);
    assert.deepEqual(calls.at(-1), ['rm', '-f', 'ac-run-a-session-probe']);
  }
});

test('session probe rejects active or wrong-run volumes and retains a failed cleanup gate', async () => {
  for (const scenario of ['active', 'wrong-run', 'cleanup-failure']) {
    const persistent = { ...config, workspaceKey: 'probe-workspace', persistentWorkspaces: true };
    const calls: string[][] = []; let cleanupFails = true;
    const driver = new ContainerRuntime(persistent, async (_file, args) => {
      calls.push(args);
      if (args[0] === 'volume') return { code: 0, stdout: JSON.stringify({ app: 'agent-company', 'agent-company.workspace': persistent.workspaceKey, 'agent-company.run': scenario === 'wrong-run' ? 'someone-else' : input.run.id }), stderr: '' };
      if (args[0] === 'ps' && scenario === 'active') return { code: 0, stdout: 'active-container', stderr: '' };
      if (args[0] === 'rm' && cleanupFails) return { code: 1, stdout: '', stderr: 'engine unavailable' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const resumable = { ...input, checkpoint: { phase: 'task' as const, sessionId: '12345678-1234-1234-1234-123456789abc' } };
    if (scenario !== 'cleanup-failure') {
      assert.equal(await driver.canResume(resumable), false);
      assert.equal(calls.some(args => args[0] === 'run'), false);
    }
    else {
      await assert.rejects(driver.canResume(resumable), { code: 'RUNTIME_CLEANUP_PENDING' });
      await assert.rejects(driver.canResume(resumable), { code: 'RUNTIME_CLEANUP_PENDING' });
      assert.equal(calls.filter(args => args[0] === 'run').length, 1, 'Pending probe cleanup cannot start another probe');
      await assert.rejects(driver.listWorkspaceVolumes(), /정리/);
      await assert.rejects(driver.settle(input.run.id), /정리/);
      cleanupFails = false; await driver.settle(input.run.id);
      assert.deepEqual(calls.at(-1), ['rm', '-f', 'ac-run-a-session-probe']);
      assert.equal(await driver.canResume(resumable), true);
    }
  }
});

test('resume waits for a forked runtime inventory helper instead of treating its read-only mount as an active task', async () => {
  const persistent = { ...config, workspaceKey: 'resume-inventory-race', persistentWorkspaces: true };
  let release!: () => void, measured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const measuring = new Promise<void>(resolve => { measured = resolve; });
  let activeMeasure = false, prematureChecks = 0, probes = 0;
  const runner: Command = async (_file, args, options = {}) => {
    if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: workspaceVolume(persistent, input.run.id), stderr: '' };
    if (args[0] === 'volume') {
      const labels = { app: 'agent-company', 'agent-company.workspace': persistent.workspaceKey, 'agent-company.run': input.run.id };
      return { code: 0, stdout: JSON.stringify(args.includes('{{json .}}') ? { Name: workspaceVolume(persistent, input.run.id), Labels: labels } : labels), stderr: '' };
    }
    if (args[0] === 'ps') {
      if (activeMeasure) prematureChecks++;
      return { code: 0, stdout: activeMeasure ? 'readonly-measure-helper' : '', stderr: '' };
    }
    if (args[0] === 'run' && args.includes('/app/storage.mjs')) {
      activeMeasure = true; measured(); await gate;
      await options.onStdout?.(Buffer.from('{"bytes":10,"files":1}'));
    } else if (args[0] === 'run') probes++;
    if (args[0] === 'rm' && args[2].startsWith('ac-ws-')) activeMeasure = false;
    return { code: 0, stdout: '', stderr: '' };
  };
  const monitoring = new DockerWorkspaces(persistent, runner, id => workspaceVolume(persistent, id));
  const runtime = new ContainerRuntime(persistent, runner);
  const scan = monitoring.volumes(); await measuring;
  const resume = runtime.canResume({ ...input, checkpoint: { phase: 'task', sessionId: '12345678-1234-1234-1234-123456789abc' } });
  await delay(10);
  const probesDuringMeasurement = probes;
  release();
  const [, resumable] = await Promise.all([scan, resume]);
  assert.equal(prematureChecks, 0); assert.equal(probesDuringMeasurement, 0);
  assert.equal(resumable, true); assert.equal(probes, 1);
});

test('missing Docker remains unavailable, without a simulated execution fallback', async () => {
  const unavailable: Command = async () => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); };
  const driver = new ContainerRuntime(config, unavailable);
  assert.equal((await driver.inspect()).available, false);
  await assert.rejects(driver.execute(input, hooks()), /Docker/);
});

test('auth presence is not silently inferred from unrelated user login', async () => {
  const h = harness();
  const driver = new ContainerRuntime({ ...config, auth: 'none' }, h.execute);
  assert.equal((await driver.inspect()).authenticated, false);
  await assert.rejects(driver.execute(input, hooks()), /AGENT_AUTH/);
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 0);
});

test('missing persistent workspace preserves candidates without starting an unsupported comparison', async () => {
  const h = harness();
  const result = await new ContainerRuntime(config, h.execute).execute(input, hooks());
  assert.equal(result.skills[0].passed, false);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 4);
  const runs = h.calls.filter(call => call.args[0] === 'run');
  assert.equal(runs.length, 1);
  assert.equal(result.skills[0].comparison?.verified, false);
  assert.match(result.skills[0].evaluation, /영속 Docker/);
  assert.equal(h.calls.filter(call => call.args[0] === 'rm').length, 1);
});

test('an author-provided passed flag cannot bypass the evaluator', async () => {
  const h = harness(payload => payload.phase === 'task'
    ? { ...task, skills: [{ ...task.skills[0], passed: true, evaluation: 'I pass myself' }] }
    : { evaluations: [{ index: 0, passed: false, reason: 'not supported', evidence: 'unverified behavior' }], inputTokens: 0, outputTokens: 0 });
  const result = await new ContainerRuntime(config, h.execute).execute(input, hooks());
  assert.equal(result.skills[0].passed, false);
  assert.ok(!result.skills[0].evaluation.includes('I pass myself'));
});

test('unconnected repository transport is explicit, never silently omitted', async () => {
  const h = harness();
  await assert.rejects(new ContainerRuntime(config, h.execute).execute({ ...input, agent: { ...input.agent, repositoryIds: ['repo'] } }, hooks()), /유효한 저장소 연결/);
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 0);
});

test('cancellation cleans up exact container and does not launch evaluation', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); throw new Error('cancelled'); });
  await assert.rejects(new ContainerRuntime(config, h.execute).execute(input, { ...hooks(), signal: controller.signal }), /cancelled/);
  assert.deepEqual(h.calls.at(-1)?.args, ['rm', '-f', 'ac-run-a-task']);
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 1);
});

test('steering arriving during task is consumed before returning final result', async () => {
  let steering: string[] = [];
  const h = harness(payload => {
    if (!payload.steering.length) { steering = ['revise']; return { ...task, skills: [] }; }
    assert.equal(payload.previousTask.result, 'completed');
    return { ...task, result: 'revised', skills: [] };
  });
  const result = await new ContainerRuntime(config, h.execute).execute(input, { ...hooks(), getSteering: async () => [...steering] });
  assert.equal(result.result, 'revised');
  assert.equal(result.inputTokens, 20);
});

test('invalid result cannot be accepted as completed work', async () => {
  const h = harness(() => ({ result: 'looks done' }));
  await assert.rejects(new ContainerRuntime(config, h.execute).execute(input, hooks()));
  assert.equal(h.calls.filter(call => call.args[0] === 'rm').length, 1);
});

test('task skill content and trimmed identities obey the persistence constraints', () => {
  assert.throws(() => taskResultSchema.parse({ ...task, skills: [{ ...task.skills[0], content: '' }] }));
  assert.throws(() => taskResultSchema.parse({ ...task, skills: [{ ...task.skills[0], name: '   ' }] }));
  assert.throws(() => taskResultSchema.parse({ ...task, memories: [{ kind: 'fact', title: '   ', content: 'fact' }] }));
});

test('Kubernetes input is checked using UTF-8 bytes with a 960 KiB ceiling before any create call', async () => {
  const k8s: RuntimeConfig = { ...config, mode: 'kubernetes', namespace: 'agents', context: 'chosen-cluster', authSecret: 'model-auth' };
  assert.doesNotThrow(() => kubernetesResources(k8s, 'test', 'x'.repeat(960 * 1024 - 2)));
  assert.throws(() => kubernetesResources(k8s, 'test', 'x'.repeat(960 * 1024 - 1)), /960 KiB/);
  const unicode = '가'.repeat(330_000);
  assert.ok(unicode.length < 960 * 1024);
  assert.throws(() => kubernetesResources(k8s, 'test', { unicode }), /960 KiB/);
  const calls: string[][] = [];
  const execute: Command = async (_file, args) => { calls.push(args); return { code: 0, stdout: 'ok', stderr: '' }; };
  await assert.rejects(new ContainerRuntime(k8s, execute).execute({ ...input, agent: { ...input.agent, persona: unicode } }, hooks()), /960 KiB/);
  assert.equal(calls.filter(args => args.includes('create')).length, 0);
});

test('failed cleanup preserves the result but blocks new workers until exact-name cleanup succeeds', async () => {
  let removal: 'fail' | 'missing' = 'fail';
  const h = harness(() => ({ ...task, skills: [] }));
  const execute: Command = async (file, args, options) => {
    if (args[0] !== 'rm') return h.execute(file, args, options);
    h.calls.push({ file, args });
    return { code: 1, stdout: '', stderr: removal === 'fail' ? 'engine temporarily unavailable' : 'Error: No such container: already removed' };
  };
  const driver = new ContainerRuntime(config, execute);
  assert.equal((await driver.execute(input, hooks())).result, 'completed');
  const beforeInspection = h.calls.length;
  assert.match((await driver.inspect()).message, /정리가 확인되지/);
  assert.equal(h.calls.length, beforeInspection, 'cached inspection must not mutate containers');
  const second = { ...input, run: { ...input.run, id: 'run-b' } };
  await assert.rejects(driver.execute(second, hooks()), /잔여 실행 환경 정리/);
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 1);
  assert.deepEqual(h.calls.at(-1)?.args, ['rm', '-f', 'ac-run-a-task']);
  removal = 'missing';
  assert.equal((await driver.execute(second, hooks())).result, 'completed');
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 2);
  assert.doesNotMatch((await driver.inspect()).message, /정리가 확인되지/);
  assert.ok(h.calls.filter(call => call.args[0] === 'rm').every(call => ['ac-run-a-task', 'ac-run-b-task'].includes(call.args[2])));
});

test('one worker finishing normally cannot clear an unrelated concurrent cleanup failure', async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  const h = harness(async payload => {
    if (payload.input.run.id === 'run-a') { markFirstStarted(); await firstGate; }
    return { ...task, skills: [] };
  });
  const execute: Command = async (file, args, options) => {
    if (args[0] === 'rm' && args[2] === 'ac-run-b-task') {
      h.calls.push({ file, args });
      return { code: 1, stdout: '', stderr: 'cleanup failed' };
    }
    return h.execute(file, args, options);
  };
  const driver = new ContainerRuntime(config, execute);
  const first = driver.execute(input, hooks());
  await firstStarted;
  const second = { ...input, run: { ...input.run, id: 'run-b' } };
  await driver.execute(second, hooks());
  releaseFirst();
  await first;
  assert.match((await driver.inspect()).message, /정리가 확인되지/);
  await assert.rejects(driver.execute({ ...input, run: { ...input.run, id: 'run-c' } }, hooks()), /ac-run-b-task/);
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 2);
});

test('cancelled workers also retain failed cleanup as a gate for later runs', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); throw new Error('cancelled'); });
  const execute: Command = async (file, args, options) => args[0] === 'rm'
    ? { code: 1, stdout: '', stderr: 'cleanup failed' } : h.execute(file, args, options);
  const driver = new ContainerRuntime(config, execute);
  await assert.rejects(driver.execute(input, { ...hooks(), signal: controller.signal }), /cancelled/);
  await assert.rejects(driver.execute({ ...input, run: { ...input.run, id: 'run-b' } }, hooks()), /잔여 실행 환경 정리/);
  assert.equal(h.calls.filter(call => call.args[0] === 'run').length, 1);
});

test('Kubernetes cleanup retries only the failed job and configmap before another create', async () => {
  const k8s: RuntimeConfig = { ...config, mode: 'kubernetes', namespace: 'agents', context: 'chosen-cluster', authSecret: 'model-auth' };
  const calls: string[][] = [];
  let failDelete = true;
  const execute: Command = async (_file, args, options = {}) => {
    calls.push(args);
    if (args.includes('delete')) return { code: failDelete ? 1 : 0, stdout: '', stderr: failDelete ? 'cleanup failed' : '' };
    if (args.includes('logs')) await options.onLine?.(JSON.stringify({ type: 'result', result: { ...task, skills: [] } }));
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const driver = new ContainerRuntime(k8s, execute);
  assert.equal((await driver.execute(input, hooks())).result, 'completed');
  const second = { ...input, run: { ...input.run, id: 'run-b' } };
  await assert.rejects(driver.execute(second, hooks()), /잔여 실행 환경 정리/);
  assert.equal(calls.filter(args => args.includes('create')).length, 1);
  assert.ok(calls.at(-1)!.includes('job/ac-run-a-task'));
  assert.ok(calls.at(-1)!.includes('configmap/ac-run-a-task'));
  failDelete = false;
  await driver.execute(second, hooks());
  assert.equal(calls.filter(args => args.includes('create')).length, 2);
  assert.doesNotMatch((await driver.inspect()).message, /정리가 확인되지/);
});
