import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { createApp } from '../server/app.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import { command } from '../server/process.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { atomicJson, secureDirectory } from '../server/storage.ts';
import type { WorkspaceState } from '../server/store.ts';
import type { Agent, Run } from '../shared/types.ts';
import type { Conversation, ConversationMessage } from '../shared/conversations.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';

const directory = resolve('.verification/conversation-20260906');
const imageTag = 'agent-company-worker:workroom-20260906';
const imageId = 'sha256:0b329c8e2a5e64c4720f41679d0487dfbe382ee0f98fb2a9a14551a759c07210';
const maximum = 8;
const prior = [
  { path: '.verification/growth-20260906/model-budget.json', starts: 9, limit: 10 },
  { path: '.verification/lifecycle-20260906/model-budget.json', starts: 20, limit: 20 },
  { path: '.verification/environment-20260906/model-budget.json', starts: 4, limit: 100 },
];
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function regular(path: string) {
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.size <= 8 * 1024 * 1024, 'Evidence must be a bounded independent file');
  return readFile(path);
}
async function previousLedgers() {
  return Promise.all(prior.map(async expected => {
    const bytes = await regular(resolve(expected.path)), parsed = JSON.parse(bytes.toString('utf8'));
    assert.equal(parsed.version, 1); assert.equal(parsed.limit, expected.limit); assert.equal(parsed.starts.length, expected.starts);
    return { path: expected.path, sha256: hash(bytes) };
  }));
}
interface Manifest {
  version: 1; limit: 8; workspaceKey: string; createdAt: string; imageId: string;
  previousLedgers: Array<{ path: string; sha256: string }>; environmentHash: string;
  ids: Record<string, string>;
}
if (existsSync('.env')) loadEnvFile('.env');
const originalConfig = runtimeConfig();
assert.equal(originalConfig.mode, 'docker'); assert.equal(originalConfig.auth, 'codex');
assert.equal(originalConfig.model, 'gpt-6-astra'); assert.equal(originalConfig.persistentWorkspaces, true);
await secureDirectory(directory);
const release = await lockfile.lock(join(directory, 'controller'), { realpath: false,
  lockfilePath: join(directory, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
let manifest: Manifest;
try {
  if (existsSync(join(directory, 'manifest.json'))) {
    manifest = JSON.parse((await regular(join(directory, 'manifest.json'))).toString('utf8'));
    assert.equal(manifest.version, 1); assert.equal(manifest.limit, maximum); assert.equal(manifest.imageId, imageId);
    assert.match(manifest.workspaceKey, /^[a-f0-9-]{36}$/i); await regular(join(directory, 'model-budget.json'));
  } else {
    assert.equal(existsSync(join(directory, 'model-budget.json')), false, 'Never reset a pre-existing campaign ledger');
    manifest = { version: 1, limit: maximum, workspaceKey: randomUUID(), imageId, createdAt: new Date().toISOString(),
      previousLedgers: await previousLedgers(), environmentHash: hash(await regular(resolve('.env'))),
      ids: Object.fromEntries(['personal-room', 'team-room', 'discussion', 'automatic', 'team-start', 'team-forward', 'team-reply', 'pause', 'pause-steer'].map(key => [key, randomUUID()])) };
    await writeFile(join(directory, 'model-budget.json'), JSON.stringify({ version: 1, limit: maximum, starts: [] }, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  }
} catch (error) { await release(); throw error; }
class ConversationBudget extends FileModelBudget {
  override async reserve(request: ModelStartRequest) {
    await regular(join(directory, 'model-budget.json'));
    assert.deepEqual(JSON.parse((await regular(join(directory, 'manifest.json'))).toString('utf8')), manifest);
    assert.deepEqual(await previousLedgers(), manifest.previousLedgers, 'Historical ledgers changed');
    assert.equal(hash(await regular(resolve('.env'))), manifest.environmentHash, 'Operational environment changed');
    await super.reserve(request);
    console.log(JSON.stringify({ type: 'model_start', ...request, sequence: (await this.read()).starts.length, limit: maximum }));
  }
}
const budget = new ConversationBudget(directory, maximum);
const config = { ...originalConfig, image: imageId, workspaceKey: manifest.workspaceKey };
async function docker(args: string[]) {
  const result = await command(config.wslDistro ? 'wsl.exe' : 'docker', config.wslDistro
    ? ['--distribution', config.wslDistro, '--exec', 'docker', ...args] : args, { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Scoped Docker command failed (${args[0]}): ${result.stderr.slice(-1500)}`);
  return result.stdout.trim();
}
let app: Awaited<ReturnType<typeof createApp>> | undefined, origin = '';
let stateAtEnd: WorkspaceState | undefined;
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
let failure: string | null = null;
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
const state = () => api<WorkspaceState>('/api/workspace');
async function waitFor<T>(description: string, condition: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + 15 * 60_000; let lastLog = 0;
  for (;;) {
    const value = await condition(); if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Verification timeout: ${description}`);
    if (Date.now() - lastLog > 15_000) { console.log(JSON.stringify({ type: 'waiting', scenario: description })); lastLog = Date.now(); }
    await delay(400);
  }
}
async function runFor(messageId: string) {
  return waitFor('message delivery', async () => {
    const current = await state();
    const deliveredRun = current.conversationMessages.find(message => message.id === messageId)?.deliveries.find(delivery => delivery.runId)?.runId;
    return current.runs.find(run => run.id === deliveredRun || run.conversationMessageId === messageId);
  });
}
async function finished(runId: string) {
  return waitFor('run completion', async () => {
    const current = await state(), run = current.runs.find(item => item.id === runId)!;
    assert.ok(run); if (run.modelBudgetPaused) throw new Error('Model-start ceiling reached; state preserved');
    if (run.status === 'failed' || run.status === 'cancelled') throw new Error(`Run ${run.status}: ${run.error}`);
    return run.status === 'succeeded' && current.agents.find(agent => agent.id === run.agentId)?.status === 'idle' ? run : null;
  });
}
async function getAgent(name: string): Promise<Agent> {
  return (await state()).agents.find(agent => agent.name === name) ?? api<Agent>('/api/agents', { name,
    persona: 'Controlled conversation integration fixture. Use only actual tool responses and report measured outcomes. No autonomous goals, growth or environment proposals.', model: 'gpt-6-astra' });
}
async function send(conversationId: string, key: string, content: string, mode: 'discuss' | 'auto' | 'task', recipientAgentId?: string) {
  return api<ConversationMessage>(`/api/conversations/${conversationId}/messages`, { content, mode, idempotencyKey: manifest.ids[key], ...(recipientAgentId ? { recipientAgentId } : {}) });
}
async function file(agentId: string, path: string) {
  const response = await fetch(`${origin}/api/agents/${agentId}/files/download?path=${encodeURIComponent(path)}`);
  assert.equal(response.status, 200, `Missing measured file ${path}`); return response.text();
}
const noGrowth = 'This is a controlled functional verification fixture, not a natural-growth benchmark. Return memories, skills, skillConcerns and artifacts as empty arrays and environmentProposal as null. Do not create unrelated goals or peer work.';
try {
  assert.deepEqual(await previousLedgers(), manifest.previousLedgers);
  assert.equal(hash(await regular(resolve('.env'))), manifest.environmentHash);
  const operationalImage = await docker(['image', 'inspect', originalConfig.image, '--format', '{{.Id}}']);
  evidence.operationalImageBefore = operationalImage;
  assert.equal(await docker(['image', 'inspect', imageTag, '--format', '{{.Id}}']), imageId);
  const workerFiles = ['entry.mjs', 'principles.mjs', 'team-mcp.mjs', 'workspace.mjs', 'storage.mjs', 'growth.mjs', 'environment.mjs', 'npm-empty.npmrc'];
  const sourceInspection = await docker(['run', '--rm', '--name', `ac-conversation-source-${manifest.workspaceKey.slice(0, 8)}`,
    '--label', 'app=agent-company', '--label', `agent-company.workspace=${manifest.workspaceKey}`, '--read-only', '--network=none',
    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=64m', '--pids-limit=32',
    '--entrypoint=sha256sum', imageId, ...workerFiles.map(path => `/app/${path}`)]);
  const hashes = [];
  for (const path of workerFiles) {
    const sha256 = hash(await regular(resolve('worker', path)));
    assert.ok(sourceInspection.split('\n').some(line => line.trim() === `${sha256}  /app/${path}`), `Image source differs: ${path}`);
    hashes.push({ path: `worker/${path}`, sha256 });
  }
  evidence.workerSourceHashes = hashes; checks.imageSourcesMatch = true;
  app = await createApp({ dataDir: join(directory, 'data', 'db'), runtime: new ContainerRuntime(config),
    storage: { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: manifest.workspaceKey },
    beforeModelStart: request => budget.reserve(request) });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  console.log(JSON.stringify({ type: 'ready', origin, directory, workspaceKey: manifest.workspaceKey, imageId }));
  checks.apiHealthy = (await api<{ status: string }>('/api/health')).status === 'ok';
  const personal = await getAgent('Conversation live personal');
  const personalRoom = await api<Conversation>('/api/conversations', { scope: { type: 'agent', id: personal.id }, title: 'Live personal workroom', idempotencyKey: manifest.ids['personal-room'] });
  const discussion = await send(personalRoom.id, 'discussion', `${noGrowth}\nThis is a discussion only. Briefly explain what 2 + 3 equals. Do not write files. Set final result exactly to discussion-ok:5.`, 'discuss');
  const discussionRun = await finished((await runFor(discussion.id)).id);
  assert.equal(discussionRun.result.trim(), 'discussion-ok:5');
  const personalAfterDiscussion = (await state()).agents.find(agent => agent.id === personal.id)!;
  assert.equal(personalAfterDiscussion.workspaceRunId, undefined); checks.readOnlyDiscussion = true;
  const nonce = manifest.workspaceKey;
  const automatic = await send(personalRoom.id, 'automatic', `${noGrowth}\nCreate the actual workspace file workroom-proof.json containing exactly ${JSON.stringify({ nonce, value: 5 })}. Read it back using the shell and report actual completion. Set final result exactly to automatic-work-ok.`, 'auto');
  const automaticRun = await finished((await runFor(automatic.id)).id);
  assert.equal(automaticRun.result.trim(), 'automatic-work-ok'); assert.equal(automaticRun.interactionMode, 'task');
  assert.deepEqual(JSON.parse(await file(personal.id, 'workroom-proof.json')), { nonce, value: 5 });
  checks.automaticSameRunTask = true; checks.realFileWrite = true;
  assert.ok((await state()).modelAttempts.filter(attempt => attempt.runId === automaticRun.id).length >= 2);

  const first = await getAgent('Conversation live teammate A'), second = await getAgent('Conversation live teammate B');
  const team = (await state()).teams.find(team => team.name === 'Conversation live peers')
    ?? await api<{ id: string }>('/api/teams', { name: 'Conversation live peers', memberIds: [first.id, second.id] });
  const teamRoom = await api<Conversation>('/api/conversations', { scope: { type: 'team', id: team.id }, title: 'Live cooperative workroom', idempotencyKey: manifest.ids['team-room'] });
  const peerRequest = `${noGrowth}\nThe user explicitly authorized this controlled team communication test. This is teammate A asking you to reply. Call conversation_send with conversationId=${teamRoom.id}, recipientAgentId=${first.id}, mode=discuss, idempotencyKey=${manifest.ids['team-reply']}, content="peer-response:${nonce}". Actually call the tool exactly once, then final result is peer-b-ok. Do not send any other messages.`;
  const teamMessage = await send(teamRoom.id, 'team-start', `${noGrowth}\nThis user explicitly authorizes one team communication round trip. Call conversation_send with conversationId=${teamRoom.id}, recipientAgentId=${second.id}, mode=task, idempotencyKey=${manifest.ids['team-forward']}, content=${JSON.stringify(peerRequest)}. Actually call the tool; do not simulate it. End this turn after the successful call with final result exactly peer-a-sent. If the reply arrives as a later message, answer it once without sending another peer request.`, 'task', first.id);
  await finished((await runFor(teamMessage.id)).id);
  const peerDelivery = await waitFor('peer request delivery', async () => (await state()).conversationMessages.find(message => message.idempotencyKey === manifest.ids['team-forward']));
  assert.equal(peerDelivery.senderAgentId, first.id); assert.ok(peerDelivery.sourceRunId);
  await finished((await runFor(peerDelivery.id)).id);
  const peerReply = await waitFor('peer response', async () => (await state()).conversationMessages.find(message => message.idempotencyKey === manifest.ids['team-reply']));
  assert.equal(peerReply.senderAgentId, second.id); assert.equal(peerReply.content, `peer-response:${nonce}`); assert.ok(peerReply.sourceRunId);
  const replyRun = await finished((await runFor(peerReply.id)).id);
  assert.equal(replyRun.agentId, first.id); assert.equal(replyRun.conversationId, teamRoom.id);
  checks.actualPeerToolRoundTrip = true; checks.peerReplyDeliveredToRealAgent = true;

  const pauseMessage = await send(personalRoom.id, 'pause', `${noGrowth}\nCreate pause-proof.txt in your actual workspace using Python exclusive creation mode x, containing exactly ${JSON.stringify(nonce)}. In the same Python command sleep for 4 seconds after writing, then print pause-file-created. Do this single command once. Set final result to pause-initial-ok.`, 'task');
  const pauseRun = await runFor(pauseMessage.id);
  let paused = (await state()).runs.find(run => run.id === pauseRun.id)!;
  if (!['paused', 'succeeded'].includes(paused.status)) {
    await waitFor('pause command boundary', async () => {
      const current = await state(), run = current.runs.find(item => item.id === pauseRun.id)!;
      if (run.status === 'failed' || run.status === 'succeeded') throw new Error(`Pause observation missed command boundary: ${run.status}`);
      return current.activities.some(item => item.runId === run.id && item.detail.includes('command_execution'));
    });
    const requested = await api<Run>(`/api/runs/${pauseRun.id}/pause`, {});
    assert.ok(requested.pauseRequestedAt);
    paused = await waitFor('durable operator pause', async () => {
      const run = (await state()).runs.find(item => item.id === pauseRun.id)!;
      if (run.status === 'failed' || run.status === 'cancelled') throw new Error(`Pause failed: ${run.error}`);
      return run.status === 'paused' && !run.cleanupPending ? run : null;
    });
  }
  if (paused.status === 'paused') {
    const beforeResume = await budget.read();
    await delay(500); assert.equal((await state()).runs.find(run => run.id === pauseRun.id)?.status, 'paused');
    // Resume the saved task result without adding another model turn. Completed
    // work must not be replayed merely because the operator pressed continue.
    await api(`/api/runs/${pauseRun.id}/continue`, {});
    await finished(pauseRun.id);
    assert.equal((await budget.read()).starts.length, beforeResume.starts.length);
  } else {
    const activities = (await state()).activities.filter(item => item.runId === pauseRun.id);
    assert.ok(activities.some(item => item.title === '작업 일시정지') && activities.some(item => item.title === '사용자 작업 재개'), 'A completed task is not evidence of operator pause');
  }
  assert.equal(await file(personal.id, 'pause-proof.txt'), nonce);
  checks.pauseBoundaryAndResumeWithoutReplay = true;
  stateAtEnd = await state();
  assert.equal(stateAtEnd.memories.length, 0); assert.equal(stateAtEnd.skills.length, 0);
  assert.equal(stateAtEnd.environmentRevisions.length, 0);
  checks.noUnrequestedGrowth = true;
  evidence.runs = stateAtEnd.runs.map(({ id, agentId, conversationId, interactionMode, status, appliedSteeringCount, result, inputTokens, outputTokens }) =>
    ({ id, agentId, conversationId, interactionMode, status, appliedSteeringCount, result, inputTokens, outputTokens }));
  evidence.messages = stateAtEnd.conversationMessages.filter(message => message.sourceRunId).map(({ id, conversationId, senderAgentId, sourceRunId, sourcePeerMessageId, deliveries }) =>
    ({ id, conversationId, senderAgentId, sourceRunId, sourcePeerMessageId, deliveries }));
  evidence.modelAttempts = stateAtEnd.modelAttempts;
  assert.equal(await docker(['image', 'inspect', originalConfig.image, '--format', '{{.Id}}']), operationalImage);
  checks.operationalImageUnchanged = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ type: 'verification_error', message: failure }));
} finally {
  try { if (app) { stateAtEnd ??= await state(); await app.close(); app = undefined; } }
  catch (error) { failure ??= `Controller cleanup: ${error instanceof Error ? error.message : String(error)}`; }
  try {
    const remaining = await docker(['ps', '-a', '--filter', 'label=app=agent-company', '--filter', `label=agent-company.workspace=${manifest.workspaceKey}`, '--format', '{{.Names}}']);
    evidence.remainingOwnedContainers = remaining ? remaining.split('\n') : [];
    assert.equal(remaining, '', 'Owned verification workers remain after close'); checks.workerCleanup = true;
    assert.deepEqual(await previousLedgers(), manifest.previousLedgers); checks.historicalLedgersUnchanged = true;
    assert.equal(hash(await regular(resolve('.env'))), manifest.environmentHash); checks.operationalEnvironmentUnchanged = true;
    if (evidence.operationalImageBefore) {
      assert.equal(await docker(['image', 'inspect', originalConfig.image, '--format', '{{.Id}}']), evidence.operationalImageBefore);
      checks.operationalImageUnchanged = true;
    }
  } catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
  const ledger = await budget.read();
  const report = { status: failure ? 'failed' : 'passed', observedAt: new Date().toISOString(), workspaceKey: manifest.workspaceKey,
    imageTag, imageId, modelStarts: ledger.starts.length, limit: maximum, checks, error: failure, evidence,
    finalRuns: stateAtEnd?.runs.map(({ id, status, error, modelBudgetPaused }) => ({ id, status, error, modelBudgetPaused })) ?? [],
    actualScope: 'API + Docker + existing ChatGPT login; controlled fixture, not visual or natural-growth verification' };
  await atomicJson(join(directory, `report-${Date.now()}.json`), report); await atomicJson(join(directory, 'report.json'), report);
  await release(); console.log(JSON.stringify({ type: 'finished', status: report.status, modelStarts: ledger.starts.length, limit: maximum, checks, error: failure }));
  if (failure) process.exitCode = 1;
}
