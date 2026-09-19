import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { transitionRuntimeRelease, readRuntimeRelease, selectedRuntimeConfig, selectRuntimeRelease, runtimeReleaseEvidenceBinding,
  createRuntimeReleaseEvidenceTemplate, inspectRuntimeBase } from '../server/releases.ts';
import { workerSourceFiles, stableRuntimeHash } from '../shared/runtime-releases.ts';
import { WorkspaceStore } from '../server/store.ts';
import { runtimeConfig } from '../server/runtime.ts';
import type { Command } from '../server/process.ts';
import type { Agent, Run, Snapshot } from '../shared/types.ts';

const a = `sha256:${'a'.repeat(64)}`, b = `sha256:${'b'.repeat(64)}`;
async function fixture(t: TestContext, started = false) {
  const root = await mkdtemp(join(tmpdir(), 'ac-pinned-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ownerKey = randomUUID(), runId = randomUUID(), snapshotId = randomUUID(), timestamp = new Date().toISOString();
  const config = runtimeConfig({ AGENT_IMAGE: 'old', AGENT_AUTH: 'none' });
  const hashes = Object.fromEntries(await Promise.all(workerSourceFiles.map(async name => [name, createHash('sha256').update(await readFile(join('worker', name))).digest('hex')])));
  const oldHashes = { ...hashes, 'entry.mjs': 'f'.repeat(64) };
  const controls = { missing: '', helperChanged: false, baseChanged: false, live: false, boundaryCalls: 0, failBoundary: 0 };
  const runner: Command = async (_file, args, options) => {
    if (args[0] === 'create') return { code: 0, stderr: '', stdout: 'source-container' };
    if (args[0] === 'export') {
      await options?.onStdout?.(Buffer.from('fixture archive'));
      return { code: 0, stderr: '', stdout: '' };
    }
    if (args[0] === 'ps') {
      controls.boundaryCalls++;
      if (controls.boundaryCalls === controls.failBoundary) throw new Error('simulated interruption after DB pin commit');
      return { code: 0, stderr: '', stdout: controls.live ? 'owned-container' : '' };
    }
    if (args[0] === 'image') {
      const id = args[2] === 'old' || args[2] === a ? a : b;
      if (controls.missing === id) return { code: 1, stdout: '', stderr: 'No such image' };
      return { code: 0, stderr: '', stdout: args.at(-1) === '{{json .}}' ? JSON.stringify({ Id: id, Os: 'linux', Architecture: 'amd64', Config: { User: 'node', Entrypoint: ['node', '/app/entry.mjs'] } }) : id };
    }
    if (args[0] === 'run') {
      const id = args.find(arg => arg === a || arg === b);
      if (args.includes('--entrypoint=python3')) {
        for await (const _chunk of options!.inputStream!) { /* Consume the producer before completing. */ }
        return { code: 0, stderr: '', stdout: (controls.baseChanged && id === b ? 'e' : 'c').repeat(64) };
      }
      const source = { ...(id === a ? oldHashes : hashes) };
      if (controls.helperChanged && id === a) source['workspace.mjs'] = 'e'.repeat(64);
      return { code: 0, stderr: '', stdout: workerSourceFiles.map(name => `${source[name]}  /app/${name}`).join('\n') };
    }
    return { code: 1, stdout: '', stderr: 'No such container' };
  };
  await writeFile(join(root, 'runtime-release.identity.json'), JSON.stringify({ version: 1, ownerKey }));
  await writeFile(join(root, 'runtime-release.json'), JSON.stringify({ version: 1, ownerKey, target: { mode: 'docker', wslDistro: null }, activeImage: a, previousImage: a,
    history: [{ image: a, previousImage: a, action: 'activate', createdAt: timestamp, sourceHashes: oldHashes }] }));
  const store = await WorkspaceStore.open(join(root, 'db'));
  const agent: Agent = { id: randomUUID(), name: 'fixture', description: '', persona: '', color: '#000000', model: 'fixture', status: 'running',
    generation: 0, parentId: null, parentSnapshotId: null, version: 1, allowWeb: false, repositoryIds: [], createdAt: timestamp, updatedAt: timestamp };
  const snapshot: Snapshot = { id: snapshotId, agentId: agent.id, label: 'fixture', agentVersion: 1, agent, memories: [], skills: [], sourceRunId: null, createdAt: timestamp };
  const run: Run = { id: runId, agentId: agent.id, agentVersion: 1, snapshotId, prompt: 'preserve', status: started ? 'waiting' : 'queued', result: '', error: null,
    inputTokens: started ? 12 : 0, outputTokens: 0, artifacts: [], steering: [], createdAt: timestamp, startedAt: started ? timestamp : null, completedAt: null, attempt: started ? 1 : 0 };
  await store.change(state => {
    state.agents.push(agent); state.snapshots.push(snapshot); state.runs.push(run);
    state.executionStates[runId] = { input: { agent, memories: [], skills: [], connections: [] }, inputTokens: started ? 12 : 0, outputTokens: 0 };
    if (started) state.executionStates[runId].checkpoint = { phase: 'task', sessionId: randomUUID() };
    state.deploymentHold = { version: 1, id: randomUUID(), requestedAt: timestamp, readyAt: timestamp };
  });
  const before = await store.read(); await store.close();
  async function evidence() {
    const receipt = join(root, 'launch-receipt.json'); await writeFile(receipt, JSON.stringify({ runId, image: a, snapshotId, checkpoint: before.executionStates[runId].checkpoint }));
    const evidencePath = join(root, 'evidence.json');
    await writeFile(evidencePath, JSON.stringify({ version: 1, ownerKey, workspaceKey: ownerKey, records: [{ ...runtimeReleaseEvidenceBinding(before, runId),
      image: a, verifiedBy: 'fixture-operator', verifiedAt: timestamp, reason: 'Explicit immutable launch receipt checked against saved Run, snapshot and checkpoint.',
      evidenceFiles: [{ path: receipt, sha256: createHash('sha256').update(await readFile(receipt)).digest('hex') }] }] }));
    return evidencePath;
  }
  async function state() { const store = await WorkspaceStore.open(join(root, 'db')); try { return await store.read(); } finally { await store.close(); } }
  return { root, ownerKey, config, runner, controls, before, runId, evidence, state };
}

test('pinned release requires ready hold and complete owned-container cleanup', async t => {
  const f = await fixture(t);
  const store = await WorkspaceStore.open(join(f.root, 'db')); await store.change(state => { state.deploymentHold!.readyAt = null; }); await store.close();
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /배포 준비/);
  f.controls.live = true;
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /컨테이너 정리/);
});

test('never-started queued Run receives old pin and only new default changes', async t => {
  const f = await fixture(t);
  const record = await transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner);
  assert.equal(record.version, 2); assert.equal(record.activeImage, b);
  const after = await f.state(), { runtimeRelease, ...run } = after.runs[0];
  assert.equal(runtimeRelease?.image, a); assert.deepEqual(run, f.before.runs[0]);
  assert.deepEqual(after.snapshots, f.before.snapshots); assert.deepEqual(after.executionStates, f.before.executionStates);
  assert.equal((await selectedRuntimeConfig(f.root, f.ownerKey, f.config)).image, b);
  await assert.rejects(selectRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'rollback' }, f.runner), /정식 pinned/);
  await transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'rollback' }, f.runner);
  assert.equal((await readRuntimeRelease(f.root, f.ownerKey, f.config))?.activeImage, a);
  assert.equal((await f.state()).runs[0].runtimeRelease?.image, a);
});

test('started waiting Run needs exact operator evidence and preserves original state', async t => {
  const f = await fixture(t, true);
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /검증된 이미지 증빙/);
  assert.deepEqual(await f.state(), f.before);
  const template = await createRuntimeReleaseEvidenceTemplate(f.root, f.ownerKey, f.config, f.runner) as { records: object[] };
  assert.equal(template.records.length, 1);
  const evidencePath = await f.evidence();
  await transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate', evidencePath }, f.runner);
  const after = await f.state(), { runtimeRelease, ...run } = after.runs[0];
  assert.equal(runtimeRelease?.image, a); assert.deepEqual(run, f.before.runs[0]); assert.deepEqual(after.executionStates, f.before.executionStates);
});

test('conflicting snapshot binding or changed evidence file rejects migration', async t => {
  const f = await fixture(t, true), evidencePath = await f.evidence();
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')); evidence.records[0].snapshotHash = 'd'.repeat(64);
  await writeFile(evidencePath, JSON.stringify(evidence));
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate', evidencePath }, f.runner), /snapshot/);
  await f.evidence(); await writeFile(join(f.root, 'launch-receipt.json'), 'changed');
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate', evidencePath }, f.runner), /증빙 파일 hash/);
});

test('missing images and changed helper or runtime base reject before pin commit', async t => {
  const f = await fixture(t);
  f.controls.missing = a;
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /No such image/);
  f.controls.missing = ''; f.controls.helperChanged = true;
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /소스가 다릅니다/);
  f.controls.helperChanged = false; f.controls.baseChanged = true;
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /실행 기반/);
  assert.deepEqual(await f.state(), f.before);
});

test('interruption after DB commit blocks startup and exact request resumes idempotently', async t => {
  const f = await fixture(t); f.controls.failBoundary = 2;
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /simulated interruption/);
  assert.equal((await f.state()).runs[0].runtimeRelease?.image, a);
  assert.equal((await readRuntimeRelease(f.root, f.ownerKey, f.config))?.version, 1);
  await assert.rejects(selectedRuntimeConfig(f.root, f.ownerKey, f.config), /이행이 중단/);
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'rollback' }, f.runner), /요청이 일치/);
  const record = await transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner);
  assert.equal(record.history.length, 2); assert.equal(record.activeImage, b);
  assert.equal((await selectedRuntimeConfig(f.root, f.ownerKey, f.config)).image, b);
});

test('conflicting existing pin and state changes during an interrupted plan fail closed', async t => {
  const f = await fixture(t); f.controls.failBoundary = 2;
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner));
  const store = await WorkspaceStore.open(join(f.root, 'db'));
  await store.change(state => { state.runs[0].runtimeRelease!.manifestId = 'd'.repeat(64); }); await store.close();
  await assert.rejects(transitionRuntimeRelease(f.root, f.ownerKey, f.config, { action: 'activate', image: 'candidate' }, f.runner), /pin이 이행 계획과 충돌/);
});

test('base fingerprint command measures filesystem with isolation and image execution config', async t => {
  const f = await fixture(t), calls: string[][] = [];
  const runner: Command = async (file, args, options) => { calls.push(args); return f.runner(file, args, options); };
  const hash = await inspectRuntimeBase(f.config, a, f.ownerKey, runner);
  assert.match(hash, /^[a-f0-9]{64}$/);
  const args = calls.find(item => item[0] === 'run')!;
  for (const flag of ['--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true']) assert.ok(args.includes(flag));
  assert.ok(args.at(-1)!.includes('pax_headers')); assert.ok(args.at(-1)!.includes('hardlink'));
  assert.ok(args.includes('--user=1000:1000')); assert.ok(calls.some(item => item[0] === 'create'));
  assert.ok(calls.some(item => item[0] === 'export'));
  assert.notEqual(hash, stableRuntimeHash({ filesystem: 'c'.repeat(64) }));
});
