import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { PeerMessage } from '../shared/collaboration.ts';
import type { LearningReview } from '../shared/learning.ts';
import type { Workspace } from '../shared/types.ts';
import { AgentService } from '../server/service.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { GrowthFixtureRuntime, growthResult, waitFor } from './growth-fixture.ts';

const review: LearningReview = { inputHash: 'a'.repeat(64), status: 'reviewed', reason: '확인된 반복 절차를 기억으로 제안했습니다.',
  evidence: [{ sourceId: 'result', quote: '확인된 재사용 절차' }], memoryCount: 1, skillCount: 0, completedAt: '2026-09-13T10:00:00.000Z' };
const result = () => growthResult({ result: '확인된 재사용 절차', learningReview: structuredClone(review),
  memories: [{ kind: 'procedure', title: '확인된 절차', content: '실제 작업에서 확인된 절차를 재사용합니다.' }] });
const reviewActivities = (state: Workspace, runId: string) => state.activities.filter(item => item.runId === runId && item.title.startsWith('학습 검토'));

async function fixture(t: TestContext, persistent = false) {
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'ac-learning-review-')) : undefined;
  const runtime = new GrowthFixtureRuntime();
  const scheduler = () => new ResourceScheduler({ capacity: { memoryMiB: 1024, cpus: 1 },
    defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } });
  let service = await AgentService.create({ runtime, scheduler: scheduler(), dataDir: directory });
  t.after(async () => {
    await service.close();
    if (directory) {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.match(directory, /ac-learning-review-[^\\/]+$/);
      const entry = await lstat(directory); assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      await rm(directory, { recursive: true });
    }
  });
  return { runtime, get service() { return service; }, reopen: async () => {
    assert.ok(directory); await service.close();
    service = await AgentService.create({ runtime, scheduler: scheduler(), dataDir: directory });
  } };
}

test('task learning review persists once with its activity and saved memory across restart', async t => {
  const f = await fixture(t, true);
  const agent = await f.service.createAgent({ name: '학습 기록', persona: '주입 실행기; 모델 호출 없음' });
  const run = await f.service.startRun(agent.id, '검증한 절차를 기록합니다');
  await waitFor(() => f.runtime.calls.length === 1);
  f.runtime.calls[0].resolve(result());
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
  await f.reopen();
  const state = await f.service.workspace();
  assert.deepEqual(state.runs.find(item => item.id === run.id)?.learningReview, review);
  assert.equal(reviewActivities(state, run.id).length, 1);
  assert.match(reviewActivities(state, run.id)[0].detail, /기억 제안 1개/);
  assert.equal(state.memories.length, 1); assert.equal(state.memories[0].sourceRunId, run.id);
  assert.equal(state.memories[0].content, result().memories[0].content);
  assert.equal(f.runtime.calls.length, 1);
});

test('peer waiting preserves the learning review while deferring actual memory application', async t => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ name: '응답 대기', persona: '주입 실행기' });
  const peer = await f.service.createAgent({ name: '검토 동료', persona: '주입 실행기' });
  const team = await f.service.createTeam({ name: '학습 대기 팀', memberIds: [agent.id, peer.id] });
  const run = await f.service.startRun(agent.id, '동료 검토 후 마무리합니다');
  await waitFor(() => f.runtime.calls.length === 1);
  const call = f.runtime.calls[0];
  const message = await call.hooks.onTool!('message_send', { scope: { type: 'team', id: team.id }, recipientAgentId: peer.id,
    content: '절차 검토 요청', idempotencyKey: randomUUID() }) as PeerMessage;
  await call.hooks.onTool!('peer_wait', { messageId: message.id, reason: '동료의 검증 응답 대기' });
  call.resolve(result());
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'waiting');
  const state = await f.service.workspace(), waiting = state.runs.find(item => item.id === run.id)!;
  assert.deepEqual(waiting.learningReview, review);
  assert.equal(waiting.completedAt, null); assert.equal(waiting.waitingFor?.messageId, message.id);
  assert.equal(reviewActivities(state, run.id).length, 1);
  assert.equal(state.memories.length, 0); assert.equal(state.skills.length, 0);
});

test('waiting checkpoint replacement retains quarantined proposals without applying them',async t=>{
  const f=await fixture(t);
  const agent=await f.service.createAgent({name:'보류 근거',persona:'주입 실행기'});
  const peer=await f.service.createAgent({name:'검토자',persona:'주입 실행기'});
  const team=await f.service.createTeam({name:'검토',memberIds:[agent.id,peer.id]});
  const run=await f.service.startRun(agent.id,'검토 보류 결과를 보존합니다');
  await waitFor(()=>f.runtime.calls.length===1);const call=f.runtime.calls[0];
  const message=await call.hooks.onTool!('message_send',{scope:{type:'team',id:team.id},recipientAgentId:peer.id,content:'검토',idempotencyKey:randomUUID()}) as PeerMessage;
  await call.hooks.onTool!('peer_wait',{messageId:message.id,reason:'회신 대기'});
  const held={memories:result().memories,skills:[]};
  const output=growthResult({result:'원래 업무 결과',memories:[],learningReview:{...review,status:'deferred',memoryCount:0,reason:'근거 검토 실패'}});
  await call.hooks.onCheckpoint!({phase:'complete',previousResult:output,growthProgress:{learningUnreviewed:held}});
  call.resolve(output);
  await waitFor(async()=>(await f.service.workspace()).runs.find(r=>r.id===run.id)?.status==='waiting');
  const stored=await (f.service as unknown as {store:{read():Promise<import('../server/store.ts').WorkspaceState>}}).store.read();
  assert.deepEqual(stored.executionStates[run.id].learningHeldProposals,{inputHash:review.inputHash,proposals:held});
  assert.equal(stored.memories.length,0);
});

test('complete checkpoint recovery records one learning review and memory without replaying the model', async t => {
  const f = await fixture(t, true);
  const agent = await f.service.createAgent({ name: '완료 복구', persona: '주입 실행기' });
  const run = await f.service.startRun(agent.id, '학습 검토 결과를 복구합니다');
  await waitFor(() => f.runtime.calls.length === 1);
  await f.runtime.calls[0].hooks.onCheckpoint!({ phase: 'complete', previousResult: result(), appliedSteeringCount: 0 });
  await f.reopen();
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
  await f.reopen();
  const state = await f.service.workspace();
  assert.deepEqual(state.runs.find(item => item.id === run.id)?.learningReview, review);
  assert.equal(reviewActivities(state, run.id).length, 1);
  assert.equal(state.memories.filter(item => item.sourceRunId === run.id).length, 1);
  assert.equal(f.runtime.calls.length, 1);
});

test('discussion output cannot create a learning review activity or apply proposed memory', async t => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ name: '상담', persona: '주입 실행기' });
  const room = await f.service.createConversation({ scope: { type: 'agent', id: agent.id }, title: '상담 검증', idempotencyKey: randomUUID() });
  await f.service.sendConversation(room.id, { content: '절차에 관해 설명합니다', mode: 'discuss', idempotencyKey: randomUUID() });
  await waitFor(() => f.runtime.calls.length === 1);
  const call = f.runtime.calls[0]; assert.equal(call.input.run.interactionMode, 'discuss');
  call.resolve(result());
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === call.input.run.id)?.status === 'succeeded');
  const state = await f.service.workspace();
  assert.equal(state.runs.find(item => item.id === call.input.run.id)?.learningReview, undefined);
  assert.equal(reviewActivities(state, call.input.run.id).length, 0);
  assert.equal(state.memories.length, 0); assert.equal(state.skills.length, 0);
});
