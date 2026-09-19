import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import type { PeerMessage, TeamTask } from '../shared/collaboration.ts';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';

const output = (result = '진행 보존'): ExecutionResult => ({ result, memories: [], skills: [], artifacts: [], inputTokens: 10, outputTokens: 5 });
class Peers implements RuntimeDriver {
  available = true;
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; finish: (result?: ExecutionResult) => void }> = [];
  async inspect(): Promise<RuntimeInfo> { return { mode: 'docker', available: this.available, authenticated: true, image: 'test', model: 'test', message: 'test', version: 'test' }; }
  async canResume(input: ExecutionInput) { return Boolean(input.previousResult || input.checkpoint); }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('test shutdown'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks, finish: (value = output()) => {
        hooks.signal.removeEventListener('abort', abort); resolve(value);
      } });
    });
  }
}
function resources() { return new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
  defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } }); }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('peer lifecycle timeout'); await delay(10); }
}
async function fixture(dataDir?: string) {
  const runtime = new Peers(), scheduler = resources();
  const service = await AgentService.create({ runtime, scheduler, dataDir });
  const a = await service.createAgent({ name: 'A', persona: '독립 동료 A' });
  const b = await service.createAgent({ name: 'B', persona: '독립 동료 B' });
  const team = await service.createTeam({ name: '동료', memberIds: [a.id, b.id] });
  return { service, runtime, scheduler, a, b, scope: { type: 'team' as const, id: team.id } };
}

test('peer request releases one-worker budget, wakes isolated recipient, and resumes original run on reply', async () => {
  const { service, runtime, scheduler, a, b, scope } = await fixture();
  try {
    const run = await service.startRun(a.id, '협업');
    await until(async () => runtime.calls.length === 1);
    const first = runtime.calls[0];
    const message = await first.hooks.onTool!('message_send', { scope, recipientAgentId: b.id,
      content: '검토 요청', idempotencyKey: 'review-1' }) as PeerMessage;
    const duplicate = await first.hooks.onTool!('message_send', { scope, recipientAgentId: b.id,
      content: '검토 요청', idempotencyKey: 'review-1' }) as PeerMessage;
    assert.equal(message.id, duplicate.id);
    await first.hooks.onTool!('peer_wait', { messageId: message.id, reason: '검토 결과 대기' });
    assert.equal(scheduler.snapshot().reserved.memoryMiB, 1024);
    first.finish();
    await until(async () => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.agent.id, b.id);
    assert.deepEqual(runtime.calls[1].input.run.messageIds, [message.id]);
    assert.equal((await service.workspace()).runs.find(item => item.id === run.id)?.status, 'waiting');
    assert.equal(scheduler.snapshot().running.length, 1);
    await runtime.calls[1].hooks.onTool!('message_acknowledge', { messageId: message.id });
    assert.equal((await service.workspace()).runs.find(item => item.id === run.id)?.status, 'waiting');
    const reply = await runtime.calls[1].hooks.onTool!('message_send', { scope, recipientAgentId: a.id,
      content: '검토 완료', replyToId: message.id, idempotencyKey: 'reply-1' }) as PeerMessage;
    await runtime.calls[1].hooks.onTool!('message_complete', { messageId: message.id });
    runtime.calls[1].finish(output('동료 결과'));
    await until(async () => runtime.calls.length === 3);
    const resumed = runtime.calls[2];
    assert.equal(resumed.input.run.id, run.id);
    assert.equal(resumed.input.previousResult?.result, '진행 보존');
    assert.ok(resumed.input.run.messageIds?.includes(reply.id));
    resumed.finish(output('협업 완료'));
    await until(async () => (await service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
    const state = await service.workspace();
    assert.equal(state.runs.filter(item => item.agentId === b.id).length, 1);
    assert.equal(state.runs.find(item => item.id === run.id)?.inputTokens, 20);
    assert.equal(scheduler.snapshot().reserved.memoryMiB, 0);
  } finally { await service.close(); }
});

test('waiting persists across restart; cancellation is terminal even when a reply arrives later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-peer-'));
  let service: AgentService | undefined;
  try {
    const setup = await fixture(directory); service = setup.service;
    const { runtime, a, scope } = setup;
    const run = await service.startRun(a.id, '사용자 답변 대기');
    await until(async () => runtime.calls.length === 1);
    const question = await runtime.calls[0].hooks.onTool!('message_send', { scope, recipientAgentId: null,
      content: '목적 확인', idempotencyKey: 'purpose-question' }) as PeerMessage;
    await runtime.calls[0].hooks.onTool!('peer_wait', { messageId: question.id, reason: '사용자 확인' });
    runtime.calls[0].finish();
    await until(async () => (await service!.workspace()).runs[0].status === 'waiting');
    await service.close();
    const restarted = new Peers();
    service = await AgentService.create({ dataDir: directory, runtime: restarted, scheduler: resources() });
    assert.equal((await service.workspace()).runs[0].status, 'waiting');
    await service.cancelRun(run.id);
    await service.collaboration('message_send', { scope, recipientAgentId: a.id, replyToId: question.id,
      content: '범위 유지', idempotencyKey: 'operator-answer' });
    await until(async () => restarted.calls.length === 1);
    assert.notEqual(restarted.calls[0].input.run.id, run.id);
    assert.equal((await service.workspace()).runs.find(item => item.id === run.id)?.status, 'cancelled');
    restarted.calls[0].finish();
  } finally {
    await service?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /agent-company-peer-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  }
});

test('queued mail respects pause, current membership, and one delivery run per idempotent message', async () => {
  const { service, runtime, a, b, scope } = await fixture();
  try {
    await service.updateAgent(b.id, { status: 'paused' });
    const input = { scope, recipientAgentId: b.id, content: '협업 시작', idempotencyKey: randomUUID() };
    await service.collaboration('message_send', input);
    await service.collaboration('message_send', input);
    await delay(80);
    assert.equal(runtime.calls.length, 0);
    await service.updateTeam(scope.id, { memberIds: [a.id] });
    await service.updateAgent(b.id, { status: 'idle' });
    await delay(1100);
    assert.equal(runtime.calls.length, 0);
    await service.updateTeam(scope.id, { memberIds: [a.id, b.id] });
    await until(async () => runtime.calls.length === 1);
    runtime.calls[0].finish();
    await until(async () => (await service.workspace()).runs[0]?.status === 'succeeded');
    assert.equal((await service.workspace()).messages?.length, 1);
    assert.equal((await service.workspace()).runs.length, 1);
  } finally { await service.close(); }
});

test('run-bound tools reject impersonation and revoked scopes; task claim and execution are atomic', async () => {
  const { service, runtime, a, b, scope } = await fixture();
  try {
    const task = await service.collaboration('task_create', { scope, title: '공동 과제' }) as TeamTask;
    const run = await service.startTeamTask(task.id, a.id, task.version);
    await until(async () => runtime.calls.length === 1);
    await assert.rejects(service.startTeamTask(task.id, b.id, task.version), /Version|open/);
    const tool = runtime.calls[0].hooks.onTool!;
    await assert.rejects(tool('message_send', { scope, senderAgentId: b.id, recipientAgentId: b.id,
      content: '위조', idempotencyKey: 'spoof' }));
    await service.updateTeam(scope.id, { memberIds: [b.id] });
    await assert.rejects(tool('artifact_publish', { scope, name: 'private.txt', content: '거부' }), /membership/);
    await assert.rejects(tool('project_create', { name: '권한 확대', teamIds: [scope.id] }), /user/);
    await service.cancelRun(run.id);
    await assert.rejects(tool('collaboration_context', {}), /진행 중/);
    assert.equal((await service.workspace()).sharedArtifacts?.length, 0);
  } finally { await service.close(); }
});

test('operator steering wakes a waiting run without requiring an unrelated peer response', async () => {
  const { service, runtime, a, scope } = await fixture();
  try {
    const run = await service.startRun(a.id, '대기');
    await until(async () => runtime.calls.length === 1);
    const question = await runtime.calls[0].hooks.onTool!('message_send', { scope, recipientAgentId: null,
      content: '확인', idempotencyKey: 'q' }) as PeerMessage;
    await runtime.calls[0].hooks.onTool!('peer_wait', { messageId: question.id, reason: '답변 대기' });
    runtime.calls[0].finish();
    await until(async () => (await service.workspace()).runs[0].status === 'waiting');
    await service.steerRun(run.id, '대기 중단 후 기존 범위로 마무리');
    await until(async () => runtime.calls.length === 2);
    assert.equal(runtime.calls[1].input.run.id, run.id);
    assert.equal(runtime.calls[1].input.run.steering.length, 1);
    runtime.calls[1].finish({ ...output('추가 지시 반영'), appliedSteeringCount: 1 });
    await until(async () => (await service.workspace()).runs[0].status === 'succeeded');
  } finally { await service.close(); }
});
