import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateCurrentGitHubGrants, currentGrantsArguments, type CurrentGrantsDependencies, type CurrentGrantsProof, type CurrentGrantsOptions } from '../scripts/migrate-desktop-github-grants.ts';
import type { WorkspaceState } from '../server/store.ts';
import { stableRuntimeHash } from '../shared/runtime-releases.ts';
import { ServiceStartupCleanupError } from '../server/startup-cleanup.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'ac-current-grants-')); t.after(() => rm(root, { recursive: true }));
  const sourceDb = join(root, 'source-db'), targetDb = join(root, 'target-db');
  for (const path of [sourceDb, targetDb]) { await mkdir(path); await writeFile(join(path, 'PG_VERSION'), '17'); }
  const connectionId = randomUUID(), agentId = randomUUID(), teamId = randomUUID(), projectId = randomUUID(), ownerKey = randomUUID(), generation = randomUUID();
  const source = { operatorPaused: false, connections: [{ id: connectionId, repository: 'owner/repository', access: 'write', version: 3,
    github: { status: 'connected', generation, repositoryId: 123, defaultBranch: 'main', verifiedAt: '2026-09-12T00:00:00.000Z' },
    grants: [{ agentId, teamId, projectId, access: 'write' }] }],
    agents: [{ id: agentId, repositoryIds: [connectionId], version: 2, updatedAt: '2026-09-12T00:00:00.000Z' }],
    executionStates: { frozen: { input: { sentinel: 'preserved history' } } }, runs: [{ id: randomUUID(), status: 'waiting' }],
    teams: [], projects: [] } as unknown as WorkspaceState;
  let sourceLive = structuredClone(source), target = structuredClone(source), writes = 0, verifications = 0, sourceReleased = 0, targetReleased = 0;
  target.operatorPaused = true; target.connections[0].github!.status = 'disconnected'; target.connections[0].github!.generation = randomUUID();
  target.connections[0].grants = []; target.connections[0].version = 4; target.agents[0].repositoryIds = []; target.agents[0].version = 3;
  target.agents[0].updatedAt = '2026-09-13T00:00:00.000Z';
  const proof: CurrentGrantsProof = { sourceState: source, sourceDb, targetDb, sourceOwner: randomUUID(), targetOwner: ownerKey,
    cutoverId: randomUUID(), generationId: randomUUID(), proofSha256: 'b'.repeat(64), config: { version: 1, ownerKey,
      appId: '1', installationId: '2', privateKeyFile: join(root, 'never-read.pem'), repositories: ['owner/repository'] } };
  const options: CurrentGrantsOptions = { sourceRoot: root, appDataRoot: join(root, 'app'), resourceRoot: join(root, 'resources'),
    preparation: join(root, 'preparation.json'), preparationSha256: 'a'.repeat(64), expectedSourceStateSha256: 'c'.repeat(64),
    receipt: join(root, 'grants.json'), approval: 'approve-current-source-grants' };
  const dependencies: CurrentGrantsDependencies = {
    lockSource: async () => async () => { sourceReleased++; },
    lockTarget: async () => ({ workspaceKey: ownerKey, release: async () => { targetReleased++; } }),
    proof: async () => structuredClone(proof),
    openStore: async path => ({ read: async () => structuredClone(path === sourceDb ? sourceLive : target), close: async () => {},
      change: async mutate => { assert.equal(path, targetDb); const next = structuredClone(target); const result = mutate(next); target = next; writes++; return result; } }),
    verifyRepository: async () => { verifications++; assert.equal(writes, 0); return { id: 123, fullName: 'owner/repository', defaultBranch: 'main', access: 'write' }; },
  };
  return { options, dependencies, proof, source, sourceLive: () => sourceLive, changeSource: () => { sourceLive.operatorPaused = true; },
    target: () => target, changeTarget: () => { target.runs = []; }, writes: () => writes, verifications: () => verifications,
    sourceReleased: () => sourceReleased, targetReleased: () => targetReleased };
}

test('current-source grant migration keeps generations/history, increments versions, and retries after DB commit without duplicate mutation', async t => {
  const f = await fixture(t); let once = true;
  f.dependencies.afterStateCommit = async () => { if (once) { once = false; throw new Error('crash after commit'); } };
  await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies));
  assert.equal(f.writes(), 1); assert.equal(f.verifications(), 1);
  const result = await migrateCurrentGitHubGrants(f.options, f.dependencies);
  assert.equal(result.businessWrites, 0); assert.equal(result.paused, true); assert.equal(f.writes(), 1); assert.equal(f.verifications(), 1);
  assert.equal(f.target().connections[0].github!.generation, f.source.connections[0].github!.generation);
  assert.deepEqual(f.target().connections[0].grants, f.source.connections[0].grants);
  assert.equal(f.target().connections[0].version, 5); assert.equal(f.target().agents[0].version, 4);
  assert.deepEqual(f.target().agents[0].repositoryIds, f.source.agents[0].repositoryIds);
  assert.deepEqual(f.target().executionStates, f.source.executionStates);
  assert.equal(stableRuntimeHash(f.sourceLive()), stableRuntimeHash(f.source));
  assert.ok(JSON.parse(await readFile(`${f.options.receipt}.committed.json`, 'utf8')).sourceUnchanged);
});

test('stale source or changed imported target fails before network and mutation', async t => {
  for (const changed of ['source', 'target']) {
    const f = await fixture(t); if (changed === 'source') f.changeSource(); else f.changeTarget();
    await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies)); assert.equal(f.writes(), 0); assert.equal(f.verifications(), 0);
    assert.equal(f.sourceReleased(), 1); assert.equal(f.targetReleased(), 1);
  }
});

test('metadata or token-scope mismatch never commits any grants', async t => {
  for (const result of [{ id: 999, fullName: 'owner/repository', defaultBranch: 'main', access: 'write' },
    { id: 123, fullName: 'owner/repository', defaultBranch: 'changed', access: 'write' },
    { id: 123, fullName: 'owner/repository', defaultBranch: 'main', access: 'read' }]) {
    const f = await fixture(t); f.dependencies.verifyRepository = async () => result as Awaited<ReturnType<NonNullable<CurrentGrantsDependencies['verifyRepository']>>>;
    await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies)); assert.equal(f.writes(), 0);
    assert.deepEqual(f.target().connections[0].grants, []);
  }
});

test('source or target lease refusal prevents DB and network use', async t => {
  for (const target of [false, true]) {
    const f = await fixture(t); let opened = 0; f.dependencies.openStore = async () => { opened++; throw new Error(); };
    if (target) f.dependencies.lockTarget = async () => { throw new Error('target locked'); };
    else f.dependencies.lockSource = async () => { throw new Error('source locked'); };
    await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies));
    assert.equal(opened, 0); assert.equal(f.verifications(), 0); assert.equal(f.writes(), 0); assert.equal(f.sourceReleased(), target ? 1 : 0);
  }
});

test('all repositories and a final live-source check must pass before any scope commit', async t => {
  const f = await fixture(t);
  const second = structuredClone(f.source.connections[0]); second.id = randomUUID(); second.repository = 'owner/second';
  f.source.connections.push(second); f.sourceLive().connections.push(structuredClone(second)); f.proof.config.repositories.push(second.repository);
  const disconnected = structuredClone(second); disconnected.github!.status = 'disconnected'; disconnected.github!.generation = randomUUID();
  disconnected.grants = []; disconnected.version = 4; f.target().connections.push(disconnected);
  let checks = 0;
  f.dependencies.verifyRepository = async connection => { checks++; return { id: checks === 2 ? 999 : 123, fullName: connection.repository, defaultBranch: 'main', access: 'write' }; };
  await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies)); assert.equal(checks, 2); assert.equal(f.writes(), 0);
  const stale = await fixture(t);
  stale.dependencies.verifyRepository = async () => { stale.changeSource(); return { id: 123, fullName: 'owner/repository', defaultBranch: 'main', access: 'write' }; };
  await assert.rejects(migrateCurrentGitHubGrants(stale.options, stale.dependencies)); assert.equal(stale.writes(), 0);
});

test('explicit approval literal is required by CLI', () => {
  assert.throws(() => currentGrantsArguments([]));
  assert.throws(() => currentGrantsArguments(['--approve-current-source-grants', '--approve-current-source-grants']));
});

test('a ServiceStartupCleanupError retains both controller leases when no store was returned', async t => {
  const f = await fixture(t);
  f.dependencies.openStore = async () => { throw new ServiceStartupCleanupError(new Error('open failed'), new Error('close uncertain')); };
  await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies), ServiceStartupCleanupError);
  assert.equal(f.sourceReleased(), 0); assert.equal(f.targetReleased(), 0); assert.equal(f.verifications(), 0); assert.equal(f.writes(), 0);
});

test('an unapplied intent never reuses authority after permission revocation', async t => {
  const f = await fixture(t), originalOpen = f.dependencies.openStore!;
  f.dependencies.openStore = async path => {
    const store = await originalOpen(path);
    return path === f.proof.targetDb ? { ...store, change: async () => { throw new Error('transaction failed before mutation'); } } : store;
  };
  await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies));
  assert.equal(f.writes(), 0); assert.equal(f.verifications(), 1);
  assert.ok(JSON.parse(await readFile(f.options.receipt, 'utf8')).targetBeforeSha256);
  f.dependencies.openStore = originalOpen; let freshChecks = 0;
  f.dependencies.verifyRepository = async () => { freshChecks++; throw new Error('permission revoked'); };
  await assert.rejects(migrateCurrentGitHubGrants(f.options, f.dependencies));
  assert.equal(freshChecks, 1); assert.equal(f.writes(), 0); assert.deepEqual(f.target().connections[0].grants, []);
});
