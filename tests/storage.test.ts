import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService, type ServiceOptions } from '../server/service.ts';
import { activeStorage, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { GitHubTransport } from '../server/github-transport.ts';
import type { Project } from '../shared/collaboration.ts';

async function fixture(t: TestContext, limits?: StorageConfig['limits'], github?: ServiceOptions['github']) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-storage-test-'));
  const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: randomUUID(), freeSpace: async () => 100 * 1024 ** 3, limits };
  const runtime = new StorageFixtureRuntime(config.ownerKey);
  let service = await AgentService.create({ dataDir: join(config.rootDir, 'db'), runtime, storage: config, github });
  t.after(async () => { await service.close(); const suffix = relative(resolve(tmpdir()), resolve(directory)); assert.ok(suffix.startsWith('ac-storage-test-') && !suffix.includes('..')); await rm(directory, { recursive: true }); });
  return { directory, config, runtime, get service() { return service; }, reopen: async () => {
    await service.close(); const active = await activeStorage(config);
    service = await AgentService.create({ dataDir: join(active.dataDir, 'db'), runtime: runtime.forkWorkspace(active.workspaceKey), storage: config, github });
  } };
}
const input = (type: 'agent' | 'team' | 'project', id: string, path = 'input.txt', text = 'preserved') => ({ scope: { type, id }, path, mediaType: 'text/plain', base64: Buffer.from(text).toString('base64') });

async function waitForWorker(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const deadline = Date.now() + 10_000;
  while (!f.runtime.calls.some(call => call.input.run.id === runId) && Date.now() < deadline) await delay(25);
  const call = f.runtime.calls.find(item => item.input.run.id === runId);
  if (!call) {
    const state = await f.service.workspace(), storage = await f.service.storageStatus();
    assert.fail(`Fixture worker did not start: ${JSON.stringify({ run: state.runs.find(run => run.id === runId), resources: state.resources,
      storage: { paused: storage.paused, reason: storage.reason, busy: storage.busy } })}`);
  }
  return call;
}

test('complete backup restores independent DB, personal volumes and shared blobs; original and pause survive restart', async t => {
  const f = await fixture(t); const a = await f.service.createAgent({ name: 'origin', persona: 'persist' });
  const team = await f.service.createTeam({ name: 'peers', memberIds: [a.id] });
  await f.service.importFile(input('agent', a.id));
  const shared = await f.service.importFile(input('team', team.id, 'shared.txt', 'shared original'));
  const oldAgent = (await f.service.workspace()).agents[0];
  const backed = await f.service.createBackup(); const backup = backed.backups[0]; assert.ok(backup.verified);
  await f.service.updateAgent(a.id, { name: 'after backup' });
  await f.service.importFile(input('agent', a.id, 'later.txt', 'later'));
  const prepared = await f.service.prepareRestore(backup.id);
  assert.equal((await f.service.workspace()).agents[0].name, 'after backup');
  const activated = await f.service.activateRestore(prepared.id); assert.equal(activated.paused, true);
  assert.equal((await f.service.workspace()).agents[0].name, 'origin');
  assert.equal((await f.service.downloadWorkspaceFile(a.id, 'input.txt')).bytes.toString(), 'preserved');
  assert.equal((await f.service.downloadFile(shared.file.id)).bytes.toString(), 'shared original');
  assert.equal(f.runtime.spaces.get(f.runtime.key)!.get(oldAgent.workspaceRunId!)!['input.txt'], Buffer.from('preserved').toString('base64'));
  await assert.rejects(f.service.startRun(a.id, 'do not auto resume'), /일시정지/);
  await f.reopen(); assert.equal((await f.service.storageStatus()).paused, true); assert.equal(f.runtime.calls.length, 0);
  const original = await WorkspaceStore.open(join(f.config.rootDir, 'db'));
  try { assert.equal((await original.read()).agents[0].name, 'after backup'); } finally { await original.close(); }
  await f.service.resumeStorage(); assert.equal((await f.service.storageStatus()).paused, false);
});

test('retention keeps newest three unpinned and pinned sets; failed verification deletes no previous backup', async t => {
  const f = await fixture(t); await f.service.createAgent({ name: 'retention', persona: 'persist' });
  let status = await f.service.createBackup(); const pinned = status.backups[0].id;
  await f.service.pinBackup(pinned, true);
  for (let i = 0; i < 4; i++) { await delay(3); status = await f.service.createBackup(); }
  assert.equal(status.backups.length, 4); assert.ok(status.backups.find(item => item.id === pinned)?.pinned);
  const target = status.backups.find(item => !item.pinned)!;
  await writeFile(join(status.backupDir, target.id, 'state.json'), 'corruption');
  const before = await readdir(status.backupDir);
  await assert.rejects(f.service.prepareRestore(target.id), /무결성/);
  assert.deepEqual(await readdir(status.backupDir), before);
  assert.equal((await f.service.workspace()).agents[0].name, 'retention');
});

test('restore disables real GitHub connections and clears live grants without changing historical or legacy scope records', async t => {
  const repository = 'formnest/studio-site'; let externalRequests = 0;
  const github: ServiceOptions['github'] = {
    transport: new GitHubTransport({ token: async () => 'fixture-only-no-credential', fetch: async () => {
      externalRequests++;
      return Response.json({ id: 123, full_name: repository, default_branch: 'main', private: true });
    } }),
    journal: { execute: async (_input, action) => action() },
    status: () => ({ configured: true, writable: true, missing: [], repositories: [repository] }),
  };
  const f = await fixture(t, undefined, github);
  const agent = await f.service.createAgent({ name: 'restored developer', persona: 'scoped fixture' });
  const team = await f.service.createTeam({ name: 'studio team', memberIds: [agent.id] });
  const project = await f.service.collaboration('project_create', { name: 'studio project', teamIds: [team.id] }) as Project;
  const registered = await f.service.createConnection({ repository, access: 'write' });
  const verified = await f.service.verifyConnection(registered.id);
  const connected = await f.service.updateConnection(registered.id, { expectedVersion: verified.version,
    grants: [{ agentId: agent.id, teamId: team.id, projectId: project.id, access: 'write' }] });
  const unverified = await f.service.createConnection({ repository: 'unverified/studio-site', access: 'write' });
  const unverifiedGrant = await f.service.updateConnection(unverified.id, { expectedVersion: unverified.version,
    grants: [{ agentId: agent.id, teamId: team.id, projectId: project.id, access: 'write' }] });
  const legacy = await f.service.createConnection({ repository: 'legacy/registration', access: 'read' });
  await f.service.updateAgent(agent.id, { repositoryIds: [connected.id, unverified.id, legacy.id] });
  const snapshot = await f.service.createSnapshot(agent.id, 'historical connected scope');
  const backupStatus = await f.service.createBackup(), backup = backupStatus.backups[0];
  const backupPath = join(backupStatus.backupDir, backup.id, 'state.json'), originalBytes = await readFile(backupPath);
  await f.service.updateConnection(connected.id, { expectedVersion: connected.version, enabled: false, grants: [] });
  const currentDisconnected = (await f.service.workspace()).connections.find(item => item.id === connected.id)!;
  const prepared = await f.service.prepareRestore(backup.id);
  assert.deepEqual((await f.service.workspace()).connections.find(item => item.id === connected.id), currentDisconnected);
  const staged = await WorkspaceStore.open(join(f.config.rootDir, 'storage-tmp', prepared.id, 'db'));
  try {
    const stagedState = await staged.read(), restored = stagedState.connections.find(item => item.id === connected.id)!;
    assert.equal(restored.github!.status, 'disconnected'); assert.notEqual(restored.github!.generation, connected.github!.generation);
    assert.deepEqual(restored.grants, []); assert.deepEqual(stagedState.agents.find(item => item.id === agent.id)!.repositoryIds, [legacy.id]);
    const pendingConnection = stagedState.connections.find(item => item.id === unverified.id)!;
    assert.equal(pendingConnection.github, undefined); assert.deepEqual(pendingConnection.grants, []);
    assert.deepEqual(stagedState.connections.find(item => item.id === legacy.id), legacy);
    assert.deepEqual(stagedState.snapshots.find(item => item.id === snapshot.id), snapshot);
    // Simulate a valid staged copy prepared by the older release. Activation
    // must independently invalidate it, not rely only on today's prepare path.
    await staged.change(state => {
      state.connections[state.connections.findIndex(item => item.id === connected.id)] = structuredClone(connected);
      state.connections[state.connections.findIndex(item => item.id === unverified.id)] = structuredClone(unverifiedGrant);
      state.agents.find(item => item.id === agent.id)!.repositoryIds = [connected.id, unverified.id, legacy.id];
    });
  } finally { await staged.close(); }
  await f.service.activateRestore(prepared.id);
  const restoredState = await f.service.workspace(), restored = restoredState.connections.find(item => item.id === connected.id)!;
  assert.equal(restored.github!.status, 'disconnected'); assert.notEqual(restored.github!.generation, connected.github!.generation);
  assert.deepEqual(restored.grants, []); assert.deepEqual(restoredState.agents.find(item => item.id === agent.id)!.repositoryIds, [legacy.id]);
  assert.deepEqual(restoredState.connections.find(item => item.id === unverified.id)!.grants, []);
  assert.equal(restoredState.connections.find(item => item.id === unverified.id)!.github, undefined);
  assert.deepEqual(restoredState.connections.find(item => item.id === legacy.id), legacy);
  assert.deepEqual(restoredState.snapshots.find(item => item.id === snapshot.id), snapshot);
  assert.deepEqual(await readFile(backupPath), originalBytes, 'the preserved backup itself must not be edited');
  await f.reopen();
  assert.equal((await f.service.workspace()).connections.find(item => item.id === connected.id)!.github!.status, 'disconnected');
  await f.service.resumeStorage();
  const reverified = await f.service.verifyConnection(connected.id);
  assert.equal(reverified.github!.status, 'connected'); assert.deepEqual(reverified.grants, []);
  const run = await f.service.startRun(agent.id, 'must not regain old external grants', project.id, team.id);
  const worker = await waitForWorker(f, run.id), before = externalRequests;
  assert.equal(worker.input.collaboration?.tools.some(tool => tool.name.startsWith('github_')) ?? false, false);
  await assert.rejects(worker.hooks.onTool!('github_repository', { connectionId: connected.id }), /허용된 GitHub 접근 범위/);
  assert.equal(externalRequests, before, 'reverification alone must not restore agent access');
  await f.service.cancelRun(run.id);
});

test('low data/free budget denies imports without changing state and queued work waits without CPU reservation', async t => {
  const f = await fixture(t, { dataBytes: 1 }); const a = await f.service.createAgent({ name: 'budget', persona: 'wait' });
  await assert.rejects(f.service.importFile(input('agent', a.id)), /예산/);
  assert.equal((await f.service.workspace()).agents[0].workspaceRunId, undefined);
  const run = await f.service.startRun(a.id, 'wait for space'); await delay(50);
  assert.equal((await f.service.workspace()).runs.find(item => item.id === run.id)?.status, 'queued');
  assert.equal(f.runtime.calls.length, 0); assert.equal((await f.service.workspace()).resources!.running.length, 0);
  await f.service.cancelRun(run.id); assert.equal((await f.service.workspace()).runs[0].status, 'cancelled');
});

test('file import collisions, individual copy isolation and live-worker backup deferral', async t => {
  const f = await fixture(t); const a = await f.service.createAgent({ name: 'A', persona: 'A' });
  await f.service.importFile(input('agent', a.id));
  const b = await f.service.forkAgent(a.id, { name: 'B' });
  await f.service.importFile(input('agent', b.id, 'new.bin', 'different'));
  await assert.rejects(f.service.importFile(input('agent', a.id, 'INPUT.TXT')), /같은 경로/);
  await assert.rejects(f.service.downloadWorkspaceFile(a.id, 'new.bin'));
  const run = await f.service.startRun(a.id, 'running');
  await waitForWorker(f, run.id);
  assert.equal(f.runtime.calls.length, 1);
  await assert.rejects(f.service.createBackup(), /종료를 기다립니다/);
  assert.equal(f.runtime.calls[0].hooks.signal.aborted, false);
  await f.service.cancelRun(run.id);
});

test('HTTP binary upload/download is scoped, attachment-only, and existing body/Origin guards remain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-storage-api-')); const key = randomUUID();
  const app = await createApp({ dataDir: join(directory, 'data', 'db'), runtime: new StorageFixtureRuntime(key) });
  t.after(async () => { await app.close(); assert.ok(relative(resolve(tmpdir()), resolve(directory)).startsWith('ac-storage-api-')); await rm(directory, { recursive: true }); });
  const a = (await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'A', persona: 'A' } })).json();
  const team = (await app.inject({ method: 'POST', url: '/api/teams', payload: { name: 'T', memberIds: [a.id] } })).json();
  const imported = await app.inject({ method: 'POST', url: '/api/files/import', payload: input('team', team.id, '파일.html', '<script>unsafe()</script>') });
  assert.equal(imported.statusCode, 201);
  const result = await app.inject(`/api/files/${imported.json().file.id}/download`);
  assert.equal(result.statusCode, 200); assert.equal(result.headers['content-type'], 'application/octet-stream');
  assert.match(String(result.headers['content-disposition']), /^attachment;/); assert.equal(result.body, '<script>unsafe()</script>');
  assert.equal((await app.inject({ method: 'POST', url: '/api/files/import', payload: input('team', randomUUID()) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/files/import', headers: { origin: 'https://evil.invalid' }, payload: input('team', team.id) })).statusCode, 403);
});
