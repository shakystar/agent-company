import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import type { OperatorRequest } from '../shared/operator-requests.ts';
import type { RuntimeDriver } from '../shared/types.ts';

test('operator HTTP workflow preserves decisions, rejects forged verification and exposes linked consultation', async t => {
  let executions = 0;
  const runtime: RuntimeDriver = {
    inspect: async () => ({ mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: 'fixture', message: 'Explicit fixture; no model' }),
    execute: async () => { executions++; throw new Error('No model expected'); },
  };
  const app = await createApp({ runtime }); t.after(() => app.close());
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
  const agentResponse = await post('/api/agents', { name: 'HTTP fixture', persona: 'No external actions' });
  assert.equal(agentResponse.statusCode, 201); const agent = agentResponse.json();
  const input = { requesterAgentId: agent.id, scope: { type: 'agent', id: agent.id }, links: {}, category: 'other',
    title: '입력 자료 요청', reason: '업무 입력 필요', requestedAction: '기획 자료 제공', requestedScope: '개인 과제',
    verificationCriteria: '제공 자료 확인', idempotencyKey: randomUUID() };
  let response = await post('/api/operator-requests', input);
  assert.equal(response.statusCode, 201); let request = response.json<OperatorRequest>();
  assert.equal((await post('/api/operator-requests', input)).json<OperatorRequest>().id, request.id);
  const path = `/api/operator-requests/${request.id}`;
  response = await post(`${path}/decide`, { expectedVersion: request.version, status: 'approved', reason: '기록 범위 승인' });
  assert.equal(response.statusCode, 200); request = response.json();
  assert.equal(request.processing.status, 'idle');
  assert.equal((await post(`${path}/verify`, { expectedVersion: request.version, method: 'manual', passed: true, evidence: '확인', detail: '완료' })).statusCode, 400);
  assert.equal((await post(`${path}/verify`, { expectedVersion: request.version, method: 'manual', evidence: '확인', detail: '완료' })).statusCode, 409);
  response = await post(`${path}/progress`, { expectedVersion: request.version, status: 'verification_pending', detail: '자료 전달 확인' });
  assert.equal(response.statusCode, 200); request = response.json();
  response = await post(`${path}/verify`, { expectedVersion: request.version, method: 'manual', evidence: '운영자가 제공 자료 확인', detail: '내용 확인' });
  assert.equal(response.statusCode, 200); request = response.json();
  assert.equal(request.processing.status, 'verified'); assert.match(request.verification!.detail, /^운영자 확인:/);
  assert.deepEqual(request.resumeReceipts, []);
  assert.equal((await post(`${path}/decide`, { expectedVersion: 1, status: 'approved', reason: 'stale' })).statusCode, 409);
  const { requesterAgentId: _agent, idempotencyKey: _key, ...content } = input;
  response = await post(`${path}/revise`, { ...content, expectedVersion: request.version, requestedAction: '새 자료 제공' });
  assert.equal(response.statusCode, 200); request = response.json();
  assert.equal(request.decision.status, 'pending'); assert.equal(request.verification, null);
  const consultation = { content: '변경된 자료 범위를 확인합니다.', idempotencyKey: randomUUID() };
  response = await post(`${path}/consult`, consultation); assert.equal(response.statusCode, 200);
  const room = response.json(); assert.ok(room.conversationId);
  assert.equal((await post(`${path}/consult`, consultation)).json().conversationId, room.conversationId);
  const workspace = (await app.inject('/api/workspace')).json();
  assert.equal(workspace.operatorRequests.length, 1);
  assert.equal(workspace.conversationMessages.filter((item: { conversationId: string }) => item.conversationId === room.conversationId).length, 1);
  const blocked = await app.inject({ method: 'POST', url: `${path}/withdraw`, headers: { origin: 'https://unrelated.invalid' },
    payload: { expectedVersion: request.version, reason: 'forged' } });
  assert.equal(blocked.statusCode, 403); assert.equal(executions, 0);
});
