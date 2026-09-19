import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertReleaseIdle, inspectWorkerSources, selectRuntimeRelease, selectedRuntimeConfig, readRuntimeRelease, workerSourceFiles } from '../server/releases.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { Run } from '../shared/types.ts';
import type { Command } from '../server/process.ts';
import { runtimeConfig } from '../server/runtime.ts';
import { createOperatorRequest, decideOperatorRequest, progressOperatorRequest, verifyOperatorRequest } from '../server/operator-requests.ts';

const oldImage = `sha256:${'a'.repeat(64)}`, newImage = `sha256:${'b'.repeat(64)}`;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerKey = randomUUID(), config = runtimeConfig({ AGENT_IMAGE: 'old', AGENT_AUTH: 'none' });
  const runner: Command = async (_file, args) => ({ code: 0, stderr: '', stdout: args[0] === 'image'
    ? args[2] === 'old' || args[2] === oldImage ? oldImage : newImage
    : (await Promise.all(workerSourceFiles.map(async path => `${createHash('sha256').update(await readFile(join('worker', path))).digest('hex')}  /app/${path}`))).join('\n') });
  return { root, ownerKey, config, runner };
}
test('release fixes an immutable image and rollback preserves source and history', async t => {
  const { root, ownerKey, config, runner } = await fixture(t);
  assert.equal((await selectedRuntimeConfig(root, ownerKey, config)).image, 'old');
  const activated = await selectRuntimeRelease(root, ownerKey, config, { action: 'activate', image: 'candidate' }, runner);
  assert.equal(activated.activeImage, newImage); assert.equal(activated.previousImage, oldImage);
  assert.equal(Object.keys(activated.history[0].sourceHashes).length, workerSourceFiles.length);
  assert.equal((await selectedRuntimeConfig(root, ownerKey, config)).image, newImage);
  const rollback = await selectRuntimeRelease(root, ownerKey, config, { action: 'rollback' }, runner);
  assert.equal(rollback.activeImage, oldImage); assert.equal(rollback.history.length, 2);
  assert.equal(config.image, 'old');
});
test('release rejects a changed source, owner, target and partial manifest', async t => {
  const { root, ownerKey, config, runner } = await fixture(t);
  const wrongSource: Command = async (file, args, options) => args[0] === 'run'
    ? { code: 0, stdout: 'not matching', stderr: '' } : runner(file, args, options);
  await assert.rejects(selectRuntimeRelease(root, ownerKey, config, { action: 'activate', image: 'candidate' }, wrongSource), /소스가 다릅니다/);
  assert.equal(await readRuntimeRelease(root, ownerKey, config), null);
  await selectRuntimeRelease(root, ownerKey, config, { action: 'activate', image: 'candidate' }, runner);
  await assert.rejects(readRuntimeRelease(root, randomUUID(), config), /소유권/);
  await assert.rejects(readRuntimeRelease(root, ownerKey, { ...config, wslDistro: 'other' }), /실행 대상/);
  await rm(join(root, 'runtime-release.json'));
  await assert.rejects(selectedRuntimeConfig(root, ownerKey, config), /누락/);
});
test('invalid image arguments are rejected before Docker execution', async t => {
  const { root, ownerKey, config, runner } = await fixture(t);
  await assert.rejects(selectRuntimeRelease(root, ownerKey, config, { action: 'activate', image: '--privileged' }, runner), /식별자/);
  await writeFile(join(root, 'runtime-release.json'), '{}');
  await assert.rejects(readRuntimeRelease(root, ownerKey, config), /누락/);
});
test('failed image inspection cleans only its exact owned helper', async t => {
  const { ownerKey, config } = await fixture(t);
  const removed: string[] = []; let matchingOwner = true;
  const runner: Command = async (_file, args) => {
    if (args[0] === 'run') throw new Error('inspection timed out');
    if (args[0] === 'inspect') return { code: 0, stderr: '', stdout: JSON.stringify({ app: 'agent-company',
      'agent-company.workspace': matchingOwner ? ownerKey : randomUUID(), 'agent-company.role': 'release-inspection' }) };
    if (args[0] === 'rm') removed.push(args[2]);
    return { code: 0, stderr: '', stdout: '' };
  };
  await assert.rejects(inspectWorkerSources(config, newImage, ownerKey, runner), /timed out/);
  assert.deepEqual(removed, [`ac-release-${ownerKey.slice(0, 8)}`]);
  matchingOwner = false;
  await assert.rejects(inspectWorkerSources(config, newImage, ownerKey, runner), /소유권/);
  assert.equal(removed.length, 1);
});
test('release guard rejects live containers and paused or queued work without changing DB', async t => {
  const { root, ownerKey, config } = await fixture(t);
  const store = await WorkspaceStore.open(join(root, 'db'));
  await store.change(state => { state.runs.push({ id: randomUUID(), status: 'paused' } as Run); });
  await store.close();
  const idle: Command = async () => ({ code: 0, stderr: '', stdout: '' });
  await assert.rejects(assertReleaseIdle(root, ownerKey, config, idle), /미완료 작업/);
  const reopened = await WorkspaceStore.open(join(root, 'db'));
  assert.equal((await reopened.read()).runs[0].status, 'paused'); await reopened.close();
  const running: Command = async () => ({ code: 0, stderr: '', stdout: 'some-owned-container' });
  await assert.rejects(assertReleaseIdle(root, ownerKey, config, running), /컨테이너가 실행 중/);
});

test('release accepts a verified completed continuation but preserves unfinished and cleanup guards', async t => {
  const { root, ownerKey, config } = await fixture(t), agentId = randomUUID(), sourceId = randomUUID(), childId = randomUUID();
  const store = await WorkspaceStore.open(join(root, 'db'));
  const timestamp = new Date().toISOString();
  await store.change(state => {
    state.agents.push({ id: agentId, name: 'Release fixture', description: '', persona: 'Fixture only', color: '#123456', model: 'fixture',
      status: 'idle', generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: timestamp, updatedAt: timestamp });
    state.runs.push({ id: sourceId, agentId, status: 'waiting', budgetRootRunId: sourceId, budgetProjectId: null, budgetTeamId: null } as Run);
    let request = createOperatorRequest(state, agentId, { scope: { type: 'agent', id: agentId }, category: 'other', title: 'Fixture', reason: 'Fixture',
      requestedAction: 'Fixture', requestedScope: 'Fixture', verificationCriteria: 'Fixture', idempotencyKey: randomUUID() }, sourceId);
    const actor = { kind: 'operator' as const };
    request = decideOperatorRequest(state, actor, request.id, { expectedVersion: request.version, status: 'approved', reason: 'Fixture' });
    request = progressOperatorRequest(state, actor, request.id, { expectedVersion: request.version, status: 'verification_pending', detail: 'Fixture' });
    request = verifyOperatorRequest(state, actor, request.id, { expectedVersion: request.version, method: 'manual', passed: true, evidence: 'Fixture', detail: 'Fixture' });
    const source = state.runs[0]; source.status = 'superseded'; source.continuedByRunId = childId;
    state.runs.push({ id: childId, agentId, status: 'succeeded', continuedFromRunId: sourceId, operatorRequestId: request.id,
      budgetRootRunId: sourceId, budgetProjectId: null, budgetTeamId: null } as Run);
    state.operatorRequests[0].resumeReceipts.push({ runId: sourceId, continuedRunId: childId, contentVersion: request.contentVersion,
      verificationId: request.verification!.id, at: new Date().toISOString() });
  });
  await store.close();
  const idle: Command = async () => ({ code: 0, stdout: '', stderr: '' });
  await assertReleaseIdle(root, ownerKey, config, idle);
  for (const status of ['queued', 'waiting', 'paused'] as const) {
    const editing = await WorkspaceStore.open(join(root, 'db'));
    await editing.change(state => { state.runs.find(run => run.id === childId)!.status = status; }); await editing.close();
    await assert.rejects(assertReleaseIdle(root, ownerKey, config, idle), /미완료 작업/);
  }
  const editing = await WorkspaceStore.open(join(root, 'db'));
  await editing.change(state => { const child = state.runs.find(run => run.id === childId)!; child.status = 'succeeded'; child.cleanupPending = '검증용 정리 대기'; }); await editing.close();
  await assert.rejects(assertReleaseIdle(root, ownerKey, config, idle), /미완료 작업/);
  const corrupt = await WorkspaceStore.open(join(root, 'db'));
  await corrupt.change(state => { state.runs.find(run => run.id === childId)!.cleanupPending = null; state.operatorRequests[0].resumeReceipts = []; }); await corrupt.close();
  await assert.rejects(assertReleaseIdle(root, ownerKey, config, idle), /resume receipt/);
});
