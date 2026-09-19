import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import fastifyStatic from '@fastify/static';
import { createApp } from '../server/app.ts';
import { atomicJson } from '../server/storage.ts';
import type { ExecutionInput, ExecutionHooks, ExecutionResult, RuntimeDriver } from '../shared/types.ts';

// UI/API/persistence fixture. No credentials, Docker or real model invocations.
const directory = process.argv[2] ? resolve(process.argv[2]) : resolve('.browser', `conversation-verify-${randomUUID()}`);
if (dirname(directory) !== resolve('.browser') || !/^conversation-verify-[a-f0-9-]{36}$/.test(basename(directory))) throw new Error('검증 전용 데이터 경로만 사용할 수 있습니다.');
if (process.argv[2]) {
  const previous = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'));
  if (previous.directory !== directory || previous.modelCalls !== 0 || previous.directDatabaseSeeds !== 0) throw new Error('검증 데이터 소유권이 일치하지 않습니다.');
}
await mkdir(directory, { recursive: true });
class ConversationFixture implements RuntimeDriver {
  readonly calls: Array<{ runId: string; mode?: string; phase: string }> = [];
  async inspect() { return { mode: 'docker' as const, available: true, authenticated: true,
    model: 'ui-fixture-no-model', image: 'fixture:no-container', version: 'fixture', simulation: true, message: '화면 검증용 실행기입니다. 실제 모델·컨테이너는 호출하지 않습니다.' }; }
  async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const previous = input.checkpoint?.previousResult;
    if (input.checkpoint?.phase === 'complete' && previous) return previous;
    this.calls.push({ runId: input.run.id, mode: input.run.interactionMode, phase: 'started' });
    await hooks.onEvent('[화면 검증 fixture] 작업 문맥을 읽고 있습니다. 실제 모델 호출은 0회입니다.');
    await delay(input.run.prompt.includes('중단 검사') ? 15_000 : 1800, undefined, { signal: hooks.signal });
    const steering = await hooks.getSteering();
    const result: ExecutionResult = { result: `[화면 검증 fixture] ${input.agent.name}의 응답입니다.\n\n${input.run.prompt}\n\n반영한 추가 지시: ${steering.length}개`,
      memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0, appliedSteeringCount: steering.length,
      ...(input.run.interactionMode !== 'task' ? { route: 'discuss' as const } : {}) };
    if (input.run.interactionMode === 'task' && input.run.conversationId && input.run.prompt.includes('협업 검사')) {
      const context = (input.collaboration?.context as { conversation?: { members: Array<{ id: string }> } } | undefined)?.conversation;
      const peer = context?.members.find(item => item.id !== input.agent.id);
      if (peer) await hooks.onTool?.('conversation_send', { conversationId: input.run.conversationId,
        content: '[화면 검증 fixture] 공동 대화에서 동료에게 검토를 요청합니다.', mode: 'discuss', recipientAgentId: peer.id,
        idempotencyKey: randomUUID() });
    }
    await hooks.onCheckpoint?.({ phase: 'complete', previousResult: result, appliedSteeringCount: steering.length });
    this.calls.at(-1)!.phase = 'completed';
    return result;
  }
}
const runtime = new ConversationFixture();
const app = await createApp({ dataDir: join(directory, 'db'), runtime });
await app.register(fastifyStatic, { root: resolve('dist') });
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
  ? reply.code(404).send({ error: 'API not found' }) : reply.sendFile('index.html'));
app.get('/verification/state', async () => ({ modelCalls: 0, directDatabaseSeeds: 0, calls: runtime.calls }));
let closing: Promise<void> | undefined;
function close() {
  return closing ??= app.close().then(async () => {
    await atomicJson(join(directory, 'closed.json'), { stoppedAt: new Date().toISOString(), modelCalls: 0, calls: runtime.calls });
    process.exitCode = 0;
  });
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'close') void close(); });
await app.listen({ host: '127.0.0.1', port: 4316 });
await atomicJson(join(directory, 'fixture.json'), { directory, pid: process.pid, origin: 'http://127.0.0.1:4316', modelCalls: 0, directDatabaseSeeds: 0 });
console.log(JSON.stringify({ directory, origin: 'http://127.0.0.1:4316', pid: process.pid, modelCalls: 0 }));
