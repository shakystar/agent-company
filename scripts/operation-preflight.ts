import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import lockfile from 'proper-lockfile';
import { WorkspaceStore } from '../server/store.ts';
import { activeStorage, atomicJson } from '../server/storage.ts';
import { runtimeConfig } from '../server/runtime.ts';
import { dockerForRelease, selectedRuntimeConfig } from '../server/releases.ts';

// Offline state inspection only: no service, runtime.execute, scheduler, or model.
loadEnvFile('.env');
const root = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const unlock = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
try {
  const ownerKey = (await readFile(join(root, 'workspace-id'), 'utf8')).trim();
  const selected = await activeStorage({ rootDir: root, ownerKey, backupDir: process.env.AGENT_BACKUP_DIR! });
  const store = await WorkspaceStore.open(join(selected.dataDir, 'db'));
  let state;
  try { state = await store.read(); } finally { await store.close(); }
  const config = await selectedRuntimeConfig(root, ownerKey, runtimeConfig());
  const containers = await dockerForRelease(config, ['ps', '--filter', 'label=app=agent-company',
    '--filter', `label=agent-company.workspace=${selected.workspaceKey}`, '--format', '{{.ID}}']);
  assert.equal(containers, '');
  const unfinished = state.runs.filter(run => !['succeeded', 'failed', 'cancelled'].includes(run.status) || run.cleanupPending);
  assert.equal(unfinished.length, 0);
  assert.equal(state.modelAttempts.filter(attempt => attempt.status === 'started').length, 0);
  assert.equal(state.conversationMessages.flatMap(message => message.deliveries).filter(delivery => delivery.status === 'pending').length, 0);
  assert.equal(state.messages.filter(message => message.status === 'pending' || message.status === 'delivered').length, 0);
  assert.equal(state.environmentRevisions.filter(revision => ['proposed', 'building', 'verifying'].includes(revision.status)).length, 0);
  assert.equal(state.repairJobs.length, 0);
  const proof = { checkedAt: new Date().toISOString(), ownerKey, imageId: config.image, ownedRunningContainers: 0,
    unfinishedRuns: 0, pendingConversationDeliveries: 0, pendingPeerMessages: 0, repairJobs: 0,
    runs: state.runs.map(({ id, status, cleanupPending }) => ({ id, status, cleanupPending })),
    agents: state.agents.map(({ id, status }) => ({ id, status })),
    campaign: JSON.parse(await readFile('.verification/operation-20260907/model-budget.json', 'utf8')) };
  await atomicJson('.verification/operation-20260907/preflight.json', proof);
  console.log(JSON.stringify(proof));
} finally { await unlock(); }
