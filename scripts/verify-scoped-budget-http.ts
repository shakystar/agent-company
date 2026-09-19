import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../server/storage.ts';
import type { Workspace, Run } from '../shared/types.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';

const origin = 'http://127.0.0.1:4317';
async function request<T>(path: string, method = 'GET', body?: object, expected = 200): Promise<T> {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(20_000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as T;
}
const fixture = await request<{ fixture: string; realModelStarts: number; ids: Record<string, string> }>('/verification/state');
assert.equal(fixture.fixture, 'scoped-budget-browser-no-model'); assert.equal(fixture.realModelStarts, 0);
const { teamAgent, personalAgent, team, project } = fixture.ids;
const status = () => request<OperationalBudgetStatus>('/api/model-budget');
const workspace = () => request<Workspace>('/api/workspace');
async function update(body: object) { return request<OperationalBudgetStatus>('/api/model-budget', 'PATCH', { expectedRevision: (await status()).revision, ...body }); }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Fixture transition timed out'); await delay(50); }
}
const initial = await status(); assert.equal(initial.revision, 0); assert.equal(initial.used, 0);
assert.equal(initial.dailyLimit, 100); // Never reset or rerun a completed fixture.
await update({ teamDailyLimits: { [team]: 0 }, agentDailyLimits: { [teamAgent]: 0 } });
await request('/api/model-budget', 'PATCH', { expectedRevision: 0, teamDailyLimits: { [team]: 20 } }, 409);
await request('/api/model-budget', 'PATCH', { expectedRevision: 1, teamDailyLimits: { [team]: -1 } }, 400);
const room = await request<{ id: string; budgetTeamId: string }>('/api/conversations', 'POST', {
  scope: { type: 'project', id: project }, budgetTeamId: team, title: '[검증 fixture] 한도 대기·재개', idempotencyKey: randomUUID() }, 201);
assert.equal(room.budgetTeamId, team);
async function task(content: string) {
  const message = await request<{ id: string }>(`/api/conversations/${room.id}/messages`, 'POST', {
    content, mode: 'task', recipientAgentId: teamAgent, idempotencyKey: randomUUID() }, 202);
  await until(async () => (await workspace()).runs.some(run => run.conversationMessageId === message.id && run.modelBudgetPaused));
  return (await workspace()).runs.find(run => run.conversationMessageId === message.id)!;
}
const cancelled = await task('[검증 fixture] 팀 한도로 대기한 뒤 사용자 중지 유지');
assert.equal((await status()).waiting[0].blockedBy, 'team');
await request(`/api/runs/${cancelled.id}/pause`, 'POST', {});
await until(async () => (await workspace()).runs.find(run => run.id === cancelled.id)?.status === 'paused');
await update({ teamDailyLimits: { [team]: 2 } });
assert.equal((await workspace()).runs.find(run => run.id === cancelled.id)?.status, 'paused');
assert.equal((await status()).waiting[0].blockedBy, 'agent');
await request(`/api/runs/${cancelled.id}/cancel`, 'POST', {});
await update({ teamDailyLimits: { [team]: 0 }, agentDailyLimits: { [teamAgent]: null } });
const personal = await request<Run>(`/api/agents/${personalAgent}/runs`, 'POST', {
  prompt: '[검증 fixture] 다른 에이전트의 팀 없는 작업', budgetProjectId: null, budgetTeamId: null }, 202);
await until(async () => (await workspace()).runs.find(run => run.id === personal.id)?.status === 'succeeded');
const resumed = await task('[검증 fixture] 팀·에이전트 순차 한도 해제 후 같은 실행 재개');
await update({ teamDailyLimits: { [team]: 1 }, agentDailyLimits: { [teamAgent]: 0 } });
await until(async () => (await status()).waiting.some(run => run.runId === resumed.id && run.blockedBy === 'agent'));
await update({ agentDailyLimits: { [teamAgent]: 1 } });
await until(async () => (await workspace()).runs.find(run => run.id === resumed.id)?.status === 'succeeded');
const finished = await status(); assert.equal(finished.used, 2);
assert.equal(finished.teams?.find(item => item.teamId === team)?.used, 1);
for (const id of [teamAgent, personalAgent]) assert.equal(finished.agents?.find(item => item.agentId === id)?.used, 1);
await update({ teamDailyLimits: { [team]: null }, agentDailyLimits: { [teamAgent]: null } });
const final = await workspace();
assert.equal(final.runs.find(run => run.id === cancelled.id)?.status, 'cancelled');
assert.ok(final.runs.every(run => ['succeeded', 'cancelled'].includes(run.status)));
assert.equal(final.runs.find(run => run.id === resumed.id)?.budgetTeamId, team);
assert.equal(final.runs.find(run => run.id === personal.id)?.budgetTeamId, null);
assert.ok(final.modelBudget); assert.equal(final.modelBudget.used, 2); assert.equal(final.modelBudget.waiting.length, 0);
const report = { status: 'passed', checkedAt: new Date().toISOString(), realModelStarts: 0, simulatedAdmissions: 2,
  fixture: fixture.fixture, originalTeam: team, cancelledRunId: cancelled.id, resumedRunId: resumed.id,
  personalRunId: personal.id, checks: ['strict-input', 'revision-conflict', 'team-wait', 'explicit-pause', 'cancel-preserved',
    'other-agent-personal-progress', 'agent-wait', 'same-run-resume', 'scope-counts'], finalBudget: final.modelBudget };
await atomicJson(resolve('.verification/scoped-budget-20260907/browser-fixture/http-report.json'), report);
console.log(JSON.stringify(report));
