import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import lockfile from 'proper-lockfile';
import { WorkspaceStore } from '../server/store.ts';
import { activeStorage, atomicJson } from '../server/storage.ts';
import { runtimeConfig } from '../server/runtime.ts';
import { dockerForRelease, selectedRuntimeConfig } from '../server/releases.ts';
import type { Workspace } from '../shared/types.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';

loadEnvFile('.env');
const directory = resolve('.verification/scoped-budget-20260907');
const root = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const mode = process.argv[2];
assert.ok(['baseline', 'verify', 'final'].includes(mode), 'Choose baseline (offline), verify, or final (online)');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const paths = ['.env', join(root, 'workspace-id'), join(root, 'runtime-release.json'), join(root, 'runtime-release.identity.json'),
  join(root, 'operational-budget', 'identity.json'), join(root, 'operation-verification.identity.json'),
  ...['growth', 'lifecycle', 'environment', 'conversation'].map(name => `.verification/${name}-20260906/model-budget.json`),
  '.verification/operation-20260907/model-budget.json'];
const protect = async () => Promise.all(paths.map(async path => ({ path, sha256: hash(await readFile(path)) })));
await mkdir(directory, { recursive: true });
if (mode === 'baseline') {
  // No service, scheduler, worker or model is instantiated in this offline phase.
  const unlock = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
  try {
    const ownerKey = (await readFile(join(root, 'workspace-id'), 'utf8')).trim();
    const selected = await activeStorage({ rootDir: root, ownerKey, backupDir: process.env.AGENT_BACKUP_DIR! });
    const config = await selectedRuntimeConfig(root, ownerKey, runtimeConfig());
    const containers = await dockerForRelease(config, ['ps', '--filter', 'label=app=agent-company',
      '--filter', `label=agent-company.workspace=${selected.workspaceKey}`, '--format', '{{.ID}}']);
    assert.equal(containers, '');
    const store = await WorkspaceStore.open(join(selected.dataDir, 'db'));
    let state;
    try { state = await store.read(); } finally { await store.close(); }
    assert.ok(state.runs.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status) && !run.cleanupPending));
    assert.equal(state.conversationMessages.flatMap(message => message.deliveries).filter(delivery => delivery.status === 'pending').length, 0);
    assert.equal(state.messages.filter(message => ['pending', 'delivered'].includes(message.status)).length, 0);
    assert.equal(state.modelAttempts.filter(attempt => attempt.status === 'started').length, 0);
    assert.equal(state.repairJobs.length, 0);
    assert.equal(state.environmentRevisions.filter(revision => ['proposed', 'building', 'verifying'].includes(revision.status)).length, 0);
    const ledger = await json(join(root, 'operational-budget', 'ledger.json')); assert.equal(ledger.version, 1);
    await copyFile(join(root, 'operational-budget', 'ledger.json'), join(directory, 'ledger-before.json'), 1);
    await writeFile(join(directory, 'workspace-before.json'), JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    const baseline = { createdAt: new Date().toISOString(), ownerKey, imageId: config.image, protected: await protect(),
      ledgerHash: hash(await readFile(join(directory, 'ledger-before.json'))), dailyLimit: ledger.dailyLimit, revision: ledger.revision,
      starts: ledger.starts.length, unfinished: 0, pendingMessages: 0, runningContainers: 0 };
    await writeFile(join(directory, 'baseline.json'), JSON.stringify(baseline), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(baseline));
  } finally { await unlock(); }
} else {
  const baseline = await json(join(directory, 'baseline.json'));
  assert.deepEqual(await protect(), baseline.protected, 'Environment, runtime selection, identity or historical campaign changed');
  const before = await json(join(directory, 'ledger-before.json'));
  assert.equal(hash(await readFile(join(directory, 'ledger-before.json'))), baseline.ledgerHash);
  const ledger = await json(join(root, 'operational-budget', 'ledger.json'));
  assert.equal(ledger.version, 2); assert.equal(ledger.identity, before.identity); assert.equal(ledger.ownerKey, before.ownerKey);
  assert.equal(hash(await readFile(join(root, 'operational-budget', 'ledger.v1.original.json'))), baseline.ledgerHash);
  assert.equal(ledger.migratedFrom.sha256, baseline.ledgerHash);
  assert.equal(ledger.createdAt, before.createdAt); assert.equal(ledger.dailyLimit, before.dailyLimit);
  assert.equal(ledger.starts.length, before.starts.length, 'This verification must not start a model');
  for (let index = 0; index < before.starts.length; index++) {
    for (const [key, value] of Object.entries(before.starts[index])) assert.deepEqual(ledger.starts[index][key], value);
  }
  for (let index = 0; index < before.changes.length; index++) {
    for (const [key, value] of Object.entries(before.changes[index])) assert.deepEqual(ledger.changes[index][key], value);
  }
  const api = async <T>(path: string): Promise<T> => {
    const response = await fetch('http://127.0.0.1:4310' + path, { signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200); return response.json() as Promise<T>;
  };
  const workspace = await api<Workspace>('/api/workspace'), budget = await api<OperationalBudgetStatus>('/api/model-budget');
  const previousWorkspace = await json(join(directory, 'workspace-before.json'));
  for (const key of ['memories', 'skills', 'snapshots', 'teams', 'projects', 'approvals', 'connections',
    'sharedArtifacts', 'skillRevisions', 'growthReviews', 'repairJobs', 'environmentRevisions'] as const) {
    assert.deepEqual(workspace[key], previousWorkspace[key], `Existing ${key} changed during verification`);
  }
  for (const original of previousWorkspace.runs) {
    const current = workspace.runs.find(run => run.id === original.id)!; assert.ok(current);
    for (const key of ['agentId', 'status', 'result', 'completedAt', 'steering', 'inputTokens', 'outputTokens'] as const) assert.deepEqual(current[key], original[key]);
  }
  assert.deepEqual(workspace.modelAttempts, previousWorkspace.modelAttempts);
  assert.ok(workspace.runs.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status) && !run.cleanupPending));
  assert.ok(workspace.agents.every(agent => agent.status !== 'running'));
  assert.equal(workspace.runtime.image, baseline.imageId);
  assert.equal(budget.used, baseline.starts); assert.equal(budget.dailyLimit, baseline.dailyLimit);
  if (mode === 'verify') assert.equal(budget.revision, baseline.revision);
  if (mode === 'final') {
    assert.ok(Object.values(budget.teamDailyLimits ?? {}).every(limit => limit === null));
    assert.ok(Object.values(budget.agentDailyLimits ?? {}).every(limit => limit === null));
    assert.deepEqual(budget.projectDailyLimits, before.projectDailyLimits);
  }
  const proof = { status: 'passed', checkedAt: new Date().toISOString(), modelStartsAdded: 0,
    budget, originalRunsPreserved: previousWorkspace.runs.length, currentRuns: workspace.runs.length,
    oldPolicyAndChargesPreserved: true, oldCampaignsAndEnvironmentPreserved: true, imageId: workspace.runtime.image };
  await atomicJson(join(directory, mode === 'final' ? 'report.json' : 'migration-report.json'), proof);
  console.log(JSON.stringify(proof));
}
