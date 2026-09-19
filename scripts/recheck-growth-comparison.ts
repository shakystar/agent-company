import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { FileModelBudget } from '../server/model-budget.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { WorkspaceStore } from '../server/store.ts';

// Follow-up to the same campaign, not a second allowance. A stored candidate is
// manually selected in verification data solely to exercise the existing review API.
// This selection is not evidence of automatic promotion or quality improvement.
if (existsSync('.env')) loadEnvFile('.env');
const directory = resolve('.verification/growth-20260906');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const initial = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
assert.equal(initial.status, 'passed'); assert.equal(manifest.version, 1);
assert.match(manifest.ownerKey, /^[a-f0-9-]{36}$/);
const budget = new FileModelBudget(directory, 10), config = runtimeConfig();
assert.equal(config.mode, 'docker'); assert.equal(config.auth, 'codex');
const runtime = new ContainerRuntime({ ...config, workspaceKey: manifest.ownerKey, persistentWorkspaces: true, timeoutMs: 900_000 });
const service = await AgentService.create({ dataDir: join(directory, 'data', 'db'), runtime,
  storage: { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: manifest.ownerKey },
  beforeModelStart: async request => {
    await budget.reserve(request);
    console.log(`모델 시작 ${(await budget.read()).starts.length}/10: ${request.kind}`);
  },
});
let errorMessage: string | null = null, runId: string | undefined;
try {
  let state = await service.workspace();
  const original = state.agents.find(item => item.name === 'Growth verification original')!;
  const candidate = state.skillRevisions!.find(item => item.agentId === original.id && item.origin === 'candidate')!;
  assert.ok(candidate?.sourceRunId);
  const already = state.runs.find(item => item.agentId === original.id && item.kind === 'review');
  const beforeMemories = structuredClone(state.memories.filter(item => item.agentId === original.id));
  const beforeFiles = original.workspaceRunId;
  if (already) runId = already.id;
  else {
    const selected = await service.addSkill(original.id, { name: candidate.name, description: candidate.description, content: candidate.content });
    runId = (await service.reviewSkill(selected.id, candidate.sourceRunId!)).id;
  }
  for (;;) {
    state = await service.workspace();
    const run = state.runs.find(item => item.id === runId)!;
    if (state.runs.some(item => item.agentId === original.id && item.status === 'queued' && item.modelBudgetPaused)) throw new Error('캠페인 한도 도달: 진행을 보존했습니다.');
    if (run.status === 'failed' || run.status === 'cancelled') throw new Error(run.error ?? run.status);
    if (run.status === 'succeeded' && state.agents.find(item => item.id === original.id)!.status === 'idle') break;
    await delay(1000);
  }
  assert.deepEqual(state.memories.filter(item => item.agentId === original.id), beforeMemories);
  assert.equal(state.agents.find(item => item.id === original.id)!.workspaceRunId, beforeFiles);
  const review = state.growthReviews!.find(item => item.sourceRunId === runId)!;
  assert.ok(review?.comparison?.verified); assert.ok(review.comparison.judgeAttemptId);
  console.log(JSON.stringify({ verdict: review.verdict, decision: review.decision, reason: review.reason }));
} catch (error) { errorMessage = error instanceof Error ? error.message : String(error); process.exitCode = 1; console.error(errorMessage); }
finally {
  await service.close();
  const saved = await WorkspaceStore.open(join(directory, 'data', 'db'));
  try {
    const state = await saved.read(), ledger = await budget.read();
    const report = { completedAt: new Date().toISOString(), status: errorMessage ? 'incomplete' : 'passed', error: errorMessage,
      modelStarts: ledger.starts.length, limit: 10, manuallySelectedVerificationCandidate: true,
      automaticPromotionValidated: false, automaticRollbackRepairValidated: false, runId,
      run: state.runs.find(item => item.id === runId), review: state.growthReviews.find(item => item.sourceRunId === runId),
      modelAttempts: state.modelAttempts.filter(item => item.runId === runId), databaseReopened: true };
    await writeFile(join(directory, 'comparison-recheck.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, modelStarts: ledger.starts.length, report: join(directory, 'comparison-recheck.json') }));
  } finally { await saved.close(); }
}
