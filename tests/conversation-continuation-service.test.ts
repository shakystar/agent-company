import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentService } from '../server/service.ts';
import { OperationalFixtureRuntime, output, resources, waitFor } from './operational-budget-fixture.ts';
import type { OperatorRequest } from '../shared/operator-requests.ts';

class ContinuationRuntime extends OperationalFixtureRuntime { readonly workspacePersistence = true; }

test('verified operator request continuation completes the original conversation delivery through the service result path', async t => {
  const runtime = new ContinuationRuntime();
  const service = await AgentService.create({ runtime, scheduler: resources(2) }); t.after(() => service.close());
  const agent = await service.createAgent({ name: '실제 전달 경로 검사', persona: '주입 실행기; 실제 모델 호출 없음' });
  const team = await service.createTeam({ name: '대화 팀', memberIds: [agent.id] });
  const conversation = await service.createConversation({ scope: { type: 'team', id: team.id }, title: '기존 작업 대화', idempotencyKey: randomUUID() });
  const initial = await service.sendConversation(conversation.id, { content: '입력을 확인해 작업을 완료합니다', mode: 'task', recipientAgentId: agent.id, idempotencyKey: randomUUID() });
  await waitFor(() => runtime.calls.length === 1); const original = runtime.calls[0];
  const request = await original.hooks.onTool!('operator_request_create', { scope: { type: 'team', id: team.id }, category: 'other',
    title: '입력 확인', reason: '현재 작업 입력이 없습니다', requestedAction: '입력 제공', requestedScope: '기존 작업 입력',
    verificationCriteria: '입력을 확인합니다', idempotencyKey: randomUUID() }) as OperatorRequest;
  await original.hooks.onTool!('operator_request_wait', { requestId: request.id, reason: '대표의 업무 입력 대기' });
  original.finish(output('중간 결과 보존'));
  await waitFor(async () => (await service.workspace()).runs.find(item => item.id === original.input.run.id)?.status === 'waiting');
  const approved = await service.updateOperatorRequest(request.id, 'decide', { expectedVersion: request.version, status: 'approved', reason: '입력 처리 승인' });
  const ready = await service.updateOperatorRequest(request.id, 'progress', { expectedVersion: approved.version, status: 'verification_pending', detail: '입력 확인 대기' });
  await service.verifyOperatorRequest(request.id, { expectedVersion: ready.version, method: 'manual', evidence: '입력 확인 근거', detail: '입력 확인 완료' });
  await waitFor(() => runtime.calls.length === 2); const child = runtime.calls[1];
  assert.equal(child.input.run.continuedFromRunId, original.input.run.id);
  const pending = (await service.getConversation(conversation.id)).messages.find(item => item.id === initial.id)!;
  assert.notEqual(pending.deliveries[0].status, 'answered'); assert.equal(pending.deliveries[0].runId, original.input.run.id);
  child.finish(output('이어진 실행의 최종 답변'));
  await waitFor(async () => (await service.getConversation(conversation.id)).messages.find(item => item.id === initial.id)?.deliveries[0].status === 'answered');
  const final = await service.getConversation(conversation.id), delivered = final.messages.find(item => item.id === initial.id)!;
  assert.equal(delivered.deliveries[0].runId, original.input.run.id); assert.equal(delivered.senderAgentId, null); assert.equal(delivered.sourceRunId, null);
  assert.equal(final.messages.filter(item => item.sourceRunId === child.input.run.id && item.replyToId === initial.id).length, 1);
  assert.equal((await service.workspace()).runs.find(item => item.id === original.input.run.id)?.status, 'superseded');
});
