import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver, RuntimeInfo } from '../shared/types.ts';
import type { PeerMessage } from '../shared/collaboration.ts';

const result = (text: string, appliedSteeringCount = 0): ExecutionResult => ({
  result: text, memories: [], skills: [], artifacts: [], inputTokens: 1, outputTokens: 1, appliedSteeringCount,
});

class PeerRaceRuntime implements RuntimeDriver {
  calls: Array<{ input: ExecutionInput; hooks: ExecutionHooks; finish: (result: ExecutionResult) => void }> = [];
  async inspect(): Promise<RuntimeInfo> {
    return { mode: 'docker', available: true, authenticated: true, image: 'test', model: 'test', message: 'test', version: 'test' };
  }
  async canResume(input: ExecutionInput): Promise<boolean> { return Boolean(input.previousResult || input.checkpoint); }
  execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('test shutdown'));
      hooks.signal.addEventListener('abort', abort, { once: true });
      this.calls.push({ input, hooks, finish: output => {
        hooks.signal.removeEventListener('abort', abort); resolve(output);
      } });
    });
  }
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Peer race test timed out.');
    await delay(5);
  }
}

async function fixture(concurrency = 1) {
  const runtime = new PeerRaceRuntime();
  const worker = { memoryMiB: 1024, cpus: 1 };
  const service = await AgentService.create({ runtime, scheduler: new ResourceScheduler({
    capacity: { memoryMiB: 1024 * concurrency, cpus: concurrency },
    defaultRequest: { minimum: worker, preferred: worker },
  }) });
  const a = await service.createAgent({ name: 'A', persona: 'A' });
  const b = await service.createAgent({ name: 'B', persona: 'B' });
  const team = await service.createTeam({ name: 'Peer races', memberIds: [a.id, b.id] });
  return { runtime, service, a, b, scope: { type: 'team' as const, id: team.id } };
}

test('steering accepted after peer_wait but before turn completion cannot be stranded in waiting', async () => {
  const { service, runtime, a, scope } = await fixture();
  try {
    const run = await service.startRun(a.id, 'Wait for a reply.');
    await until(() => runtime.calls.length === 1);
    const first = runtime.calls[0];
    const question = await first.hooks.onTool!('message_send', {
      scope, recipientAgentId: null, content: 'Clarify the purpose.', idempotencyKey: 'purpose-question',
    }) as PeerMessage;
    await first.hooks.onTool!('peer_wait', { messageId: question.id, reason: 'Wait for the user.' });
    assert.equal((await service.workspace()).runs[0].status, 'running');
    await service.steerRun(run.id, 'Stop waiting and finish within the existing scope.');
    first.finish(result('The first turn ended before applying the new steering.'));
    await until(() => runtime.calls.length === 2);
    const continued = runtime.calls[1];
    assert.equal(continued.input.run.id, run.id);
    assert.deepEqual(continued.input.run.steering, ['Stop waiting and finish within the existing scope.']);
    assert.equal(continued.input.run.waitingFor, null);
    assert.equal(continued.input.previousResult?.result, 'The first turn ended before applying the new steering.');
    continued.finish(result('Applied steering.', 1));
    await until(async () => (await service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
    assert.equal((await service.workspace()).runs.length, 1);
  } finally { await service.close(); }
});

test('an autonomous reply preserves the message without starting replacement work for a cancelled origin', async () => {
  const { service, runtime, a, b, scope } = await fixture();
  try {
    const original = await service.startRun(a.id, 'Coordinate a review.');
    await until(() => runtime.calls.length === 1);
    const first = runtime.calls[0];
    const question = await first.hooks.onTool!('message_send', {
      scope, recipientAgentId: b.id, content: 'Review the work.', idempotencyKey: 'review-request',
    }) as PeerMessage;
    await first.hooks.onTool!('peer_wait', { messageId: question.id, reason: 'Wait for review.' });
    first.finish(result('Review requested.'));
    await until(() => runtime.calls.length === 2);
    await service.cancelRun(original.id);
    const recipient = runtime.calls[1];
    const reply = await recipient.hooks.onTool!('message_send', {
      scope, recipientAgentId: a.id, replyToId: question.id,
      content: 'Review finished; continue the original work.', idempotencyKey: 'late-review-reply',
    }) as PeerMessage;
    recipient.finish(result('Reply sent.'));
    await until(async () => (await service.workspace()).runs.find(item => item.id === recipient.input.run.id)?.status === 'succeeded');
    // Exercise the immediate delivery check and a subsequent periodic inbox check.
    await delay(1200);
    const state = await service.workspace();
    assert.equal(state.runs.find(item => item.id === original.id)?.status, 'cancelled');
    assert.equal(runtime.calls.length, 2, 'a different Run ID must not bypass user cancellation');
    assert.equal(state.runs.filter(item => item.agentId === a.id).length, 1);
    assert.equal(state.messages?.find(item => item.id === reply.id)?.content, reply.content);
  } finally { await service.close(); }
});

test('a reply arriving before the waiting turn ends resumes the same saved run exactly once', async () => {
  const { service, runtime, a, b, scope } = await fixture(2);
  try {
    const original = await service.startRun(a.id, 'Coordinate a quick reply.');
    await until(() => runtime.calls.length === 1);
    const first = runtime.calls[0];
    const question = await first.hooks.onTool!('message_send', {
      scope, recipientAgentId: b.id, content: 'Send a quick review.', idempotencyKey: 'quick-request',
    }) as PeerMessage;
    await first.hooks.onTool!('peer_wait', { messageId: question.id, reason: 'Wait for a quick review.' });
    await until(() => runtime.calls.length === 2);
    const recipient = runtime.calls[1];
    const reply = await recipient.hooks.onTool!('message_send', {
      scope, recipientAgentId: a.id, replyToId: question.id, content: 'Already reviewed.', idempotencyKey: 'quick-reply',
    }) as PeerMessage;
    assert.equal((await service.workspace()).runs.find(item => item.id === original.id)?.status, 'running');
    recipient.finish(result('Reply was sent before the sender finished its turn.'));
    first.finish(result('Keep this progress while waiting.'));
    await until(() => runtime.calls.length === 3);
    const resumed = runtime.calls[2];
    assert.equal(resumed.input.run.id, original.id);
    assert.equal(resumed.input.previousResult?.result, 'Keep this progress while waiting.');
    assert.ok(resumed.input.run.messageIds?.includes(reply.id));
    resumed.finish(result('Quick reply incorporated.'));
    await until(async () => (await service.workspace()).runs.find(item => item.id === original.id)?.status === 'succeeded');
    await delay(100);
    const state = await service.workspace();
    assert.equal(state.runs.filter(item => item.agentId === a.id).length, 1);
    assert.equal(runtime.calls.length, 3);
  } finally { await service.close(); }
});

test('removing either waiting participant resumes the saved run without restoring revoked team access', async () => {
  for (const removed of ['sender', 'recipient'] as const) {
    const { service, runtime, a, b, scope } = await fixture();
    try {
      // Keep the request pending without introducing a recipient execution into this race.
      await service.updateAgent(b.id, { status: 'paused' });
      const original = await service.startRun(a.id, 'Wait within the approved team scope.');
      await until(() => runtime.calls.length === 1);
      const first = runtime.calls[0];
      const question = await first.hooks.onTool!('message_send', {
        scope, recipientAgentId: b.id, content: 'Review when available.', idempotencyKey: 'membership-request',
      }) as PeerMessage;
      await first.hooks.onTool!('peer_wait', { messageId: question.id, reason: 'Wait for the current teammate.' });
      first.finish(result('Preserved before the membership change.'));
      await until(async () => (await service.workspace()).runs.find(item => item.id === original.id)?.status === 'waiting');
      await service.updateTeam(scope.id, { memberIds: removed === 'sender' ? [b.id] : [a.id] });
      await until(() => runtime.calls.length === 2);
      const resumed = runtime.calls[1];
      assert.equal(resumed.input.run.id, original.id);
      assert.equal(resumed.input.run.waitingFor, null);
      assert.match(resumed.input.run.recoveryReason ?? '', /협업 구성이 변경/);
      assert.equal(resumed.input.previousResult?.result, 'Preserved before the membership change.');
      assert.deepEqual(resumed.input.agent.repositoryIds, first.input.agent.repositoryIds);
      assert.equal(resumed.input.agent.allowWeb, first.input.agent.allowWeb);
      if (removed === 'sender') {
        await assert.rejects(resumed.hooks.onTool!('collaboration_members', { scope }), /membership/);
        await assert.rejects(resumed.hooks.onTool!('message_list', { scope }), /membership/);
      } else {
        await assert.rejects(resumed.hooks.onTool!('message_send', {
          scope, recipientAgentId: b.id, content: 'Retry outside the revoked membership.', idempotencyKey: 'rejected-retry',
        }), /membership/);
      }
      resumed.finish(result('Continued only within the remaining scope.'));
      await until(async () => (await service.workspace()).runs.find(item => item.id === original.id)?.status === 'succeeded');
      const state = await service.workspace();
      assert.equal(state.runs.length, 1);
      assert.equal(state.messages?.length, 1);
    } finally { await service.close(); }
  }
});
