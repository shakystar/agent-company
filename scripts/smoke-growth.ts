import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { secureDirectory } from '../server/storage.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import type { Agent, Run } from '../shared/types.ts';

if (existsSync('.env')) loadEnvFile('.env');
// A stable campaign path makes reruns share the approved ten-start ledger.
// This is deliberately not mkdtemp: restarting the script must not reset its cap.
const directory = resolve('.verification/growth-20260906');
await secureDirectory(directory);
const manifestPath = join(directory, 'manifest.json');
let manifest: { version: 1; ownerKey: string; protocol: string };
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  manifest = { version: 1, ownerKey: randomUUID(), protocol: randomUUID() };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
}
assert.equal(manifest.version, 1); assert.match(manifest.ownerKey, /^[a-f0-9-]{36}$/);
assert.match(manifest.protocol, /^[a-f0-9-]{36}$/);
const budget = new FileModelBudget(directory, 10);
const config = runtimeConfig();
assert.equal(config.mode, 'docker'); assert.equal(config.auth, 'codex');
const runtime = new ContainerRuntime({ ...config, workspaceKey: manifest.ownerKey, persistentWorkspaces: true, timeoutMs: 900_000 });
let service: AgentService | undefined, finalState: WorkspaceState | undefined, errorMessage: string | null = null;
const verified: Record<string, boolean> = {};

async function waitForRun(id: string): Promise<Run> {
  let lastEvent: string | undefined;
  for (;;) {
    const state = await service!.workspace(), run = state.runs.find(item => item.id === id)!;
    const event = state.activities.find(item => item.runId === id);
    if (event && event.id !== lastEvent) { lastEvent = event.id; console.log(`${run.kind ?? 'task'}: ${event.title} ${event.detail}`); }
    if (state.runs.some(item => item.agentId === run.agentId && item.status === 'queued' && item.modelBudgetPaused)) {
      throw new Error('승인된 모델 실행 한도에 도달하여 진행 상태를 보존했습니다.');
    }
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      if (run.status !== 'succeeded') throw new Error(`${run.status}: ${run.error}`);
      // A complete result can precede the worker/resource cleanup acknowledgement.
      if (state.agents.find(item => item.id === run.agentId)?.status === 'idle') return run;
    }
    await delay(1000);
  }
}

async function task(agent: Agent, prompt: string): Promise<Run> {
  const state = await service!.workspace();
  const existing = state.runs.find(item => item.agentId === agent.id && item.prompt === prompt);
  return waitForRun((existing ?? await service!.startRun(agent.id, prompt)).id);
}

try {
  console.log(`검증 캠페인: ${directory}; 기존 모델 시작 ${(await budget.read()).starts.length}/10`);
  service = await AgentService.create({ dataDir: join(directory, 'data', 'db'), runtime,
    storage: { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: manifest.ownerKey },
    beforeModelStart: async request => {
      await budget.reserve(request);
      const ledger = await budget.read(); console.log(`모델 시작 ${ledger.starts.length}/10: ${request.phase} (${request.kind})`);
    },
  });
  let state = await service.workspace();
  const original = state.agents.find(item => item.name === 'Growth verification original') ?? await service.createAgent({
    name: 'Growth verification original', persona: '로컬 CSV 자료의 금액과 누락·중복을 검증하고 근거 파일을 남기는 개인 에이전트입니다.', model: config.model,
  });
  if (!original.workspaceRunId && !state.runs.some(item => item.agentId === original.id)) {
    await service.importFile({ scope: { type: 'agent', id: original.id }, path: 'input.csv', mediaType: 'text/csv',
      base64: Buffer.from('id,amount\na,10.50\nb,-2.00\na,9.00\nc,0.25\nd,\n').toString('base64') });
  }
  const firstPrompt = [
    'input.csv를 Python 표준 라이브러리로 읽고 금액을 Decimal로 합산합니다. id 중복은 처음 행만 채택하고 이후 행은 거절합니다. 금액이 비어 있는 행도 거절합니다.',
    `proof.json에 {"total":소수점 둘째 자리 문자열,"accepted":채택 행수,"rejected":거절 행수,"protocol":"${manifest.protocol}"}를 기록합니다. 명령을 실제 실행하고 파일을 다시 읽어 검증합니다.`,
    `개인 기억에 제목 "검증 프로토콜", 내용 "이 검증 공간의 보고서 protocol 식별자는 ${manifest.protocol}입니다."를 남깁니다.`,
    '이번 작업에서 확인한 절차를 재사용 가능한 스킬 후보 1개로 제안합니다. 개선 여부를 스스로 단정하지 않습니다. result는 growth-initial-ok로, artifacts에는 proof.json의 실제 내용을 반환합니다.',
  ].join('\n');
  const first = await task(original, firstPrompt);
  assert.equal(first.result.trim(), 'growth-initial-ok');
  const initialProof = (await service.downloadWorkspaceFile(original.id, 'proof.json')).bytes;
  assert.deepEqual(JSON.parse(initialProof.toString('utf8')), { total: '8.75', accepted: 3, rejected: 2, protocol: manifest.protocol });
  verified.actualTaskFile = true;
  state = await service.workspace();
  assert.ok(state.memories.some(item => item.agentId === original.id && item.content.includes(manifest.protocol)));
  assert.ok(state.skillRevisions?.some(item => item.agentId === original.id && item.origin === 'candidate'));
  assert.ok(state.growthReviews?.some(item => item.sourceRunId === first.id && item.comparison?.judgeAttemptId));
  verified.memoryPersisted = true; verified.independentComparison = true;
  const sourceBefore = state.agents.find(item => item.id === original.id)!;
  const memoryBefore = structuredClone(state.memories.filter(item => item.agentId === original.id));
  const skillsBefore = structuredClone(state.skills.filter(item => item.agentId === original.id));
  const snapshot = state.snapshots.find(item => item.agentId === original.id && item.label === 'growth-verification-clone')
    ?? await service.createSnapshot(original.id, 'growth-verification-clone');
  const clone = state.agents.find(item => item.name === 'Growth verification clone')
    ?? await service.forkAgent(original.id, { name: 'Growth verification clone', snapshotId: snapshot.id });
  await task(clone, '개인 기억에서 검증 프로토콜의 식별자를 읽습니다. Python으로 clone-proof.json에 {"protocol":그 식별자,"owner":"clone"}를 기록하고 다시 읽어 검증합니다. 기존 proof.json은 수정하지 않습니다. result는 clone-memory-ok로 반환합니다. 새 기억·스킬·skillConcerns는 빈 배열입니다.');
  assert.deepEqual(JSON.parse((await service.downloadWorkspaceFile(clone.id, 'clone-proof.json')).bytes.toString('utf8')),
    { protocol: manifest.protocol, owner: 'clone' });
  assert.deepEqual((await service.downloadWorkspaceFile(original.id, 'proof.json')).bytes, initialProof);
  await assert.rejects(service.downloadWorkspaceFile(original.id, 'clone-proof.json'));
  state = await service.workspace();
  assert.equal(state.agents.find(item => item.id === original.id)!.workspaceRunId, sourceBefore.workspaceRunId);
  assert.deepEqual(state.memories.filter(item => item.agentId === original.id), memoryBefore);
  assert.deepEqual(state.skills.filter(item => item.agentId === original.id), skillsBefore);
  verified.cloneMemoryReuse = true; verified.originalUnchanged = true;
  const cloneMemory = state.memories.find(item => item.agentId === clone.id && item.content.includes(manifest.protocol))!;
  assert.ok(cloneMemory); assert.ok(!memoryBefore.some(item => item.id === cloneMemory.id));
  await task(original, '개인 기억의 검증 프로토콜 식별자를 읽습니다. Python으로 followup.json에 {"protocol":그 식별자,"owner":"original"}를 기록하고 다시 읽어 확인합니다. result는 original-memory-ok로 반환합니다. 새 기억·스킬·skillConcerns는 빈 배열입니다.');
  assert.deepEqual(JSON.parse((await service.downloadWorkspaceFile(original.id, 'followup.json')).bytes.toString('utf8')),
    { protocol: manifest.protocol, owner: 'original' });
  verified.originalMemoryReuse = true;
  console.log('실제 작업·기억 재사용·비교·복제 후 원본 보존 검사를 통과했습니다.');
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
  console.error(errorMessage); process.exitCode = 1;
} finally {
  if (service) {
    await service.close();
    const saved = await WorkspaceStore.open(join(directory, 'data', 'db'));
    try { finalState = await saved.read(); verified.databaseReopened = true; }
    finally { await saved.close(); }
  }
  // User data/auth and verification results are retained; the runtime settles its workers.
  const ledger = await budget.read();
  const report = { completedAt: new Date().toISOString(), status: errorMessage ? 'incomplete' : 'passed', error: errorMessage,
    campaign: directory, modelStarts: ledger.starts.length, limit: ledger.limit, verified,
    runs: finalState?.runs, modelAttempts: finalState?.modelAttempts, growthReviews: finalState?.growthReviews,
    repairJobs: finalState?.repairJobs, verificationDataRetained: true,
    actualRollbackRepairValidated: false, note: '복귀·재수정 전체 경로는 자동 테스트로 별도 검증하며 이 실제 모델 검사는 개선 판정을 강제하지 않습니다.' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, verified, modelStarts: ledger.starts.length, limit: 10, report: join(directory, 'report.json') }));
}
