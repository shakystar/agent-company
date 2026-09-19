import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerWorkspaces } from '../server/workspaces.ts';
import type { Command } from '../server/process.ts';

const config = { mode: 'docker' as const, image: 'test-worker', workspaceKey: 'inventory-race-test', persistentWorkspaces: true };
const volume = (id: string) => `ac-${createHash('sha256').update(config.workspaceKey).digest('hex').slice(0, 16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const labels = (id: string) => ({ app: 'agent-company', 'agent-company.workspace': config.workspaceKey, 'agent-company.run': id });
function inspectVolumes(owned: ReadonlyMap<string, Record<string, string>>, args: string[]) {
  const names = args.slice(2, args.indexOf('--format'));
  const ids = names.map(name => [...owned.keys()].find(id => volume(id) === name));
  return { code: ids.every(Boolean) ? 0 : 1,
    stdout: ids.flatMap((id, index) => id ? [JSON.stringify(args.includes('{{json .}}') ? { Name: names[index], Labels: owned.get(id) } : owned.get(id))] : []).join('\n'),
    stderr: ids.every(Boolean) ? '' : 'No such volume' };
}

test('inventory and trial removal share one generation lock across separate workspace instances', async () => {
  const owned = new Map([['source', labels('source')], ['trial', labels('trial')]]);
  let release!: () => void, listed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const listing = new Promise<void>(resolve => { listed = resolve; });
  const calls: string[][] = [];
  const runner: Command = async (_file, args, options = {}) => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'ls') {
      const stdout = [...owned.keys()].map(volume).join('\n'); listed(); await gate;
      return { code: 0, stdout, stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return inspectVolumes(owned, args);
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      owned.delete('trial'); return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'run') await options.onStdout?.(Buffer.from('{"bytes":10,"files":1}'));
    return { code: 0, stdout: '', stderr: '' };
  };
  const monitoring = new DockerWorkspaces(config, runner, volume);
  const executing = new DockerWorkspaces(config, runner, volume);
  const scan = monitoring.volumes(); await listing;
  const removal = executing.remove('trial');
  const complete = Promise.allSettled([scan, removal]);
  await delay(10);
  const retainedDuringScan = owned.has('trial');
  release();
  const [measured, removed] = await complete;
  assert.equal(retainedDuringScan, true, 'Do not remove a volume named by an in-flight inventory');
  assert.equal(measured.status, 'fulfilled'); assert.equal(removed.status, 'fulfilled');
  if (measured.status === 'fulfilled') assert.deepEqual(measured.value, [{ runId: 'source', bytes: 10, files: 1 }, { runId: 'trial', bytes: 10, files: 1 }]);
  assert.ok(owned.has('source')); assert.equal(owned.has('trial'), false);
  assert.equal(calls.some(args => args[0] === 'volume' && args[1] === 'create'), false);
});

test('inventory skips only explicitly disappeared list entries and rejects engine or ownership failures', async () => {
  for (const scenario of ['missing', 'engine', 'foreign']) {
    let mounts = 0;
    const runner: Command = async (_file, args) => {
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: volume('trial'), stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return scenario === 'foreign'
        ? { code: 0, stdout: JSON.stringify({ Name: volume('trial'), Labels: { ...labels('trial'), 'agent-company.workspace': 'foreign-generation' } }), stderr: '' }
        : { code: 1, stdout: '', stderr: scenario === 'missing' ? `Error response from daemon: No such volume: ${volume('trial')}` : 'Cannot connect to the Docker daemon' };
      if (args[0] === 'run') mounts++;
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    const manager = new DockerWorkspaces(config, runner, volume);
    if (scenario === 'missing') assert.deepEqual(await manager.volumes(), []);
    else await assert.rejects(manager.volumes());
    assert.equal(mounts, 0, 'Never mount an absent or wrong-owned volume');
  }
});

function mountedHelperFixture(heldOperation: string, cleanupFailure = false, holdCleanup = false) {
  const owned = new Map([['source', labels('source')]]);
  const mounted = new Map<string, { volumes: string[]; operation: string }>();
  const events: string[] = [];
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let held = false, externalActive = false;
  const runner: Command = async (_file, args, options = {}) => {
    if (args[0] === 'volume' && args[1] === 'ls') {
      events.push('inventory:list');
      return { code: 0, stdout: [...owned.keys()].map(volume).join('\n'), stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      events.push('owned');
      return inspectVolumes(owned, args);
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const id = args.find(arg => arg.startsWith('agent-company.run='))!.split('=')[1];
      owned.set(id, labels(id)); events.push(`create:${id}`);
      return { code: 0, stdout: volume(id), stderr: '' };
    }
    if (args[0] === 'ps') {
      events.push('idle');
      const target = args.at(-1)!.slice('volume='.length);
      const active = [...mounted].filter(([, helper]) => helper.volumes.includes(target)).map(([name]) => name);
      return { code: 0, stdout: externalActive ? 'unrelated-active-container' : active.join('\n'), stderr: '' };
    }
    if (args[0] === 'run') {
      let input = options.input ?? '';
      if (options.inputStream) for await (const chunk of options.inputStream) input += Buffer.from(chunk).toString();
      const request = JSON.parse(input.split('\n')[0]) as { operation: string; runId?: string; sourceRunId?: string | null; path?: string; files?: { contentBase64: string }[] };
      const name = args[args.indexOf('--name') + 1];
      const mounts = args.filter((_, index) => args[index - 1] === '--mount').map(arg => /source=([^,]+)/.exec(arg)![1]);
      mounted.set(name, { volumes: mounts, operation: request.operation });
      events.push(`start:${request.operation}`);
      if (!holdCleanup && request.operation === heldOperation && !held) { held = true; started(); await gate; }
      const runId = args.find(arg => arg.startsWith('agent-company.run='))!.split('=')[1];
      let value: unknown;
      switch (request.operation) {
        case 'measure': value = { bytes: 5, files: 1 }; break;
        case 'download': value = { path: request.path, bytes: 5, contentBase64: Buffer.from('proof').toString('base64') }; break;
        case 'read': value = { path: request.path, bytes: 5, text: 'proof' }; break;
        case 'list': value = { path: request.path, entries: [{ name: 'proof.txt', path: 'proof.txt', type: 'file', size: 5 }], truncated: false }; break;
        case 'prepare': value = { version: 1, state: 'ready', runId, sourceRunId: request.sourceRunId ?? null, files: request.sourceRunId ? 1 : 0, bytes: request.sourceRunId ? 5 : 0, reused: false }; break;
        case 'write': value = { files: request.files!.length, bytes: request.files!.reduce((sum, file) => sum + Buffer.from(file.contentBase64, 'base64').length, 0) }; break;
        case 'import': value = { version: 1, state: 'ready', ready: true, runId, sourceRunId: null, files: 1, bytes: 5, reused: false }; break;
        case 'export':
          await options.onStdout?.(Buffer.from('archive'));
          return { code: 0, stdout: '', stderr: JSON.stringify({ type: 'end', files: 1, contentBytes: 5 }) };
        default: throw new Error(`Unexpected helper operation: ${request.operation}`);
      }
      const stdout = JSON.stringify(value);
      await options.onStdout?.(Buffer.from(stdout));
      return { code: 0, stdout, stderr: '' };
    }
    if (args[0] === 'rm') {
      const helper = mounted.get(args[2]);
      if (holdCleanup && helper?.operation === heldOperation && !held) { held = true; started(); await gate; }
      if (cleanupFailure && helper?.operation === heldOperation) return { code: 1, stdout: '', stderr: 'daemon cleanup failure' };
      events.push(`cleanup:${helper?.operation}`); mounted.delete(args[2]);
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  return {
    monitoring: new DockerWorkspaces(config, runner, volume), executing: new DockerWorkspaces(config, runner, volume),
    entered, release, events, mounted, owned, setExternalActive: () => { externalActive = true; },
  };
}

test('mounted inventory completes cleanup before another instance can access or inherit a workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ac-inventory-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  const archive = join(root, 'source.archive'); await writeFile(archive, 'fixture archive');
  for (const operation of ['download', 'read', 'list', 'prepare', 'importFiles', 'export', 'import']) {
    await t.test(operation, { timeout: 5000 }, async () => {
      const fixture = mountedHelperFixture('measure');
      const scan = fixture.monitoring.volumes(); await fixture.entered;
      const actions: Record<string, () => Promise<unknown>> = {
        download: () => fixture.executing.download('source', 'proof.txt'),
        read: () => fixture.executing.read('source', 'proof.txt'),
        list: () => fixture.executing.list('source'),
        prepare: () => fixture.executing.prepare('copy', 'source'),
        importFiles: () => fixture.executing.importFiles('copy', 'source', [{ path: 'added.txt', contentBase64: Buffer.from('new').toString('base64') }]),
        export: () => fixture.executing.export('source', join(root, 'export.archive')),
        import: () => fixture.executing.import('copy', archive),
      };
      const observed = fixture.events.length;
      const completed = Promise.allSettled([scan, actions[operation]()]);
      await delay(10);
      const whileMounted = fixture.events.slice(observed);
      fixture.release();
      const results = await completed;
      assert.deepEqual(whileMounted, [], 'An inventory helper mount must not race an idle check or volume mutation');
      for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined);
      assert.equal(fixture.mounted.size, 0);
      if (operation === 'importFiles') assert.ok(fixture.events.includes('start:write'), 'Preparing an import inside the lock must not deadlock');
    });
  }
});

test('inventory waits until an existing file read helper has been cleaned up', { timeout: 5000 }, async () => {
  const fixture = mountedHelperFixture('read');
  const reading = fixture.executing.read('source', 'proof.txt'); await fixture.entered;
  const observed = fixture.events.length;
  const completed = Promise.allSettled([reading, fixture.monitoring.volumes()]);
  await delay(10);
  const whileMounted = fixture.events.slice(observed);
  fixture.release();
  const results = await completed;
  assert.deepEqual(whileMounted, []);
  for (const result of results) assert.equal(result.status, 'fulfilled');
  assert.ok(fixture.events.indexOf('cleanup:read') < fixture.events.indexOf('inventory:list'));
});

test('inventory coordination never bypasses an unrelated active container or a failed helper cleanup', { timeout: 5000 }, async () => {
  for (const cleanupFailure of [false, true]) {
    const fixture = mountedHelperFixture('measure', cleanupFailure);
    const scan = fixture.monitoring.volumes(); await fixture.entered;
    if (!cleanupFailure) fixture.setExternalActive();
    const completed = Promise.allSettled([scan, fixture.executing.download('source', 'proof.txt')]);
    fixture.release();
    const [measured, downloaded] = await completed;
    assert.equal(measured.status, cleanupFailure ? 'rejected' : 'fulfilled');
    assert.equal(downloaded.status, 'rejected');
    assert.equal(fixture.events.includes('start:download'), false);
  }
});

test('a completed measurement retains the lock until container cleanup finishes', { timeout: 5000 }, async () => {
  const fixture = mountedHelperFixture('measure', false, true);
  const scan = fixture.monitoring.volumes(); await fixture.entered;
  const observed = fixture.events.length;
  const completed = Promise.allSettled([scan, fixture.executing.download('source', 'proof.txt')]);
  await delay(10);
  const whileMounted = fixture.events.slice(observed);
  fixture.release();
  const results = await completed;
  assert.deepEqual(whileMounted, []);
  for (const result of results) assert.equal(result.status, 'fulfilled');
  assert.ok(fixture.events.indexOf('cleanup:measure') < fixture.events.indexOf('idle'));
});

test('queued cancelled mutations stop before inspecting or creating workspace or archive data', { timeout: 5000 }, async () => {
  const fixture = mountedHelperFixture('measure');
  const scan = fixture.monitoring.volumes(); await fixture.entered;
  const controller = new AbortController();
  const archive = join(tmpdir(), `ac-inventory-aborted-${randomUUID()}.archive`);
  const observed = fixture.events.length;
  const mutations = [
    fixture.executing.prepare('copy', 'source', controller.signal),
    fixture.executing.importFiles('files', 'source', [{ path: 'added.txt', contentBase64: '' }], controller.signal),
    fixture.executing.import('restored', archive, 1024, controller.signal),
    fixture.executing.export('source', archive, 1024, controller.signal),
  ];
  const completed = Promise.allSettled([scan, ...mutations]);
  controller.abort(new Error('Cancelled while awaiting inventory'));
  fixture.release();
  const [measured, ...results] = await completed;
  assert.equal(measured.status, 'fulfilled');
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, controller.signal.reason);
  }
  assert.deepEqual(fixture.events.slice(observed), ['cleanup:measure']);
  assert.deepEqual([...fixture.owned.keys()], ['source']);
  await assert.rejects(lstat(archive), { code: 'ENOENT' });
});

test('inventory locks do not serialize independent workspace generations', { timeout: 5000 }, async () => {
  const fixture = mountedHelperFixture('measure');
  const scan = fixture.monitoring.volumes(); await fixture.entered;
  const workspaceKey = 'independent-inventory-generation';
  let otherListed = false;
  const runner: Command = async (_file, args) => {
    assert.deepEqual(args.slice(0, 2), ['volume', 'ls']); otherListed = true;
    return { code: 0, stdout: '', stderr: '' };
  };
  const independent = new DockerWorkspaces({ ...config, workspaceKey }, runner,
    id => `ac-${createHash('sha256').update(workspaceKey).digest('hex').slice(0, 16)}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`);
  const completed = Promise.allSettled([scan, independent.volumes()]);
  await delay(10);
  const progressed = otherListed;
  fixture.release();
  const results = await completed;
  assert.equal(progressed, true);
  for (const result of results) assert.equal(result.status, 'fulfilled');
});
