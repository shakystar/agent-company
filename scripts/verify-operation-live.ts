import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../server/storage.ts';
import type { WorkspaceState } from '../server/store.ts';
import type { Run, Agent } from '../shared/types.ts';
import type { Conversation, ConversationMessage } from '../shared/conversations.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';

// Calls the real operating API. It never opens the user database, substitutes a
// runtime, resets a ledger, or starts another controller. Browser proof is separate.
const directory = resolve('.verification/operation-20260907');
const origin = 'http://127.0.0.1:4310';
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.limit, 10);
const ledger = async () => JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'));
const afterPauseObservation = process.argv.includes('--after-pause-observation');
const previousBytes = afterPauseObservation ? await readFile(join(directory, 'live-report.json')) : null;
const previous = previousBytes ? JSON.parse(previousBytes.toString('utf8')) : null;
if (afterPauseObservation) {
  assert.equal(previous.status, 'failed'); assert.equal(previous.error, 'Error: Unexpected model budget wait: null');
  assert.equal(previous.checks.capIncreasePreservesExplicitPause, true); assert.equal((await ledger()).starts.length, 3);
  await writeFile(join(directory, 'live-report-first.json'), previousBytes!, { flag: 'wx' });
} else assert.equal((await ledger()).starts.length, 0, 'This one-shot scenario cannot replay prior model starts. Preserve and inspect its report.');
const keys: Record<string, string> = afterPauseObservation ? JSON.parse(await readFile(join(directory, 'live-plan.json'), 'utf8')).keys
  : Object.fromEntries(['room-p', 'room-q', 'auto', 'discuss', 'peer-start', 'forward', 'reply', 'operator-reply', 'cancel'].map(key => [key, randomUUID()]));
if (!afterPauseObservation) await writeFile(join(directory, 'live-plan.json'), JSON.stringify({ createdAt: new Date().toISOString(), keys, origin }, null, 2), { flag: 'wx' });
const checks: Record<string, boolean> = previous?.checks ?? {};
const evidence: Record<string, unknown> = previous?.evidence ?? {};
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
const state = () => api<WorkspaceState>('/api/workspace');
const budget = () => api<OperationalBudgetStatus>('/api/model-budget');
async function save(status: string, error: string | null = null) {
  await atomicJson(join(directory, 'live-report.json'), { status, updatedAt: new Date().toISOString(), origin, checks, evidence,
    campaign: await ledger(), budget: await budget(), error });
}
async function check(name: string, value: unknown = true) {
  assert.ok(value, name); checks[name] = true; console.log(JSON.stringify({ check: name, status: 'passed' })); await save('running');
}
async function waitFor<T>(name: string, predicate: (current: WorkspaceState) => T | false | undefined): Promise<T> {
  const deadline = Date.now() + 15 * 60_000; let nextLog = 0;
  for (;;) {
    const current = await state(), value = predicate(current); if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${name}`);
    if (Date.now() > nextLog) { console.log(JSON.stringify({ waiting: name, models: (await ledger()).starts.length })); nextLog = Date.now() + 15_000; }
    await delay(750);
  }
}
async function runFor(messageId: string) {
  return waitFor('delivery', current => {
    const id = current.conversationMessages.find(message => message.id === messageId)?.deliveries.find(item => item.runId)?.runId;
    return current.runs.find(run => run.id === id || run.conversationMessageId === messageId);
  });
}
async function finished(runId: string) {
  return waitFor('completion', current => {
    const run = current.runs.find(item => item.id === runId)!;
    if (['failed', 'cancelled'].includes(run.status)) throw new Error(`Run ${run.status}: ${run.error}`);
    // A just-resumed run may retain its old budget marker until reconciliation.
    // Only an exhausted independent verification gate is terminal here.
    if (run.modelBudgetPaused && !run.modelBudgetBlock) throw new Error(`Verification budget wait: ${run.error}`);
    return run.status === 'succeeded' && !run.cleanupPending && current.agents.find(agent => agent.id === run.agentId)?.status === 'idle' ? run : false;
  });
}
async function blocked(runId: string) {
  return waitFor('project budget wait', current => {
    const run = current.runs.find(item => item.id === runId)!;
    if (['failed', 'cancelled', 'succeeded'].includes(run.status)) throw new Error(`Expected wait, got ${run.status}: ${run.error}`);
    return run.modelBudgetPaused && run.modelBudgetBlock?.blockedBy === 'project' && !run.cleanupPending ? run : false;
  });
}
async function cap(projectId: string, limit: number | null) {
  const before = await budget();
  return api<OperationalBudgetStatus>('/api/model-budget', { expectedRevision: before.revision, projectDailyLimits: { [projectId]: limit } }, 'PATCH');
}
const noGrowth = 'Controlled functional verification, not a growth benchmark. Return memories, skills, skillConcerns and artifacts as empty arrays and environmentProposal as null. No autonomous goals or unrequested peer work.';
async function send(room: Conversation, key: string, content: string, mode: 'auto' | 'discuss' | 'task', recipientAgentId: string, replyToId?: string) {
  return api<ConversationMessage>(`/api/conversations/${room.id}/messages`, { content: `${noGrowth}\n${content}`, mode, recipientAgentId,
    idempotencyKey: keys[key], ...(replyToId ? { replyToId } : {}) });
}
try {
  const initial = await state(); assert.equal(initial.runs.length, afterPauseObservation ? 2 : 0, 'Unexpected user workspace changes');
  const initialBudget = await budget(); assert.equal(initialBudget.dailyLimit, 100); assert.equal(initialBudget.used, afterPauseObservation ? 3 : 0);
  const agents: Agent[] = [];
  for (const suffix of ['A', 'B']) agents.push(afterPauseObservation ? initial.agents.find(agent => agent.name === `운영 검증 ${suffix}`)!
    : await api<Agent>('/api/agents', { name: `운영 검증 ${suffix}`, model: 'gpt-6-astra',
      description: '2026-09-07 실사용 통합 검증 기록입니다.', persona: `${noGrowth} Use actual tool results. Report measured outcomes only.` }));
  const [a, b] = agents;
  const team = afterPauseObservation ? initial.teams.find(team => team.name === '운영 검증 협력팀')!
    : await api<{ id: string }>('/api/teams', { name: '운영 검증 협력팀', memberIds: [a.id, b.id], workflow: '참여자는 협력 동료입니다. 요청된 검증만 수행하며 결과를 실제 공동 대화에 공유합니다.' });
  const projects = [];
  for (const name of ['운영 검증 P', '운영 검증 Q']) projects.push(afterPauseObservation ? initial.projects.find(project => project.name === name)!
    : await api<{ id: string }>('/api/collaboration/project_create', { name, teamIds: [team.id] }));
  const [p, q] = projects;
  const roomP = await api<Conversation>('/api/conversations', { scope: { type: 'project', id: p.id }, title: '운영 검증 P 작업실', idempotencyKey: keys['room-p'] });
  const roomQ = await api<Conversation>('/api/conversations', { scope: { type: 'project', id: q.id }, title: '운영 검증 Q 작업실', idempotencyKey: keys['room-q'] });
  evidence.entities = { agents: agents.map(agent => agent.id), teamId: team.id, projects: [p.id, q.id], rooms: [roomP.id, roomQ.id] };
  const nonce = manifest.ownerKey;
  let automaticRun: Run;
  if (!afterPauseObservation) {
  await cap(p.id, 0);
  const automatic = await send(roomP, 'auto', `Create the actual file operation-proof.json containing exactly ${JSON.stringify({ nonce, value: 5 })}. Read it back using the shell. Set final result exactly operation-file-ok.`, 'auto', a.id);
  automaticRun = await runFor(automatic.id); await blocked(automaticRun.id);
  await check('projectZeroBlocksBeforeFirstModel', (await ledger()).starts.length === 0);
  const discussion = await send(roomQ, 'discuss', 'Discussion only: calculate 2 + 3. Do not change files or call other agents. Set final result exactly discussion-ok:5.', 'discuss', b.id);
  const discussionRun = await finished((await runFor(discussion.id)).id);
  assert.equal(discussionRun.result.trim(), 'discussion-ok:5');
  await check('otherProjectRunsWhilePWaits', (await ledger()).starts.length === 1);
  await cap(p.id, 1);
  await waitFor('automatic routing decision', current => current.runs.find(run => run.id === automaticRun.id && run.interactionMode === 'task'));
  await blocked(automaticRun.id);
  await check('automaticRouterConsumesOneStart', (await ledger()).starts.length === 2);
  const paused = await api<Run>(`/api/runs/${automaticRun.id}/pause`, {}); assert.equal(paused.status, 'paused');
  await cap(p.id, 2); await delay(2000);
  assert.equal((await state()).runs.find(run => run.id === automaticRun.id)?.status, 'paused');
  await check('capIncreasePreservesExplicitPause', (await ledger()).starts.length === 2);
  await api(`/api/runs/${automaticRun.id}/continue`, {});
  } else {
    const message = initial.conversationMessages.find(message => message.idempotencyKey === keys.auto)!;
    automaticRun = await runFor(message.id);
    assert.equal(automaticRun.status, 'succeeded'); assert.equal(automaticRun.result.trim(), 'operation-file-ok');
    assert.equal(automaticRun.budgetProjectId, p.id); assert.equal(initialBudget.projects.find(project => project.projectId === p.id)?.limit, 2);
    evidence.observationCorrection = 'Initial verifier treated a transient pre-reconciliation budget marker as terminal; original failed report retained. Completed model work was not replayed.';
  }
  const completed = await finished(automaticRun.id); assert.equal(completed.result.trim(), 'operation-file-ok');
  const fileResponse = await fetch(`${origin}/api/agents/${a.id}/files/download?path=operation-proof.json`);
  assert.equal(fileResponse.status, 200); const fileText = await fileResponse.text(); assert.deepEqual(JSON.parse(fileText), { nonce, value: 5 });
  evidence.file = { agentId: a.id, path: 'operation-proof.json', text: fileText, runId: automaticRun.id };
  await check('sameRunResumesAndWritesActualFile', (await ledger()).starts.length === 3);
  await cap(p.id, 8);
  const peerRequest = `${noGrowth}\nThe user authorized this team test. This is teammate A requesting one reply. Call conversation_send with conversationId=${roomP.id}, recipientAgentId=${a.id}, mode=discuss, idempotencyKey=${keys.reply}, content="peer-response:${nonce}" exactly once, then final result peer-b-ok. Do not send other messages.`;
  const teamMessage = await send(roomP, 'peer-start', `The user authorizes one team round trip. Call conversation_send with conversationId=${roomP.id}, recipientAgentId=${b.id}, mode=task, idempotencyKey=${keys.forward}, content=${JSON.stringify(peerRequest)}. Actually call it once, then final result peer-a-sent. If the reply arrives later, answer it without sending another peer request.`, 'task', a.id);
  const peerRoot = (await runFor(teamMessage.id)).id; await finished(peerRoot);
  const forwarded = await waitFor('peer forward', current => current.conversationMessages.find(message => message.idempotencyKey === keys.forward));
  assert.equal(forwarded.senderAgentId, a.id); const forwardRun = await finished((await runFor(forwarded.id)).id);
  const replied = await waitFor('peer reply', current => current.conversationMessages.find(message => message.idempotencyKey === keys.reply));
  assert.equal(replied.senderAgentId, b.id); assert.equal(replied.content, `peer-response:${nonce}`);
  const replyRun = await finished((await runFor(replied.id)).id);
  for (const run of [forwardRun, replyRun]) { assert.equal(run.budgetProjectId, p.id); assert.equal(run.budgetRootRunId, peerRoot); }
  evidence.peer = { rootRunId: peerRoot, forwardMessageId: forwarded.id, replyMessageId: replied.id, runs: [forwardRun.id, replyRun.id] };
  await check('actualPeerRoundTripPreservesRootProject');
  const intervention = await send(roomP, 'operator-reply', 'The operator has joined this same real conversation. Reply exactly operator-joined-ok. Do not start another peer request.', 'discuss', b.id, replied.id);
  const interventionRun = await finished((await runFor(intervention.id)).id); assert.equal(interventionRun.result.trim(), 'operator-joined-ok');
  await check('operatorRepliesInActualAgentConversation', interventionRun.conversationId === roomP.id && interventionRun.budgetProjectId === p.id);
  await cap(p.id, 0);
  const cancelMessage = await send(roomP, 'cancel', 'This request will be cancelled before admission. Do not create files.', 'task', a.id);
  const cancelRun = await runFor(cancelMessage.id); await blocked(cancelRun.id); const beforeCancel = (await ledger()).starts.length;
  await api(`/api/runs/${cancelRun.id}/cancel`, {}); await cap(p.id, null); await delay(2000);
  assert.equal((await state()).runs.find(run => run.id === cancelRun.id)?.status, 'cancelled');
  await check('capIncreasePreservesCancellation', (await ledger()).starts.length === beforeCancel);
  const final = await state(), finalBudget = await budget();
  assert.equal(finalBudget.dailyLimit, 100); assert.equal(finalBudget.projects.find(project => project.projectId === p.id)?.limit, null);
  assert.equal(finalBudget.used, (await ledger()).starts.length);
  assert.equal(finalBudget.projects.find(project => project.projectId === q.id)?.used, 1);
  assert.equal(finalBudget.projects.find(project => project.projectId === p.id)?.used, finalBudget.used - 1);
  assert.equal(final.runs.filter(run => !['succeeded', 'cancelled', 'failed'].includes(run.status)).length, 0);
  assert.equal(final.memories.length + final.skills.length + final.environmentRevisions.length, 0);
  evidence.runs = final.runs; evidence.modelAttempts = final.modelAttempts;
  await check('operationalAndCampaignLedgersMatch'); await check('approvedDefaultsRestoredWithoutReset'); await check('noUnrequestedGrowthOrUnfinishedWork');
  await save('passed'); console.log(JSON.stringify({ status: 'passed', starts: (await ledger()).starts.length, limit: 10 }));
} catch (error) {
  await save('failed', String(error)); console.error(error); process.exitCode = 1;
}
