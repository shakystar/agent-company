import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerBrowser, browserResources, type BrowserRuntimeConfig } from '../server/browser-runtime.ts';
import { ContainerRuntime, dockerArguments, runtimeConfig, type RuntimeConfig } from '../server/runtime.ts';
import type { Command, CommandOptions, CommandResult } from '../server/process.ts';
import type { BrowserRequest } from '../shared/browser.ts';
import type { ExecutionInput } from '../shared/types.ts';

const date = '2026-09-08T03:00:00.000Z';
const image = `sha256:${'a'.repeat(64)}`;
const config: BrowserRuntimeConfig = { image, workspaceKey: 'test-browser-workspace', seccompProfile: '/verified/browser-userns.json' };
const input: ExecutionInput = {
  agent: { id: 'agent-a', name: 'Tester', description: '', persona: 'PRIVATE PERSONA MUST NOT ENTER BROWSER', color: '#72836b', model: 'fixture',
    status: 'running', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: date, updatedAt: date },
  run: { id: 'run-a', agentId: 'agent-a', agentVersion: 1, snapshotId: 'snapshot', prompt: 'PRIVATE MODEL INPUT', status: 'running', result: '', error: null,
    inputTokens: 0, outputTokens: 0, artifacts: [], steering: [], createdAt: date, startedAt: date, completedAt: null },
  memories: [], skills: [], connections: [], resources: { memoryMiB: 2048, cpus: 2 },
  collaboration: { tools: [{ name: 'browser_open', description: 'fixture browser', inputSchema: {} }], context: {} },
};
const otherInput = { ...input, run: { ...input.run, id: 'run-b' } };
const open: BrowserRequest = { action: 'open', files: [{ path: 'index.html', contentBase64: Buffer.from('<button>Inspect</button>').toString('base64') }],
  entry: 'index.html', viewport: { width: 1280, height: 720 } };
const success = (value: unknown = { open: true }): CommandResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const signal = () => new AbortController().signal;
type Call = { file: string; args: string[]; options: CommandOptions };
function harness(handler?: (call: Call) => Promise<CommandResult | undefined> | CommandResult | undefined, configuration = config) {
  const calls: Call[] = [];
  const command: Command = async (file, args, options = {}) => {
    const call = { file, args, options }; calls.push(call);
    return await handler?.(call) ?? (args[0] === 'version' ? { code: 0, stdout: '29.1.3/amd64', stderr: '' } : success());
  };
  return { calls, command, browser: new DockerBrowser(command, async () => configuration) };
}
const callsOf = (calls: Call[], operation: string) => calls.filter(call => call.args[0] === operation);
const actionOf = (call: Call): string | undefined => call.args[0] === 'exec' && call.options.input ? JSON.parse(call.options.input).action : undefined;
const pageCalls = (calls: Call[]) => callsOf(calls, 'exec').filter(call => actionOf(call) !== 'status');

test('browser and worker partition exactly the existing scheduler allocation without growing the budget', async () => {
  const runtime: RuntimeConfig = { mode: 'docker', auth: 'none', authFile: '', image: 'worker:fixture', model: 'fixture', timeoutMs: 1000 };
  for (const total of [{ memoryMiB: 1024, cpus: 1 }, { memoryMiB: 1536, cpus: 1.25 }, { memoryMiB: 2048, cpus: 2 }]) {
    const parts = browserResources(total);
    assert.deepEqual(parts.browser, { memoryMiB: 512, cpus: 0.5 });
    assert.equal(parts.browser.memoryMiB + parts.worker.memoryMiB, total.memoryMiB);
    assert.equal(parts.browser.cpus + parts.worker.cpus, total.cpus);
    const workerArgs = dockerArguments(runtime, 'worker', { ...input, resources: total });
    assert.ok(workerArgs.includes(`--memory=${parts.worker.memoryMiB}m`));
    assert.ok(workerArgs.includes(`--cpus=${parts.worker.cpus}`));
    const h = harness();
    await h.browser.call({ ...input, resources: total }, open, signal());
    const browserArgs = callsOf(h.calls, 'run')[0].args;
    assert.ok(browserArgs.includes('--memory=512m')); assert.ok(browserArgs.includes('--cpus=0.5'));
    await h.browser.close(input.run.id);
  }
});

test('browser allocation refuses insufficient, fractional-memory and nonfinite resource grants before creating a session', async () => {
  for (const resources of [{ memoryMiB: 1023, cpus: 1 }, { memoryMiB: 1024, cpus: 0.999 }, { memoryMiB: 1024.5, cpus: 1 },
    { memoryMiB: Number.NaN, cpus: 1 }, { memoryMiB: Number.MAX_SAFE_INTEGER + 1, cpus: 1 }, { memoryMiB: 1024, cpus: Infinity }]) {
    assert.throws(() => browserResources(resources), /최소/);
    const h = harness(); await assert.rejects(h.browser.call({ ...input, resources }, open, signal()), /최소/);
    assert.equal(h.calls.length, 0); assert.equal(h.browser.available, true);
  }
});

test('browser creation pins the image and excludes host networking, mounts, auth, root and host IPC', async () => {
  const h = harness(); const controller = new AbortController();
  await h.browser.call(input, open, controller.signal);
  const start = callsOf(h.calls, 'run')[0];
  assert.equal(start.file, 'docker'); assert.equal(start.args.at(-1), image);
  for (const flag of ['--detach', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--security-opt=seccomp=/verified/browser-userns.json', '--user=1000:1000', '--pids-limit=256', '--network=none', '--shm-size=128m',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000']) assert.ok(start.args.includes(flag), flag);
  const name = start.args[start.args.indexOf('--name') + 1];
  assert.match(name, /^ac-browser-[a-f0-9-]{36}$/);
  assert.ok(start.args.includes('agent-company.workspace=test-browser-workspace'));
  assert.ok(start.args.includes(`agent-company.run=${input.run.id}`)); assert.ok(start.args.includes('agent-company.helper=browser'));
  assert.doesNotMatch(start.args.join(' '), /--privileged|--mount|--volume|docker\.sock|--network[= ](?:host|bridge)|--ipc[= ]host|--pid[= ]host|--user[= ](?:0|root)|--env|--publish/);
  assert.equal(start.options.signal, controller.signal); assert.equal(start.options.timeoutMs, 30_000);
  assert.equal(start.options.input, undefined);
  const execute = pageCalls(h.calls)[0];
  assert.deepEqual(execute.args, ['exec', '-i', name, 'node', '/app/browser.mjs', '--call']);
  assert.equal(execute.options.input, JSON.stringify(open)); assert.equal(execute.options.timeoutMs, 45_000);
  assert.equal(execute.options.signal, controller.signal);
  assert.doesNotMatch(JSON.stringify(h.calls), /PRIVATE PERSONA|PRIVATE MODEL INPUT/);
  await h.browser.close(input.run.id);
});

test('unverified image tags and missing or unconfined isolation configuration never execute Docker', async () => {
  for (const invalid of [{ ...config, image: 'browser:latest' }, { ...config, image: `sha256:${'a'.repeat(63)}` },
    { ...config, image: `sha256:${'A'.repeat(64)}` }, { ...config, workspaceKey: '' }, { ...config, seccompProfile: '' },
    { ...config, seccompProfile: 'unconfined' }]) {
    const h = harness(undefined, invalid);
    await assert.rejects(h.browser.call(input, open, signal()), /불변 브라우저 이미지·격리 프로필/);
    assert.equal(h.calls.length, 0); assert.equal(h.browser.available, true);
  }
});

test('one run retains one container across multiple actions and reopening its source', async () => {
  const h = harness();
  await h.browser.call(input, open, signal());
  for (const request of [{ action: 'snapshot' }, { action: 'click', ref: 'button-1' }, { action: 'fill', ref: 'input-1', value: 'typed text' },
    { action: 'press', key: 'Enter' }, { action: 'resize', width: 390, height: 844 }, { action: 'screenshot' }, open] satisfies BrowserRequest[]) {
    await h.browser.call(input, request, signal());
  }
  assert.equal(callsOf(h.calls, 'run').length, 1);
  assert.equal(new Set(callsOf(h.calls, 'exec').map(call => call.args[2])).size, 1);
  assert.equal(pageCalls(h.calls).length, 8); assert.equal(h.browser.available, false);
  await h.browser.close(input.run.id);
});

test('other runs receive browserBusy and cannot close or issue calls against the current owner', async () => {
  const h = harness(); await h.browser.call(input, open, signal()); const count = h.calls.length;
  for (const request of [open, { action: 'snapshot' }, { action: 'close' }, { action: 'status' }] satisfies BrowserRequest[]) {
    assert.deepEqual(await h.browser.call(otherInput, request, signal()), { browserBusy: true });
  }
  await h.browser.close(otherInput.run.id);
  assert.equal(h.calls.length, count); assert.equal(h.browser.available, false);
  await h.browser.close(input.run.id);
});

test('close confirms removal before another run opens a fresh session; idle status and repeated close are noops', async () => {
  const h = harness();
  assert.deepEqual(await h.browser.call(input, { action: 'status' }, signal()), { open: false });
  assert.deepEqual(await h.browser.call(input, { action: 'close' }, signal()), { closed: true });
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.browser.call(input, { action: 'snapshot' }, signal()), /브라우저 세션이 없습니다/);
  await h.browser.call(input, open, signal());
  assert.deepEqual(await h.browser.call(input, { action: 'close' }, signal()), { closed: true });
  assert.equal(h.browser.available, true);
  await h.browser.close(input.run.id); assert.equal(callsOf(h.calls, 'rm').length, 1);
  await h.browser.call(otherInput, open, signal());
  const names = callsOf(h.calls, 'run').map(call => call.args[call.args.indexOf('--name') + 1]);
  assert.equal(new Set(names).size, 2);
  assert.deepEqual(callsOf(h.calls, 'rm')[0].args, ['rm', '-f', names[0]]);
  assert.equal(callsOf(h.calls, 'rm')[0].options.signal, undefined);
  assert.equal(callsOf(h.calls, 'rm')[0].options.timeoutMs, 15_000);
  await h.browser.close(otherInput.run.id);
});

test('startup nonzero or transport failure removes the generated name and permits a fresh later session', async () => {
  for (const transportFailure of [false, true]) {
    let failStart = true;
    const h = harness(call => {
      if (call.args[0] !== 'run' || !failStart) return;
      failStart = false;
      if (transportFailure) throw new Error('docker run transport failed');
      return { code: 125, stdout: '', stderr: 'container create failed' };
    });
    await assert.rejects(h.browser.call(input, open, signal()), /transport failed|기동 실패/);
    assert.deepEqual(h.calls.map(call => call.args[0]), ['run', 'rm']); assert.equal(h.browser.available, true);
    await h.browser.call(otherInput, open, signal()); assert.equal(callsOf(h.calls, 'run').length, 2);
    await h.browser.close(otherInput.run.id);
  }
});

test('failed browser calls propagate execution, malformed JSON and protocol errors while preserving the owned session for retry or close', async () => {
  for (const failure of [{ code: 1, stdout: '', stderr: 'page crashed' }, { code: 0, stdout: 'not json', stderr: '' },
    success({ error: 'ref is stale' }), new Error('exec transport failed')]) {
    let rejectCall = true;
    const h = harness(call => {
      if (call.args[0] !== 'exec' || actionOf(call) === 'status' || !rejectCall) return;
      rejectCall = false;
      if (failure instanceof Error) throw failure;
      return failure;
    });
    await assert.rejects(h.browser.call(input, open, signal()));
    assert.equal(h.browser.available, false); assert.equal(callsOf(h.calls, 'rm').length, 0);
    await h.browser.call(input, { action: 'snapshot' }, signal()); assert.equal(callsOf(h.calls, 'run').length, 1);
    await h.browser.close(input.run.id); assert.equal(h.browser.available, true);
  }
});

test('cleanup failure retains ownership and reports pending cleanup until removal is confirmed', async () => {
  let removalFails = true;
  const h = harness(call => call.args[0] === 'rm' && removalFails ? { code: 1, stdout: '', stderr: 'daemon unavailable' } : undefined);
  await h.browser.call(input, open, signal());
  await assert.rejects(h.browser.close(input.run.id), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(h.browser.available, false);
  assert.deepEqual(await h.browser.call(otherInput, open, signal()), { browserBusy: true });
  removalFails = false; await h.browser.close(input.run.id); assert.equal(h.browser.available, true);
  await h.browser.call(otherInput, open, signal()); await h.browser.close(otherInput.run.id);
});

test('already removed containers count as confirmed cleanup and do not retain the browser slot', async () => {
  const h = harness(call => call.args[0] === 'rm' ? { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: owned-name' } : undefined);
  await h.browser.call(input, open, signal()); await h.browser.close(input.run.id);
  assert.equal(h.browser.available, true);
});

test('cleanup transport exceptions also retain ownership and are classified as pending cleanup', async () => {
  let removalFails = true;
  const h = harness(call => { if (call.args[0] === 'rm' && removalFails) throw new Error('cleanup timeout'); });
  await h.browser.call(input, open, signal());
  await assert.rejects(h.browser.close(input.run.id), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(h.browser.available, false);
  assert.deepEqual(await h.browser.call(otherInput, open, signal()), { browserBusy: true });
  removalFails = false; await h.browser.close(input.run.id); assert.equal(h.browser.available, true);
});

test('failed startup with failed cleanup never executes calls in an unconfirmed container', async () => {
  let removalFails = true;
  const h = harness(call => {
    if (call.args[0] === 'run') return { code: 125, stdout: '', stderr: 'startup unconfirmed' };
    if (call.args[0] === 'rm' && removalFails) return { code: 1, stdout: '', stderr: 'cleanup unconfirmed' };
  });
  await assert.rejects(h.browser.call(input, open, signal()), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(h.browser.available, false);
  await assert.rejects(h.browser.call(input, { action: 'snapshot' }, signal()), { code: 'RUNTIME_CLEANUP_PENDING' });
  await assert.rejects(h.browser.call(input, open, signal()), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(callsOf(h.calls, 'exec').length, 0);
  removalFails = false; await h.browser.close(input.run.id); assert.equal(h.browser.available, true);
});

test('pre-aborted and queued-aborted requests never issue Docker commands', async () => {
  const h = harness(); const aborted = new AbortController(); aborted.abort(new Error('cancelled before opening'));
  await assert.rejects(h.browser.call(input, open, aborted.signal), /cancelled before opening/);
  assert.equal(h.calls.length, 0); assert.equal(h.browser.available, true);
  let started!: () => void; const reachedExec = new Promise<void>(resolve => { started = resolve; });
  let finish!: (result: CommandResult) => void; const executing = new Promise<CommandResult>(resolve => { finish = resolve; });
  const queued = harness(call => { if (call.args[0] === 'exec' && actionOf(call) !== 'status') { started(); return executing; } });
  const first = queued.browser.call(input, open, signal()); await reachedExec;
  const nextController = new AbortController();
  const next = queued.browser.call(input, { action: 'snapshot' }, nextController.signal);
  const rejected = assert.rejects(next, /cancelled while queued/); nextController.abort(new Error('cancelled while queued'));
  finish(success()); await first; await rejected;
  assert.equal(pageCalls(queued.calls).length, 1); await queued.browser.close(input.run.id);
});

test('parallel calls are serialized within the owner and rejected calls do not poison later operations', async () => {
  let active = 0; let maximum = 0; let number = 0;
  const h = harness(async call => {
    if (call.args[0] !== 'exec' || actionOf(call) === 'status') return;
    active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1;
    if (++number === 2) throw new Error('single call failed');
    return success({ number });
  });
  const results = await Promise.allSettled([h.browser.call(input, open, signal()),
    h.browser.call(input, { action: 'snapshot' }, signal()), h.browser.call(input, { action: 'screenshot' }, signal())]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(maximum, 1); assert.equal(callsOf(h.calls, 'run').length, 1);
  await h.browser.close(input.run.id);
});

test('runtime settlement refuses resource-release confirmation while its browser cleanup is unconfirmed', async () => {
  let removalFails = true;
  const h = harness(call => call.args[0] === 'rm' && removalFails ? { code: 1, stdout: '', stderr: 'still running' } : undefined);
  const runtime: RuntimeConfig = { mode: 'docker', auth: 'none', authFile: '', image: 'worker:fixture', model: 'fixture', timeoutMs: 1000,
    browserImage: image, workspaceKey: config.workspaceKey, seccompProfile: config.seccompProfile };
  const driver = new ContainerRuntime(runtime, h.command);
  await driver.callBrowser(input, open, signal());
  assert.equal(driver.browserAvailable, false);
  await assert.rejects(driver.settle(input.run.id), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(driver.browserAvailable, false);
  removalFails = false; await driver.settle(input.run.id); assert.equal(driver.browserAvailable, true);
  assert.equal(callsOf(h.calls, 'rm').length, 2);
});

test('structured stdout errors from nonzero calls preserve the browser diagnosis without retrying page actions', async () => {
  const h = harness(call => actionOf(call) === 'click' ? {
    code: 1, stdout: JSON.stringify({ error: 'Element ref expired after the previous action' }), stderr: '',
  } : undefined);
  await h.browser.call(input, open, signal());
  await assert.rejects(h.browser.call(input, { action: 'click', ref: 'stale-button' }, signal()), {
    message: 'Element ref expired after the previous action',
  });
  assert.equal(h.calls.filter(call => actionOf(call) === 'click').length, 1);
  assert.equal(h.calls.filter(call => actionOf(call) === 'status').length, 1);
  assert.equal(h.browser.available, false); await h.browser.close(input.run.id);
});

test('startup retries only read-only status until the socket exists, then sends open exactly once', async () => {
  let probes = 0;
  const h = harness(call => {
    if (actionOf(call) !== 'status') return;
    probes += 1;
    if (probes < 3) return { code: 1, stdout: JSON.stringify({ error: 'connect ENOENT /tmp/ac-browser.sock' }), stderr: '' };
    return success({ open: false, files: 0, bytes: 0 });
  });
  const controller = new AbortController(); await h.browser.call(input, open, controller.signal);
  assert.deepEqual(callsOf(h.calls, 'exec').map(actionOf), ['status', 'status', 'status', 'open']);
  assert.equal(callsOf(h.calls, 'run').length, 1);
  for (const probe of h.calls.filter(call => actionOf(call) === 'status')) {
    assert.equal(probe.options.signal, controller.signal);
    assert.ok(probe.options.timeoutMs! > 0 && probe.options.timeoutMs! <= 2000);
  }
  await h.browser.close(input.run.id);
});

test('startup socket polling is bounded and cleans up without dispatching open', { timeout: 6000 }, async () => {
  const h = harness(call => actionOf(call) === 'status' ? {
    code: 1, stdout: JSON.stringify({ error: 'connect ENOENT /tmp/ac-browser.sock' }), stderr: '',
  } : undefined);
  await assert.rejects(h.browser.call(input, open, signal()), /기동 제한 시간/);
  assert.equal(h.calls.filter(call => actionOf(call) === 'status').length, 20);
  assert.equal(pageCalls(h.calls).length, 0); assert.equal(callsOf(h.calls, 'rm').length, 1);
  assert.equal(h.browser.available, true);
});

test('startup permission, transport, malformed status and unrelated ENOENT errors are not retried', async () => {
  for (const failure of [new Error('Docker transport timeout'),
    { code: 1, stdout: JSON.stringify({ error: 'connect EACCES /tmp/ac-browser.sock' }), stderr: '' },
    { code: 1, stdout: JSON.stringify({ error: 'open ENOENT /app/browser.mjs' }), stderr: '' },
    { code: 1, stdout: '', stderr: 'OCI runtime exec failed' },
    { code: 0, stdout: 'broken response', stderr: '' }, success({ notAStatus: true })]) {
    const h = harness(call => {
      if (actionOf(call) !== 'status') return;
      if (failure instanceof Error) throw failure;
      return failure;
    });
    await assert.rejects(h.browser.call(input, open, signal()));
    assert.equal(h.calls.filter(call => actionOf(call) === 'status').length, 1);
    assert.equal(pageCalls(h.calls).length, 0); assert.equal(callsOf(h.calls, 'rm').length, 1);
    assert.equal(h.browser.available, true);
  }
});

test('cancelling startup readiness stops probing and removes the helper with an independent cleanup command', async () => {
  const controller = new AbortController();
  const h = harness(call => {
    if (actionOf(call) !== 'status') return;
    controller.abort(new Error('cancel readiness'));
    return { code: 1, stdout: JSON.stringify({ error: 'connect ENOENT /tmp/ac-browser.sock' }), stderr: '' };
  });
  await assert.rejects(h.browser.call(input, open, controller.signal));
  assert.equal(h.calls.filter(call => actionOf(call) === 'status').length, 1);
  assert.equal(pageCalls(h.calls).length, 0);
  assert.equal(callsOf(h.calls, 'rm')[0].options.signal, undefined); assert.equal(h.browser.available, true);
});

test('a missing socket during a page action is not retried or interpreted as a fresh startup', async () => {
  const h = harness(call => actionOf(call) === 'fill' ? {
    code: 1, stdout: JSON.stringify({ error: 'connect ENOENT /tmp/ac-browser.sock' }), stderr: '',
  } : undefined);
  await h.browser.call(input, open, signal());
  await assert.rejects(h.browser.call(input, { action: 'fill', ref: 'input-1', value: 'once' }, signal()), /connect ENOENT/);
  assert.equal(h.calls.filter(call => actionOf(call) === 'fill').length, 1);
  assert.equal(h.calls.filter(call => actionOf(call) === 'status').length, 1);
  assert.equal(callsOf(h.calls, 'run').length, 1); await h.browser.close(input.run.id);
});

test('failed removal of a previously ready session also blocks owner actions until cleanup succeeds', async () => {
  let removalFails = true;
  const h = harness(call => call.args[0] === 'rm' && removalFails ? { code: 1, stdout: '', stderr: 'still shutting down' } : undefined);
  await h.browser.call(input, open, signal());
  await assert.rejects(h.browser.close(input.run.id), { code: 'RUNTIME_CLEANUP_PENDING' });
  const callsBeforeRetry = h.calls.length;
  await assert.rejects(h.browser.call(input, { action: 'click', ref: 'button' }, signal()), { code: 'RUNTIME_CLEANUP_PENDING' });
  await assert.rejects(h.browser.call(input, { action: 'status' }, signal()), { code: 'RUNTIME_CLEANUP_PENDING' });
  assert.equal(h.calls.length, callsBeforeRetry);
  removalFails = false;
  assert.deepEqual(await h.browser.call(input, { action: 'close' }, signal()), { closed: true });
  assert.equal(h.browser.available, true);
});

test('browser environment activation requires a Docker immutable image and rejects mutable or Kubernetes settings', () => {
  assert.equal(runtimeConfig({}).browserImage, undefined);
  assert.equal(runtimeConfig({ AGENT_BROWSER_IMAGE: image }).browserImage, image);
  for (const env of [{ AGENT_BROWSER_IMAGE: 'browser:latest' }, { AGENT_BROWSER_IMAGE: 'browser:v1' },
    { AGENT_BROWSER_IMAGE: `sha256:${'a'.repeat(63)}` }, { AGENT_BROWSER_IMAGE: `sha256:${'A'.repeat(64)}` },
    { AGENT_BROWSER_IMAGE: `${image}\n` }, { AGENT_RUNTIME: 'kubernetes', AGENT_BROWSER_IMAGE: image }]) {
    assert.throws(() => runtimeConfig(env), /Docker의 검증된 불변 이미지/);
  }
  assert.equal(new ContainerRuntime({ ...runtimeConfig({}), browserImage: undefined }).browserEnabled, false);
});

test('browser uses its fixed profile while Codex retains its original profile for native and explicit WSL execution', async () => {
  for (const wslDistro of [undefined, 'Ubuntu-22.04']) {
    const calls: Call[] = [];
    const runner: Command = async (file, args, options = {}) => {
      calls.push({ file, args, options });
      if (wslDistro) {
        assert.equal(file, 'wsl.exe'); assert.deepEqual(args.slice(0, 3), ['--distribution', wslDistro, '--exec']);
        if (args[3] === 'wslpath') {
          assert.equal(args[4], '-a');
          const profile = args[5].endsWith('browser-userns.json') ? 'browser-userns.json' : 'codex-userns.json';
          return { code: 0, stdout: `/mnt/c/verified/worker/security/${profile}\n`, stderr: '' };
        }
        assert.equal(args[3], 'docker');
      } else assert.equal(file, 'docker');
      const dockerArgs = wslDistro ? args.slice(4) : args;
      if (dockerArgs[0] === 'version') return { code: 0, stdout: dockerArgs.at(-1)!.includes('Arch') ? '29.1.3/amd64' : '29.1.3', stderr: '' };
      if (dockerArgs[0] === 'image') return { code: 0, stdout: image, stderr: '' };
      if (dockerArgs[0] === 'ps' || dockerArgs[0] === 'volume') return { code: 0, stdout: '', stderr: '' };
      if (dockerArgs[0] === 'run' && !dockerArgs.includes('--detach')) {
        await options.onLine?.(JSON.stringify({ type: 'result', result: {
          result: 'fixture inspected', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0,
        } }));
        return { code: 0, stdout: '', stderr: '' };
      }
      return success();
    };
    const runtime: RuntimeConfig = { mode: 'docker', auth: 'api-key', apiKey: 'fixture-not-a-secret', authFile: '', image: 'worker:fixture',
      model: 'fixture', timeoutMs: 10_000, browserImage: image, workspaceKey: config.workspaceKey, dockerSandbox: 'codex-userns',
      seccompProfile: '/must-not-be-used-for-the-browser.json', wslDistro };
    const driver = new ContainerRuntime(runtime, runner);
    await driver.execute(input, { signal: signal(), onEvent: async () => {}, getSteering: async () => [] });
    await driver.callBrowser(input, open, signal()); await driver.settle(input.run.id);
    await driver.callBrowser(otherInput, open, signal()); await driver.settle(otherInput.run.id);
    const dockerCalls = calls.filter(call => !wslDistro || call.args[3] === 'docker')
      .map(call => ({ ...call, args: wslDistro ? call.args.slice(4) : call.args }));
    const worker = dockerCalls.find(call => call.args[0] === 'run' && !call.args.includes('--detach'))!;
    const browsers = dockerCalls.filter(call => call.args[0] === 'run' && call.args.includes('--detach'));
    assert.equal(browsers.length, 2);
    const workerProfile = worker.args.find(arg => arg.startsWith('--security-opt=seccomp='))!;
    assert.match(workerProfile, /[\\/]worker[\\/]security[\\/]codex-userns\.json$/);
    for (const browser of browsers) {
      const browserProfile = browser.args.find(arg => arg.startsWith('--security-opt=seccomp='))!;
      assert.match(browserProfile, /[\\/]worker[\\/]security[\\/]browser-userns\.json$/);
      assert.doesNotMatch(browserProfile, /codex-userns|must-not-be-used/);
      assert.ok(browser.args.includes('--network=none')); assert.ok(browser.args.includes('--user=1000:1000'));
    }
    assert.doesNotMatch(workerProfile, /browser-userns/);
    assert.equal(dockerCalls.filter(call => call.args[0] === 'version' && call.args.at(-1)!.includes('Arch')).length, 2);
    if (wslDistro) assert.deepEqual(calls.filter(call => call.args[3] === 'wslpath').map(call => call.args[5].split(/[\\/]/).at(-1)),
      ['codex-userns.json', 'browser-userns.json']);
    assert.equal(runtime.seccompProfile, '/must-not-be-used-for-the-browser.json');
  }
});

test('unsupported browser engines or failed engine inspection cannot start containers and rejected config is retried later', async () => {
  for (const firstResponse of [{ code: 0, stdout: '29.1.2/amd64', stderr: '' }, { code: 0, stdout: '29.1.3/arm64', stderr: '' },
    { code: 0, stdout: '30.0.0/amd64', stderr: '' }, { code: 1, stdout: '', stderr: 'engine unavailable' }]) {
    let rejectEngine = true;
    const h = harness(call => call.args[0] === 'version' ? rejectEngine ? firstResponse : { code: 0, stdout: '29.1.3/amd64', stderr: '' } : undefined);
    const runtime: RuntimeConfig = { mode: 'docker', auth: 'none', authFile: '', image: 'worker:fixture', model: 'fixture', timeoutMs: 1000,
      browserImage: image, workspaceKey: config.workspaceKey };
    const driver = new ContainerRuntime(runtime, h.command);
    await assert.rejects(driver.callBrowser(input, open, signal()), /재검증/);
    assert.equal(callsOf(h.calls, 'run').length, 0); assert.equal(callsOf(h.calls, 'exec').length, 0);
    assert.equal(driver.browserAvailable, true);
    rejectEngine = false;
    await driver.callBrowser(input, open, signal()); await driver.settle(input.run.id);
    assert.equal(callsOf(h.calls, 'version').length, 2); assert.equal(callsOf(h.calls, 'run').length, 1);
  }
});

test('WSL browser profile mapping must succeed with an absolute path and failed mapping is not cached', async () => {
  for (const failure of [{ code: 1, stdout: '', stderr: 'wslpath failed' }, { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: 'relative/browser-userns.json', stderr: '' }]) {
    let rejectMapping = true;
    const calls: Call[] = [];
    const runner: Command = async (file, args, options = {}) => {
      calls.push({ file, args, options }); assert.equal(file, 'wsl.exe');
      assert.deepEqual(args.slice(0, 3), ['--distribution', 'Ubuntu-22.04', '--exec']);
      if (args[3] === 'wslpath') {
        assert.equal(args[4], '-a'); assert.match(args[5], /browser-userns\.json$/);
        return rejectMapping ? failure : { code: 0, stdout: '/mnt/c/verified/browser-userns.json\n', stderr: '' };
      }
      assert.equal(args[3], 'docker');
      if (args[4] === 'version') return { code: 0, stdout: '29.1.3/amd64', stderr: '' };
      return success();
    };
    const runtime: RuntimeConfig = { mode: 'docker', auth: 'none', authFile: '', image: 'worker:fixture', model: 'fixture', timeoutMs: 1000,
      browserImage: image, workspaceKey: config.workspaceKey, wslDistro: 'Ubuntu-22.04' };
    const driver = new ContainerRuntime(runtime, runner);
    await assert.rejects(driver.callBrowser(input, open, signal()), /WSL 브라우저 전용 프로필 경로/);
    assert.equal(calls.filter(call => call.args[4] === 'run').length, 0);
    assert.equal(calls.filter(call => call.args[4] === 'exec').length, 0); assert.equal(driver.browserAvailable, true);
    rejectMapping = false;
    await driver.callBrowser(input, open, signal()); await driver.settle(input.run.id);
    assert.equal(calls.filter(call => call.args[3] === 'wslpath').length, 2);
    const started = calls.find(call => call.args[4] === 'run')!;
    assert.ok(started.args.includes('--security-opt=seccomp=/mnt/c/verified/browser-userns.json'));
  }
});
