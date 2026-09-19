import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../server/storage.ts';
import { runtimeConfig } from '../server/runtime.ts';
import { dockerForRelease, selectedRuntimeConfig, resolveImage } from '../server/releases.ts';
import type { Workspace } from '../shared/types.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';

loadEnvFile('.env');
const directory = resolve('.verification/operation-20260907');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const baseline = await json(join(directory, 'baseline.json'));
const manifest = await json(join(directory, 'manifest.json'));
const live = await json(join(directory, 'live-report.json')); assert.equal(live.status, 'passed');
const cancellation = await json(join(directory, 'cancel-report.json')); assert.equal(cancellation.status, 'passed');
const campaign = await json(join(directory, 'model-budget.json'));
assert.ok(campaign.starts.length <= 10); assert.equal(campaign.starts.length, live.campaign.starts.length);
assert.equal(digest(await readFile('.env')), baseline.environmentHash);
assert.equal((await readFile('.data/workspace-id', 'utf8')).trim(), baseline.ownerKey);
for (const file of baseline.files) assert.equal(digest(await readFile(join(directory, 'baseline-data', file.path))), file.sha256);
for (const file of manifest.protectedFiles) assert.equal(digest(await readFile(file.path)), file.sha256);
async function api<T>(path: string): Promise<T> {
  const response = await fetch('http://127.0.0.1:4310' + path, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200); return response.json() as Promise<T>;
}
const workspace = await api<Workspace>('/api/workspace');
const budget = await api<OperationalBudgetStatus>('/api/model-budget');
assert.equal(workspace.runtime.available, true); assert.equal(workspace.runtime.authenticated, true);
assert.equal(workspace.runtime.simulation, undefined); assert.equal(budget.used, campaign.starts.length);
assert.equal(budget.dailyLimit, 100); assert.equal(budget.waiting.length, 0);
assert.ok(budget.projects.every(project => project.limit === null));
assert.ok(workspace.runs.every(run => ['succeeded', 'cancelled'].includes(run.status) && !run.cleanupPending));
assert.ok(workspace.agents.every(agent => agent.status === 'idle'));
assert.equal(workspace.runs.length, live.evidence.runs.length + 1);
assert.equal(workspace.runs.find(run => run.id === cancellation.runId)?.status, 'cancelled');
const config = await selectedRuntimeConfig(resolve('.data'), baseline.ownerKey, runtimeConfig());
assert.equal(config.image, manifest.imageId);
assert.equal(await resolveImage(config, baseline.imageId), baseline.imageId);
let containers = '';
for (let observation = 0; observation < 10; observation += 1) {
  containers = await dockerForRelease(config, ['ps', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${baseline.ownerKey}`, '--format', '{{.ID}}']);
  if (!containers) break;
  // A periodic inventory helper may exist briefly even when all workers are idle.
  // Observe a quiet boundary; never stop a container to satisfy the assertion.
  await delay(1000);
}
assert.equal(containers, '');
const storage = await api<Record<string, unknown>>('/api/storage');
const disk = await statfs('.');
const proof = { checkedAt: new Date().toISOString(), campaign, budget, imageId: config.image, previousImagePreserved: baseline.imageId,
  environmentPreserved: true, baselineFilesVerified: baseline.files.length, historicalLedgersPreserved: true, ownedRunningContainers: 0,
  runs: workspace.runs.map(({ id, status, result, budgetProjectId, budgetRootRunId }) => ({ id, status, result, budgetProjectId, budgetRootRunId })),
  modelAttempts: workspace.modelAttempts, cancellation, storage, freeDiskBytes: disk.bavail * disk.bsize,
  browser: { status: 'blocked', error: 'ERR_BLOCKED_BY_CLIENT', note: 'Actual operating UI not verified; no security bypass.' } };
if (process.argv.includes('--after-restart')) {
  const before = await json(join(directory, 'before-restart.json'));
  assert.deepEqual(proof.campaign, before.campaign); assert.deepEqual(proof.budget, before.budget);
  assert.deepEqual(proof.runs, before.runs); assert.deepEqual(proof.modelAttempts, before.modelAttempts);
  await atomicJson(join(directory, 'report.json'), { status: 'api-model-passed-browser-blocked', normalOperationRestartVerified: true, ...proof });
} else await atomicJson(join(directory, 'before-restart.json'), proof);
console.log(JSON.stringify({ models: campaign.starts.length, limit: 10, dailyRemaining: budget.remaining, runs: proof.runs.length,
  imageId: config.image, ownedRunningContainers: 0, freeDiskBytes: proof.freeDiskBytes, afterRestart: process.argv.includes('--after-restart') }));
