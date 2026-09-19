import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { AgentService } from '../server/service.ts';
import { ContainerRuntime, type RuntimeConfig } from '../server/runtime.ts';
import { atomicJson, loadStorageLayout, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import { environmentSpecHash } from '../server/environments.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult } from '../shared/types.ts';
import { directory, environmentCampaign, pinEnvironmentImage } from './environment-campaign.ts';

// Root-run follow-up only: actual storage paths, no model or environment build,
// no activation, deletion, user data access or change to the main report.
if (process.argv.length !== 2) throw new Error('Usage: node --import tsx scripts/verify-environment-backup.ts');
const dataRoot = join(directory, 'data');
const progressPath = join(directory, 'env-backup-progress.json');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const progressSchema = z.object({ version: z.literal(1), workspaceKey: z.uuid(), sourceReportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupId: z.uuid().nullable(), restoreId: z.uuid().nullable(), createdAt: z.iso.datetime() }).strict();
const observed: Record<string, boolean> = {};
const details: Record<string, unknown> = {};
const unexpectedExecutions: string[] = [];
const unexpectedModelStarts: string[] = [];
let service: AgentService | undefined;
let release: (() => Promise<void>) | undefined;
let original: WorkspaceState | undefined;
let ledgerBefore: Buffer | undefined;
let failure: string | null = null;

async function plainFile(path: string, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit, 'Expected bounded independent verification file');
  return readFile(path);
}
async function readState(path: string): Promise<WorkspaceState> {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'A pre-existing database is required');
  const store = await WorkspaceStore.open(path);
  try { return await store.read(); } finally { await store.close(); }
}
class BackupOnlyRuntime extends ContainerRuntime {
  constructor(config: RuntimeConfig) { super(config); }
  override forkWorkspace(workspaceKey: string): BackupOnlyRuntime { return new BackupOnlyRuntime({ ...this.config, workspaceKey: z.uuid().parse(workspaceKey) }); }
  override async execute(input: ExecutionInput, _hooks: ExecutionHooks): Promise<ExecutionResult> {
    unexpectedExecutions.push(input.run.id);
    assert.fail('Backup verification must not execute tasks, models or environment builds');
  }
}
async function download(runtime: ContainerRuntime, runId: string, path: string): Promise<Buffer> {
  z.uuid().parse(runId);
  const file = await runtime.downloadWorkspaceFile(runId, path, 16 * 1024 * 1024);
  assert.equal(file.path, path);
  const bytes = Buffer.from(file.contentBase64, 'base64'); assert.equal(bytes.length, file.bytes);
  return bytes;
}

try {
  const { manifest, config, budget } = await environmentCampaign();
  ledgerBefore = await plainFile(join(directory, 'model-budget.json'));
  const descriptor = z.object({ status: z.literal('stopped'), pid: z.number().int().positive(), workspaceKey: z.uuid(),
    origin: z.literal('http://127.0.0.1:4315'), stoppedAt: z.iso.datetime() }).passthrough()
    .parse(JSON.parse((await plainFile(join(directory, 'controller.json'), 64 * 1024)).toString('utf8')));
  assert.equal(descriptor.workspaceKey, manifest.workspaceKey);
  try { process.kill(descriptor.pid, 0); assert.fail('The verification controller PID still exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  release = await lockfile.lock(dataRoot, { lockfilePath: join(dataRoot, 'controller.lock'), stale: 30_000, update: 10_000,
    retries: { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 } });
  observed.controllerStoppedAndOwnedLock = true;
  const sourceReport = await plainFile(join(directory, 'report.json'));
  const report = z.object({ status: z.literal('passed'), modelStarts: z.number().int().nonnegative(),
    verified: z.record(z.string(), z.boolean()), environmentRevisions: z.array(z.object({ id: z.uuid(), agentId: z.uuid(), status: z.string(),
      buildRunId: z.uuid().nullable(), sourceRevisionId: z.uuid().optional() }).passthrough()) }).passthrough()
    .parse(JSON.parse(sourceReport.toString('utf8')));
  for (const key of ['automaticLockedBuild', 'actualPackageUse', 'actualMcpCall', 'clonedImmutableBundle', 'databaseReopened']) assert.equal(report.verified[key], true);
  assert.equal((await budget.read()).starts.length, report.modelStarts);
  const storage: StorageConfig = { rootDir: dataRoot, backupDir: join(directory, 'backups'), ownerKey: manifest.workspaceKey };
  const initialLayout = await loadStorageLayout(storage);
  assert.equal(initialLayout.activeId, null, 'This follow-up must not operate on an activated generation');
  original = await readState(join(dataRoot, 'db'));
  assert.ok(!original.runs.some(run => ['queued', 'starting', 'running', 'waiting'].includes(run.status) || run.cleanupPending));
  assert.ok(!original.agents.some(agent => agent.status === 'running'));
  assert.ok(!original.environmentRevisions.some(revision => ['queued', 'building'].includes(revision.status)));
  assert.ok(!original.repairJobs.some(job => ['queued', 'running'].includes(job.status)));
  assert.ok(!original.modelAttempts.some(attempt => attempt.status === 'started'));
  assert.equal(original.messages.length, 0, 'No pending peer delivery is expected in this controlled campaign');
  const originAgent = original.agents.find(agent => agent.name === 'Environment verification original');
  const cloneAgent = original.agents.find(agent => agent.name === 'Environment verification clone');
  assert.ok(originAgent?.environmentRevisionId && cloneAgent?.environmentRevisionId);
  const ready = original.environmentRevisions.find(revision => revision.id === originAgent.environmentRevisionId)!;
  const fork = original.environmentRevisions.find(revision => revision.id === cloneAgent.environmentRevisionId)!;
  assert.ok(ready?.report && ready.buildRunId); assert.ok(fork?.report && fork.buildRunId);
  assert.equal(ready.status, 'ready'); assert.equal(fork.status, 'ready'); assert.notEqual(fork.id, ready.id);
  assert.equal(fork.sourceRevisionId, ready.id); assert.equal(fork.buildRunId, ready.buildRunId);
  assert.ok(report.environmentRevisions.some(item => item.id === ready.id && item.status === 'ready'));
  assert.ok(report.environmentRevisions.some(item => item.id === fork.id && item.sourceRevisionId === ready.id));
  assert.ok(originAgent.workspaceRunId && cloneAgent.workspaceRunId);
  observed.mainHarnessPassedAndQuiescent = true;

  let progress: z.infer<typeof progressSchema>;
  try { progress = progressSchema.parse(JSON.parse((await plainFile(progressPath, 64 * 1024)).toString('utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    progress = { version: 1, workspaceKey: manifest.workspaceKey, sourceReportSha256: digest(sourceReport), backupId: null, restoreId: null, createdAt: new Date().toISOString() };
    await atomicJson(progressPath, progress);
  }
  assert.equal(progress.workspaceKey, manifest.workspaceKey); assert.equal(progress.sourceReportSha256, digest(sourceReport));
  const pinned = await pinEnvironmentImage(config, manifest);
  assert.equal(ready.report.imageId, pinned.evidence.imageId); assert.equal(fork.report.imageId, pinned.evidence.imageId);
  const runtime = new BackupOnlyRuntime(pinned.config);
  const readiness = await runtime.inspect(true); assert.ok(readiness.available && readiness.authenticated, readiness.message);
  service = await AgentService.create({ dataDir: join(dataRoot, 'db'), runtime, storage,
    beforeModelStart: async request => {
      unexpectedModelStarts.push(request.runId);
      // Deliberately fail before any budget.reserve call: this storage-only
      // operation is not authorized to spend a campaign model start.
      assert.fail('Backup verification must not reserve or start a model');
    } });
  const sourceFiles = [
    { runId: ready.buildRunId, path: 'environment/.complete.json' },
    { runId: ready.buildRunId, path: 'environment/package-lock.json' },
    { runId: originAgent.workspaceRunId, path: 'proof.json' },
    { runId: cloneAgent.workspaceRunId, path: 'clone-proof.json' },
  ];
  const bytesBefore: Buffer[] = [];
  for (const file of sourceFiles) bytesBefore.push(await download(runtime, file.runId, file.path));
  const complete = z.object({ version: z.literal(1), specHash: z.string(), contentHash: z.string(), lockfileHash: z.string() }).strict()
    .parse(JSON.parse(bytesBefore[0].toString('utf8')));
  assert.equal(complete.specHash, environmentSpecHash(ready.spec));
  assert.equal(complete.contentHash, ready.report.contentHash); assert.equal(complete.lockfileHash, ready.report.lockfileHash);
  assert.equal(digest(bytesBefore[1]), ready.report.lockfileHash);

  if (!progress.backupId) {
    const existing = await service.storageStatus();
    assert.ok(existing.backups.filter(item => !item.pinned).length < 3, 'A new backup must not rotate any pre-existing evidence');
    const known = new Set(existing.backups.map(item => item.id));
    const backed = await service.createBackup();
    const created = backed.backups.filter(item => !known.has(item.id) && item.kind === 'manual');
    assert.equal(created.length, 1); progress.backupId = created[0].id;
    await atomicJson(progressPath, progress);
  }
  const backed = await service.pinBackup(progress.backupId, true);
  const backup = backed.backups.find(item => item.id === progress.backupId)!;
  assert.ok(backup?.verified && backup.pinned);
  observed.backupVerifiedAndPinned = true;
  if (!progress.restoreId) {
    const prepared = await service.prepareRestore(progress.backupId);
    progress.restoreId = prepared.id; await atomicJson(progressPath, progress);
  }
  const layout = await loadStorageLayout(storage);
  assert.equal(layout.activeId, initialLayout.activeId); assert.deepEqual(layout.generations, initialLayout.generations);
  const prepared = layout.restores.find(item => item.id === progress.restoreId && item.backupId === progress.backupId);
  assert.ok(prepared?.ready); assert.notEqual(prepared.workspaceKey, manifest.workspaceKey);
  const destination = resolve(dataRoot, 'storage-tmp', z.uuid().parse(prepared.id), 'db');
  const restoredState = await readState(destination);
  assert.deepEqual(restoredState, { ...original, operatorPaused: true });
  const restoredReady = restoredState.environmentRevisions.find(item => item.id === ready.id)!;
  const restoredFork = restoredState.environmentRevisions.find(item => item.id === fork.id)!;
  assert.equal(restoredReady.buildRunId, restoredFork.buildRunId); assert.equal(restoredReady.buildRunId, ready.buildRunId);
  const restoredRuntime = runtime.forkWorkspace(prepared.workspaceKey);
  const restoredVolumes = await restoredRuntime.listWorkspaceVolumes();
  assert.equal(restoredVolumes.filter(volume => volume.runId === ready.buildRunId).length, 1, 'Shared ready/fork bundle is restored once');
  const buildRun = original.runs.find(run => run.id === ready.buildRunId);
  const buildInput = original.executionStates[ready.buildRunId]?.input;
  assert.ok(buildRun && buildInput?.environmentBuild);
  assert.equal(buildInput.environmentBuild.revisionId, ready.id);
  assert.deepEqual(buildInput.environmentBuild.spec, ready.spec);
  // For an environment build, the public resume check only mounts the existing
  // bundle read-only and rehashes its contents; it does not install or execute a
  // model. This verifies more than trusting the copied completion marker.
  assert.equal(await runtime.canResume({ ...buildInput, run: buildRun }), true, 'Original completed bundle no longer verifies');
  assert.equal(await restoredRuntime.canResume({ ...buildInput, run: buildRun }), true, 'Restored completed bundle content no longer verifies');
  observed.originalAndRestoredBundleContentRehashed = true;
  for (let index = 0; index < sourceFiles.length; index++) {
    const file = sourceFiles[index];
    const restored = await download(restoredRuntime, file.runId, file.path);
    assert.ok(restored.equals(bytesBefore[index]), `Restored bytes differ: ${file.path}`);
    assert.ok((await download(runtime, file.runId, file.path)).equals(bytesBefore[index]), `Original bytes changed: ${file.path}`);
  }
  observed.stagedDatabaseAndEnvironmentReferences = true;
  observed.sharedBundleRestoredOnce = true;
  observed.bundleMarkerLockfileAndProofBytes = true;
  observed.originalFileBytesUnchanged = true;
  observed.restorePreparedWithoutActivation = true;
  details.backupId = backup.id; details.restoreId = prepared.id; details.restoredWorkspaceKey = prepared.workspaceKey;
  details.imageId = pinned.evidence.imageId; details.buildRunId = ready.buildRunId;
  details.sourceRevisionId = ready.id; details.forkRevisionId = fork.id;
  details.files = sourceFiles.map((file, index) => ({ ...file, bytes: bytesBefore[index].length, sha256: digest(bytesBefore[index]) }));
  details.contentHash = complete.contentHash; details.lockfileHash = complete.lockfileHash;
} catch (error) { failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  try {
    await service?.close(); service = undefined;
    if (original && release) {
      assert.deepEqual(await readState(join(dataRoot, 'db')), original);
      observed.originalDatabaseUnchangedAfterClose = true;
    }
    assert.deepEqual(unexpectedExecutions, []); assert.deepEqual(unexpectedModelStarts, []);
    if (ledgerBefore) {
      assert.ok((await plainFile(join(directory, 'model-budget.json'))).equals(ledgerBefore));
      observed.modelLedgerUnchanged = true;
    }
  } catch (error) { failure ??= error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  try { await release?.(); } catch (error) { failure ??= String(error); process.exitCode = 1; }
  const completedAt = new Date().toISOString();
  const result = { status: failure ? 'incomplete' : 'passed', error: failure, completedAt,
    modelStarts: 0, attemptedExecutions: unexpectedExecutions.length, attemptedModelStarts: unexpectedModelStarts.length,
    verified: observed, ...details, activated: false, verificationDataRetained: true,
    scope: 'Actual storage backup and staged restore; no model or restored-agent execution; complete bundle rehashed read-only, marker and lockfile plus proof bytes verified' };
  await atomicJson(join(directory, `env-backup-${completedAt.replace(/:/g, '-')}.json`), result);
  await atomicJson(join(directory, 'env-backup.json'), result);
  console.log(JSON.stringify({ status: result.status, error: failure, modelStarts: 0, verified: observed, report: join(directory, 'env-backup.json') }));
}
