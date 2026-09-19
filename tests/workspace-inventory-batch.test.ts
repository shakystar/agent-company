import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerWorkspaces } from '../server/workspaces.ts';
import type { Command, CommandOptions, CommandResult } from '../server/process.ts';

const config = { mode: 'docker' as const, image: 'unchanged-worker', workspaceKey: 'inventory-metadata-batch', persistentWorkspaces: true };
const volume = (id: string) => `ac-${createHash('sha256').update(config.workspaceKey).digest('hex').slice(0, 16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const metadata = (id: string) => ({ Name: volume(id), Labels: { app: 'agent-company', 'agent-company.workspace': config.workspaceKey, 'agent-company.run': id } });
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(count: number, inspect?: (names: string[], rows: ReturnType<typeof metadata>[]) => CommandResult) {
  const ids = Array.from({ length: count }, (_, index) => `run-${index}`), records = new Map(ids.map(id => [volume(id), metadata(id)]));
  const calls: Array<{ args: string[]; options: CommandOptions }> = [];
  let activeHelpers = 0, peakHelpers = 0;
  const command: Command = async (_file, args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'volume' && args[1] === 'ls') return ok([...records.keys()].join('\n'));
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const names = args.slice(2, args.indexOf('--format'));
      assert.equal(args.at(-1), '{{json .}}');
      const rows = names.map(name => records.get(name)!);
      return inspect ? inspect(names, rows) : ok(rows.map(row => JSON.stringify(row)).join('\n'));
    }
    if (args[0] === 'run') {
      peakHelpers = Math.max(peakHelpers, ++activeHelpers);
      await delay(0);
      await options.onStdout?.(Buffer.from('{"bytes":7,"files":2}'));
      return ok();
    }
    if (args[0] === 'rm') { activeHelpers--; return ok(); }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  return { ids, records, calls, command, manager: new DockerWorkspaces(config, command, volume), peakHelpers: () => peakHelpers };
}

test('inventory batches metadata at 64 names while measuring every volume with sequential unchanged helpers', async () => {
  const h = fixture(129), measured = await h.manager.volumes();
  assert.deepEqual(measured, h.ids.map(runId => ({ runId, bytes: 7, files: 2 })));
  const metadataCalls = h.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'inspect');
  assert.deepEqual(metadataCalls.map(call => call.args.indexOf('--format') - 2), [64, 64, 1]);
  const helpers = h.calls.filter(call => call.args[0] === 'run');
  assert.equal(helpers.length, 129); assert.equal(h.peakHelpers(), 1);
  for (const helper of helpers) {
    assert.ok(helper.args.includes('--memory=256m') && helper.args.includes('--cpus=0.5'));
    assert.ok(helper.args.includes('--read-only') && helper.args.includes('--network=none') && helper.args.includes('--cap-drop=ALL'));
    assert.ok(helper.args.some(arg => arg.endsWith('target=/workspace,readonly,volume-nocopy')));
    assert.deepEqual(JSON.parse(helper.options.input!), { operation: 'measure' });
    assert.equal(helper.options.timeoutMs, 120_000); assert.equal(helper.options.signal, h.calls[0].options.signal);
  }
});

test('batch metadata is bound by exact Name rather than Docker response order', async () => {
  const h = fixture(3, (_names, rows) => ok(rows.toReversed().map(row => JSON.stringify(row)).join('\n')));
  assert.deepEqual((await h.manager.volumes()).map(item => item.runId), h.ids);
});

test('missing, duplicate, unknown, malformed and wrong-owned successful metadata fail before mounting', async () => {
  for (const scenario of ['missing', 'duplicate', 'unknown', 'foreign', 'wrong-run', 'labels-only', 'malformed'] as const) {
    const h = fixture(2, (_names, rows) => {
      if (scenario === 'missing') rows.pop();
      if (scenario === 'duplicate') rows[1] = rows[0];
      if (scenario === 'unknown') rows[1] = metadata('unexpected');
      if (scenario === 'foreign') rows[1].Labels['agent-company.workspace'] = 'foreign';
      if (scenario === 'wrong-run') rows[1].Labels['agent-company.run'] = 'wrong';
      if (scenario === 'labels-only') return ok(JSON.stringify(rows[0].Labels));
      if (scenario === 'malformed') return ok('{broken');
      return ok(rows.map(row => JSON.stringify(row)).join('\n'));
    });
    await assert.rejects(h.manager.volumes(), scenario);
    assert.equal(h.calls.some(call => call.args[0] === 'run'), false, scenario);
  }
});

test('a failed batch revalidates each name and skips only its explicitly disappeared member', async () => {
  const h = fixture(3, (names, rows) => {
    if (names.length > 1) return { code: 1, stdout: JSON.stringify(rows[0]), stderr: `Error response from daemon: get ${volume('run-1')}: no such volume` };
    if (names[0] === volume('run-1')) return { code: 1, stdout: '', stderr: `Error response from daemon: get ${names[0]}: no such volume` };
    return ok(JSON.stringify(rows[0]));
  });
  assert.deepEqual((await h.manager.volumes()).map(item => item.runId), ['run-0', 'run-2']);
  assert.deepEqual(h.calls.filter(call => call.args[1] === 'inspect').map(call => call.args.indexOf('--format') - 2), [3, 1, 1, 1]);
});

test('daemon outages and errors naming another missing volume are never accepted as disappearance', async () => {
  for (const stderr of ['Cannot connect to the Docker daemon', `Error: No such volume: ${volume('other')}`, `No such volume\npermission denied`]) {
    const h = fixture(1, () => ({ code: 1, stdout: '', stderr }));
    await assert.rejects(h.manager.volumes()); assert.equal(h.calls.some(call => call.args[0] === 'run'), false);
  }
});

test('the existing overall 120 second signal still stops inventory before another helper starts', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 120_000); return controller.signal; });
  const h = fixture(2, (_names, rows) => { controller.abort(); return ok(rows.map(row => JSON.stringify(row)).join('\n')); });
  await assert.rejects(h.manager.volumes(), { name: 'AbortError' });
  assert.equal(h.calls.some(call => call.args[0] === 'run'), false);
});

test('a cancelled queued inventory rejects promptly, skips its turn and preserves prior and subsequent serialization', async () => {
  const h = fixture(1), controller = new AbortController(), reason = new Error('deployment preparing');
  const priorStarted = deferred(), priorRelease = deferred();
  let priorFinished = false, subsequentEntered = false;
  const prior = h.manager.withInventoryLock(async () => {
    priorStarted.resolve(); await priorRelease.promise; priorFinished = true;
  });
  await priorStarted.promise;
  const cancelled = h.manager.volumes(controller.signal);
  const rejected = assert.rejects(cancelled, error => error === reason);
  const subsequent = h.manager.withInventoryLock(async () => { subsequentEntered = true; assert.equal(priorFinished, true); });
  controller.abort(reason);
  await rejected;
  assert.equal(priorFinished, false); assert.equal(subsequentEntered, false); assert.equal(h.calls.length, 0);
  priorRelease.resolve();
  await Promise.all([prior, subsequent]);
  assert.equal(h.calls.length, 0, 'cancelled queued inventory never executes even after the prior operation finishes');
  assert.deepEqual((await h.manager.volumes()).map(item => item.runId), h.ids);
});

test('an already cancelled inventory never enters the workspace queue or starts a command', async () => {
  const h = fixture(1), controller = new AbortController(); controller.abort();
  await assert.rejects(h.manager.volumes(controller.signal), { name: 'AbortError' });
  assert.equal(h.calls.length, 0);
  assert.equal((await h.manager.volumes()).length, 1);
});

test('active inventory cancellation waits for helper cleanup before settling caller or admitting the next operation', async () => {
  const controller = new AbortController(), reason = new Error('deployment preparing');
  const helperStarted = deferred(), cleanupStarted = deferred(), cleanupRelease = deferred();
  let callerSettled = false, nextEntered = false, cleanupFinished = false, helperSignal: AbortSignal | undefined;
  const command: Command = async (_file, args, options = {}) => {
    if (args[0] === 'volume' && args[1] === 'ls') return ok(volume('active'));
    if (args[0] === 'volume' && args[1] === 'inspect') return ok(JSON.stringify(metadata('active')));
    if (args[0] === 'run') {
      helperSignal = options.signal;
      assert.ok(helperSignal); assert.notEqual(helperSignal, controller.signal);
      helperStarted.resolve();
      await new Promise<void>((_resolve, reject) => helperSignal!.addEventListener('abort', () => reject(helperSignal!.reason), { once: true }));
    }
    if (args[0] === 'rm') {
      assert.equal(options.signal, undefined, 'cleanup is not cancelled with the inventory');
      cleanupStarted.resolve(); await cleanupRelease.promise; cleanupFinished = true; return ok();
    }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const manager = new DockerWorkspaces(config, command, volume);
  const inventory = manager.volumes(controller.signal);
  const rejected = assert.rejects(inventory, error => error === reason).then(() => { callerSettled = true; });
  await helperStarted.promise;
  const next = manager.withInventoryLock(async () => { nextEntered = true; assert.equal(cleanupFinished, true); });
  controller.abort(reason);
  await cleanupStarted.promise; await delay(0);
  assert.equal(helperSignal!.aborted, true); assert.equal(callerSettled, false); assert.equal(nextEntered, false);
  cleanupRelease.resolve();
  await Promise.all([rejected, next]);
  assert.equal(callerSettled, true); assert.equal(nextEntered, true); assert.equal(cleanupFinished, true);
});
