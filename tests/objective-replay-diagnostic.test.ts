import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replayDiagnosticGate } from '../scripts/verify-objective-replay.ts';
import type { ModelStartRequest } from '../shared/telemetry.ts';
import { BudgetPauseError } from '../shared/telemetry.ts';

test('diagnostic uses the operating outer gate and same durable campaign records with a three-start ceiling', async () => {
  const runId = randomUUID(), attribution = { rootRunId: randomUUID(), projectId: null, teamId: randomUUID(), agentId: randomUUID() };
  const starts: Array<ModelStartRequest & { sequence: number; recordedAt: string }> = [];
  const trace: string[] = [], operatingStarts: ModelStartRequest[] = [];
  const campaign = { status: async () => ({ version: 1 as const, limit: 10, starts: structuredClone(starts) }),
    reserve: async (request: ModelStartRequest) => { trace.push('campaign'); starts.push({ ...request, sequence: starts.length + 1, recordedAt: new Date().toISOString() }); } };
  const operating = { reserve: async (request: ModelStartRequest, source: typeof attribution, beforeCommit?: () => Promise<void>) => {
    trace.push('operating-check'); assert.deepEqual(source, attribution); await beforeCommit?.(); trace.push('operating-record'); operatingStarts.push(request);
  } };
  const request = (kind: string, phase: 'trial' | 'evaluate'): ModelStartRequest => ({ runId, phase, kind, reason: 'Verifier diagnostic' });
  await replayDiagnosticGate(operating, campaign, runId, attribution)(request('baseline-trial', 'trial'));
  await replayDiagnosticGate(operating, campaign, runId, attribution)(request('candidate-trial', 'trial'));
  await replayDiagnosticGate(operating, campaign, runId, attribution)(request('comparison-judge', 'evaluate'));
  assert.deepEqual(trace, Array.from({ length: 3 }, () => ['operating-check', 'campaign', 'operating-record']).flat());
  assert.equal(starts.length, 3); assert.equal(operatingStarts.length, 3);
  const restartedGate = replayDiagnosticGate(operating, campaign, runId, attribution);
  await assert.rejects(restartedGate(request('baseline-trial', 'trial')), BudgetPauseError);
  assert.equal(starts.length, 3); assert.equal(operatingStarts.length, 3);
  await assert.rejects(restartedGate({ ...request('baseline-trial', 'trial'), runId: randomUUID() }), /another Run/);
  await assert.rejects(restartedGate({ ...request('baseline-trial', 'trial'), phase: 'task' }), /Only the two trials/);
});

test('operating or existing campaign exhaustion cannot be bypassed by the diagnostic', async () => {
  const runId = randomUUID(), attribution = { rootRunId: runId, projectId: null }, request: ModelStartRequest = {
    runId, phase: 'trial', kind: 'baseline-trial', reason: 'Verifier diagnostic' };
  let campaignCalls = 0, operatingRecords = 0;
  const campaign = { status: async () => ({ version: 1 as const, limit: 10, starts: [] }), reserve: async () => { campaignCalls++; throw new BudgetPauseError('Existing campaign cap'); } };
  const blockedOperating = { reserve: async () => { throw new BudgetPauseError('Operating cap'); } };
  await assert.rejects(replayDiagnosticGate(blockedOperating, campaign, runId, attribution)(request), /Operating cap/);
  assert.equal(campaignCalls, 0);
  const operating = { reserve: async (_request: ModelStartRequest, _attribution: typeof attribution, beforeCommit?: () => Promise<void>) => { await beforeCommit?.(); operatingRecords++; } };
  await assert.rejects(replayDiagnosticGate(operating, campaign, runId, attribution)(request), /Existing campaign cap/);
  assert.equal(campaignCalls, 1); assert.equal(operatingRecords, 0);
});
