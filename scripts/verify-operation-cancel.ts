import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../server/storage.ts';
import type { Workspace } from '../shared/types.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';
import type { ConversationMessage } from '../shared/conversations.ts';

// Regression from the live campaign: cancelling a settled budget waiter must
// release its agent as well as its run. The project cap prevents any model start.
const root = '.verification/operation-20260907';
const read = async (name: string) => JSON.parse(await readFile(`${root}/${name}`, 'utf8'));
const live = await read('live-report.json'); assert.equal(live.status, 'passed');
const ledgerBefore = await read('model-budget.json'); assert.equal(ledgerBefore.starts.length, 7);
const entities = live.evidence.entities, projectId = entities.projects[0], agentId = entities.agents[0];
const key = randomUUID();
await writeFile(`${root}/cancel-plan.json`, JSON.stringify({ key, projectId, agentId, createdAt: new Date().toISOString() }), { flag: 'wx' });
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch('http://127.0.0.1:4310' + path, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  assert.equal(response.ok, true, `${method} ${path}: ${response.status}`); return response.json() as Promise<T>;
}
const state = () => api<Workspace>('/api/workspace');
const budget = () => api<OperationalBudgetStatus>('/api/model-budget');
async function cap(limit: number | null) {
  const before = await budget();
  return api('/api/model-budget', { expectedRevision: before.revision, projectDailyLimits: { [projectId]: limit } }, 'PATCH');
}
async function until(predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 180_000;
  for (;;) { const current = await state(); if (predicate(current)) return current;
    assert.ok(Date.now() < deadline, 'Cancellation regression timed out'); await delay(1000); }
}
await cap(0);
const message = await api<ConversationMessage>(`/api/conversations/${entities.rooms[0]}/messages`, { mode: 'task', recipientAgentId: agentId,
  idempotencyKey: key, content: 'Budget cancellation regression. This request is cancelled before model admission; do not change files.' });
const waiting = await until(current => current.runs.some(run => run.conversationMessageId === message.id && run.modelBudgetPaused && !run.cleanupPending));
const runId = waiting.runs.find(run => run.conversationMessageId === message.id)!.id;
await delay(2000); // Let the execution controller settle, exercising the original missing path.
await api(`/api/runs/${runId}/cancel`, {});
await until(current => current.runs.find(run => run.id === runId)?.status === 'cancelled'
  && current.agents.find(agent => agent.id === agentId)?.status === 'idle');
await cap(null);
const final = await state(); assert.deepEqual(await read('model-budget.json'), ledgerBefore);
assert.equal((await budget()).used, 7);
await atomicJson(`${root}/cancel-report.json`, { status: 'passed', checkedAt: new Date().toISOString(), runId,
  messageId: message.id, modelStartsAdded: 0, campaignStarts: 7, agentStatus: final.agents.find(agent => agent.id === agentId)?.status });
console.log(JSON.stringify({ status: 'passed', runId, modelStartsAdded: 0, campaignStarts: 7, agentStatus: 'idle' }));
