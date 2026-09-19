import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import fastifyStatic from '@fastify/static';
import { createApp } from '../server/app.ts';
import { atomicJson } from '../server/storage.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, RuntimeDriver } from '../shared/types.ts';
import type { ObjectiveAssessment } from '../shared/objectives.ts';
import type { SharedArtifact, TeamTask } from '../shared/collaboration.ts';

// Isolated browser/controller fixture. It never loads dotenv, credentials, the
// production database, Docker, worker files, or an external model/service.
const origin = 'http://127.0.0.1:4319';
await new Promise<void>((resolvePort, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(4319, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolvePort()));
});
const directory = resolve('.verification', 'objective-ui-20260911', `data-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const key = randomUUID();
class ObjectiveFixture implements RuntimeDriver {
  readonly calls: Array<{ runId: string; kind: string; completed: boolean }> = [];
  async inspect() { return { mode: 'docker' as const, available: true, authenticated: true, simulation: true,
    image: 'fixture:no-container', model: 'objective-ui-fixture', version: 'fixture', message: '검증용 실행기 · 실제 모델·컨테이너 호출 0회' }; }
  async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    if (input.checkpoint?.phase === 'complete' && input.checkpoint.previousResult) return input.checkpoint.previousResult;
    await hooks.beforeModelStart?.({ runId: input.run.id, phase: input.objectiveEvaluation ? 'evaluate' : 'task',
      kind: 'objective-ui-fixture', reason: '[검증용] 동일한 제어 계층 진입 검사이며 실제 모델 호출은 없습니다.' });
    const call = { runId: input.run.id, kind: input.objectiveEvaluation ? 'objective-evaluation' : 'fixture-task', completed: false };
    this.calls.push(call);
    await hooks.onEvent('[검증용] 고정된 입력으로 화면·API 동작을 검사합니다. 실제 모델 호출은 없습니다.');
    await delay(1800, undefined, { signal: hooks.signal });
    const result: ExecutionResult = { result: '[검증용] 정해진 응답을 반환했습니다.', memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0 };
    if (input.objectiveEvaluation) {
      const frozen = input.objectiveEvaluation;
      const completedArtifact = frozen.evidence.find(item => item.kind === 'artifact' && item.title === 'qa/fixture-complete.md');
      const conditions: ObjectiveAssessment['conditions'] = frozen.conditions.map(condition => {
        const confirmation = frozen.evidence.find(item => item.kind === 'user_confirmation' && item.sourceId === condition.id);
        if (condition.requiresUserConfirmation) return { conditionId: condition.id, status: confirmation ? 'met' : 'needs_user',
          reason: confirmation ? '[검증용] 사용자가 직접 남긴 확인 기록이 있습니다.' : '[검증용] 사용자 확인 기록을 기다립니다.', evidenceIds: confirmation ? [confirmation.id] : [] };
        return { conditionId: condition.id, status: completedArtifact ? 'met' : 'unmet',
          reason: completedArtifact ? '[검증용] 후속 과제의 고정된 공유 결과가 있습니다.' : '[검증용] 완료 근거를 남기는 후속 과제가 필요합니다.',
          evidenceIds: completedArtifact ? [completedArtifact.id] : [] };
      });
      const unmet = conditions.filter(condition => condition.status === 'unmet');
      result.objectiveAssessment = { inputHash: frozen.inputHash, reason: '[검증용] 실제 모델의 품질 판정이 아닌 화면 검증용 응답입니다.', conditions,
        followUps: unmet.length ? [{ conditionIds: unmet.map(condition => condition.conditionId), title: '검증용 완료 근거 만들기',
          description: '검증용 고정 결과를 공유하고 완료합니다. 실제 외부 작업은 수행하지 않습니다.' }] : [] };
    } else if (input.run.taskDiscovery) {
      const discovery = input.run.taskDiscovery;
      const task = await hooks.onTool!('task_claim', { taskId: discovery.taskId, expectedVersion: discovery.taskVersion }) as TeamTask;
      const artifact = await hooks.onTool!('artifact_publish', { scope: task.scope, name: 'qa/fixture-complete.md', mediaType: 'text/plain',
        content: '[검증용 고정 원문] 후속 과제 결과를 화면에서 조회했습니다. 실제 제품 검증이나 모델 품질의 증거가 아닙니다.' }) as SharedArtifact;
      await hooks.onTool!('task_complete', { taskId: task.id, expectedVersion: task.version,
        outcome: '[검증용] 정해진 공유 원문을 게시한 뒤 과제를 완료했습니다.', artifactIds: [artifact.id] });
      result.memories = [{ kind: 'procedure', title: '검증용 후속 작업 기록', content: '화면 검증에서만 생성한 기억입니다. 실제 품질 개선의 근거가 아닙니다.' }];
    }
    call.completed = true;
    await hooks.onCheckpoint?.({ phase: 'complete', previousResult: result });
    return result;
  }
}
const runtime = new ObjectiveFixture();
const app = await createApp({ dataDir: join(directory, 'db'), runtime, recovery: { maxAttempts: 1 }, allowedOrigins: [origin] });
await app.register(fastifyStatic, { root: resolve('dist') });
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'API not found' }) : reply.sendFile('index.html'));
app.get('/verification/state', async () => ({ modelCalls: 0, directDatabaseSeeds: 0, calls: runtime.calls }));
let closing: Promise<void> | undefined;
const close = () => closing ??= app.close().then(async () => {
  await atomicJson(join(directory, 'closed.json'), { stoppedAt: new Date().toISOString(), modelCalls: 0, calls: runtime.calls });
});
app.post('/verification/stop', async (request, reply) => {
  if (request.headers['x-verification-key'] !== key) return reply.code(403).send({ error: 'Fixture key required' });
  setTimeout(() => { void close(); }, 100); return { stopping: true };
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close(); });
async function seed(path: string, payload: object) {
  const response = await app.inject({ method: 'POST', url: path, payload });
  if (response.statusCode >= 400) throw new Error(`Fixture setup failed: ${path}: ${response.body}`);
  return response.json();
}
const agent = await seed('/api/agents', { name: '검증용 평가 에이전트', persona: '화면 검증용입니다. 실제 외부 작업을 수행하지 않습니다.', model: 'objective-ui-fixture' });
const team = await seed('/api/teams', { name: '검증용 목적팀', memberIds: [agent.id], autoDiscoverTasks: true });
await seed(`/api/agents/${agent.id}/memories`, { kind: 'procedure', title: '검증용 기존 기억', content: '후속 작업에 제공되는 기억의 출처 표시를 검사합니다.' });
await seed('/api/collaboration/artifact_publish', { scope: { type: 'team', id: team.id }, name: 'qa/fixture-input.md', mediaType: 'text/plain', content: '[검증용] 목적 등록 전 공유된 자료입니다.' });
await app.listen({ host: '127.0.0.1', port: 4319 });
await atomicJson(join(directory, 'fixture.json'), { directory, origin, pid: process.pid, key, agentId: agent.id, teamId: team.id, modelCalls: 0, directDatabaseSeeds: 0 });
console.log(JSON.stringify({ directory, origin, pid: process.pid, agentId: agent.id, teamId: team.id, modelCalls: 0 }));
