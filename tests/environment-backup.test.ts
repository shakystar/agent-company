import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { EnvironmentBuildReport, EnvironmentRevision, EnvironmentSelection } from '../shared/environment.ts';
import type { Agent, ExecutionResult } from '../shared/types.ts';
import { StorageManager, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore, type PersistedExecution } from '../server/store.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const timestamp = '2026-09-06T00:00:00.000Z';
const owner = (): Agent => ({ id: randomUUID(), name: 'Environment backup owner', description: '', persona: 'Preserve verified environments', color: '#000000',
  model: 'fixture-model', status: 'idle', generation: 0, parentId: null, parentSnapshotId: null, version: 1,
  allowWeb: false, repositoryIds: [], createdAt: timestamp, updatedAt: timestamp });
const report = (): EnvironmentBuildReport => ({ imageId: `sha256:${'a'.repeat(64)}`, contentHash: 'b'.repeat(64), lockfileHash: 'c'.repeat(64),
  packages: [], tools: [], checks: [{ name: 'explicit-fixture', passed: true, detail: 'No Docker or model' }], createdAt: timestamp });
const revision = (agentId: string = randomUUID()): EnvironmentRevision => ({ id: randomUUID(), agentId, baseRevisionId: null, sourceRunId: null,
  buildRunId: randomUUID(), reason: 'Retained verified fixture', spec: { packages: [], servers: [] }, requestedAccess: [], status: 'ready',
  report: report(), error: null, createdAt: timestamp, completedAt: timestamp });
const selection = (value: EnvironmentRevision): EnvironmentSelection => ({ revisionId: value.id, buildRunId: value.buildRunId!, spec: value.spec, report: value.report! });
const savedInput = (agent: Agent): PersistedExecution => ({ input: { agent, memories: [], skills: [], connections: [] }, inputTokens: 0, outputTokens: 0 });
const completeResult = (): ExecutionResult => ({ result: 'Build is complete before state activation', memories: [], skills: [], artifacts: [],
  inputTokens: 0, outputTokens: 0, environmentBuild: report() });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-environment-backup-'));
  const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: randomUUID(), freeSpace: async () => 100 * 1024 ** 3 };
  const store = await WorkspaceStore.open(), stores = new Set([store]);
  const runtime = new StorageFixtureRuntime(config.ownerKey);
  const manager = new StorageManager(config, () => ({ store, runtime, dataDir: config.rootDir }));
  await manager.initialize();
  t.after(async () => {
    for (const stored of stores) await stored.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /ac-environment-backup-[^\\/]+$/);
    const entry = await lstat(directory); assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    await rm(directory, { recursive: true });
  });
  const addBundle = (runId: string) => runtime.spaces.get(config.ownerKey)!.set(runId, {
    'environment/.complete.json': Buffer.from(JSON.stringify({ version: 1, contentHash: 'b'.repeat(64), lockfileHash: 'c'.repeat(64) })).toString('base64'),
    'environment/package-lock.json': Buffer.from('{"lockfileVersion":3,"packages":{}}').toString('base64'),
  });
  return { directory, config, store, stores, runtime, manager, addBundle };
}

test('a missing ready environment bundle rejects backup before publishing or rotating existing backups', async t => {
  const f = await fixture(t), agent = owner();
  await f.store.change(state => { state.agents.push(agent); });
  for (let index = 0; index < 3; index++) await f.manager.backup();
  const before = (await readdir(f.manager.backupRoot)).sort();
  const ready = revision(agent.id);
  await f.store.change(state => { state.environmentRevisions.push(ready); state.agents[0].environmentRevisionId = ready.id; });
  await assert.rejects(f.manager.backup(), /개인 환경.*번들.*없습니다/);
  assert.deepEqual((await readdir(f.manager.backupRoot)).sort(), before);
  assert.equal((await f.store.read()).agents[0].environmentRevisionId, ready.id);
  assert.deepEqual(await readdir(f.manager.temporary), []);
});

test('ready history shared by independent fork manifests survives backup and separate restore', async t => {
  const f = await fixture(t), agent = owner(), clone = owner(), ready = revision(agent.id);
  const forked = { ...structuredClone(ready), id: randomUUID(), agentId: clone.id, sourceRevisionId: ready.id };
  agent.environmentRevisionId = ready.id; clone.environmentRevisionId = forked.id;
  f.addBundle(ready.buildRunId!);
  const taskId = randomUUID(), execution = savedInput(agent); execution.input.environment = selection(ready);
  await f.store.change(state => { state.agents.push(agent, clone); state.environmentRevisions.push(ready, forked); state.executionStates[taskId] = execution; });
  const before = await f.store.read(), backup = await f.manager.backup();
  const prepared = await f.manager.prepareRestore(backup.id), restored = await f.manager.activate(prepared.id); f.stores.add(restored.store);
  const after = await restored.store.read();
  assert.deepEqual(after.environmentRevisions, before.environmentRevisions);
  assert.deepEqual(after.executionStates, before.executionStates); assert.equal(after.operatorPaused, true);
  assert.notEqual(restored.runtime, f.runtime);
  assert.equal((await restored.runtime.listWorkspaceVolumes!()).filter(item => item.runId === ready.buildRunId).length, 1);
  assert.deepEqual(await restored.runtime.downloadWorkspaceFile!(ready.buildRunId!, 'environment/.complete.json'),
    await f.runtime.downloadWorkspaceFile(ready.buildRunId!, 'environment/.complete.json'));
  assert.deepEqual(await f.store.read(), before);
});

test('an unselected ready revision still requires its retained bundle for future selection', async t => {
  const f = await fixture(t), ready = revision();
  await f.store.change(state => { state.environmentRevisions.push(ready); });
  await assert.rejects(f.manager.backup(), /개인 환경.*번들.*없습니다/);
  f.addBundle(ready.buildRunId!);
  assert.equal((await f.manager.backup()).verified, true);
});

test('a frozen execution environment requires its bundle independently of current agent and revision state', async t => {
  const f = await fixture(t), ready = revision(), execution = savedInput(owner()), taskId = randomUUID();
  execution.input.environment = selection(ready);
  await f.store.change(state => { state.executionStates[taskId] = execution; });
  await assert.rejects(f.manager.backup(), /개인 환경.*번들.*없습니다/);
  f.addBundle(ready.buildRunId!);
  assert.equal((await f.manager.backup()).verified, true);
});

test('a completed build checkpoint requires its own bundle before the ready revision is committed', async t => {
  const f = await fixture(t), pending = revision(), execution = savedInput(owner()), buildId = pending.buildRunId!;
  pending.status = 'building'; pending.report = undefined; pending.completedAt = null;
  execution.input.environmentBuild = { revisionId: pending.id, spec: pending.spec };
  execution.checkpoint = { phase: 'complete', previousResult: completeResult() };
  await f.store.change(state => { state.environmentRevisions.push(pending); state.executionStates[buildId] = execution; });
  await assert.rejects(f.manager.backup(), /개인 환경.*번들.*없습니다/);
  f.addBundle(buildId);
  assert.equal((await f.manager.backup()).verified, true);
});

test('queued, blocked, failed and cancelled incomplete builds do not require nonexistent volumes', async t => {
  const f = await fixture(t);
  await f.store.change(state => {
    for (const status of ['queued', 'building', 'blocked', 'failed', 'cancelled'] as const) {
      const pending = revision(); pending.status = status; pending.report = undefined; pending.completedAt = null;
      if (status === 'queued' || status === 'blocked') pending.buildRunId = null;
      state.environmentRevisions.push(pending);
      if (pending.buildRunId) {
        const execution = savedInput(owner()); execution.input.environmentBuild = { revisionId: pending.id, spec: pending.spec };
        state.executionStates[pending.buildRunId] = execution;
      }
    }
  });
  assert.equal((await f.manager.backup()).verified, true);
  assert.equal(f.runtime.spaces.get(f.config.ownerKey)!.size, 0);
});

test('ready revisions with null or non-UUID bundle identities cannot publish a verified backup', async t => {
  const f = await fixture(t), ready = revision();
  for (const invalid of [null, 'external-volume']) {
    await f.store.change(state => { state.environmentRevisions = [{ ...ready, buildRunId: invalid }]; });
    await assert.rejects(f.manager.backup(), /개인 환경.*번들.*없습니다/);
  }
  assert.deepEqual(await f.manager.backups(), []);
});

test('restore rejects a backup whose hashes are coherent but its environment volume entry was omitted', async t => {
  const f = await fixture(t), ready = revision(); f.addBundle(ready.buildRunId!);
  await f.store.change(state => { state.environmentRevisions.push(ready); });
  const backup = await f.manager.backup(), directory = join(f.manager.backupRoot, backup.id);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.volumes = [];
  manifest.files = manifest.files.filter((file: { path: string }) => !file.path.startsWith('volumes/'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(f.manager.prepareRestore(backup.id), /개인 환경.*번들.*없습니다/);
  assert.deepEqual((await f.manager.status(false, false)).restores, []);
  assert.equal(f.runtime.spaces.size, 1, 'no restore generation should be allocated for an incomplete backup');
});

test('older backups without environment fields keep the pre-environment compatibility path', async t => {
  const f = await fixture(t), backup = await f.manager.backup(), directory = join(f.manager.backupRoot, backup.id);
  const path = join(directory, 'state.json'), state = JSON.parse(await readFile(path, 'utf8')); delete state.environmentRevisions;
  const content = Buffer.from(JSON.stringify(state)); await writeFile(path, content);
  const manifestPath = join(directory, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.files.find((file: { path: string }) => file.path === 'state.json');
  entry.bytes = content.length; entry.sha256 = createHash('sha256').update(content).digest('hex');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await f.manager.pin(backup.id, true);
  assert.equal((await f.manager.backups())[0].pinned, true);
  const prepared = await f.manager.prepareRestore(backup.id), restored = await f.manager.activate(prepared.id); f.stores.add(restored.store);
  assert.deepEqual((await restored.store.read()).environmentRevisions, []);
});
