import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../server/storage.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import type { Agent, Run } from '../shared/types.ts';
import type { EnvironmentRevision } from '../shared/environment.ts';
import { environmentCampaign } from './environment-campaign.ts';

// The approved campaign is durable across retries. Failed scenarios are retained
// and require an explicit, evidence-based revision of the affected prompt/code.
const { directory, manifest, budget } = await environmentCampaign();
let child: ChildProcess | undefined, origin = '', finalState: WorkspaceState | undefined;
const verified: Record<string, boolean> = {};
let errorMessage: string | null = null;
const nonce = manifest.workspaceKey;
const spec = { packages: [{ name: 'csv-parse', version: '7.0.2' }, { name: '@modelcontextprotocol/server-everything', version: '2026.8.31' }],
  servers: [{ name: 'everything', package: '@modelcontextprotocol/server-everything', bin: 'mcp-server-everything', args: [], probe: { tool: 'echo', arguments: { message: 'environment-probe' } } }] };

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
const state = () => api<WorkspaceState>('/api/workspace');
async function file(agent: Agent, path: string) {
  const response = await fetch(`${origin}/api/agents/${agent.id}/files/download?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, 200, `Missing actual workspace file ${path}`); return response.text();
}
async function waitRun(id: string): Promise<Run> {
  let last = '';
  for (let count = 0; count < 1800; count++) {
    const current = await state(), run = current.runs.find(item => item.id === id)!;
    assert.ok(run);
    const event = current.activities.find(item => item.runId === id);
    if (event && event.id !== last) { last = event.id; console.log(`${run.kind ?? 'task'}: ${event.title} ${event.detail.slice(0, 700)}`); }
    if (run.modelBudgetPaused) throw new Error('Approved model-start ceiling reached; work is preserved.');
    if (['failed', 'cancelled'].includes(run.status)) throw new Error(`${run.kind ?? 'task'} ${run.status}: ${run.error}`);
    if (run.status === 'succeeded' && current.agents.find(item => item.id === run.agentId)?.status === 'idle') return run;
    await delay(1000);
  }
  throw new Error(`Run did not settle within the verification observation window: ${id}`);
}
async function task(agent: Agent, prompt: string) {
  const previous = (await state()).runs.find(item => item.agentId === agent.id && item.prompt === prompt);
  const run = previous ?? await api<Run>(`/api/agents/${agent.id}/runs`, { prompt }); return waitRun(run.id);
}
async function waitEnvironment(id: string) {
  for (let count = 0; count < 900; count++) {
    const current = await state(), revision = current.environmentRevisions.find(item => item.id === id)!;
    assert.ok(revision);
    if (['ready', 'failed', 'cancelled', 'blocked'].includes(revision.status)
      && current.agents.find(item => item.id === revision.agentId)?.status === 'idle') return revision;
    await delay(1000);
  }
  throw new Error(`Environment did not settle: ${id}`);
}
const noGrowth = 'For this bounded functional verification return memories, skills, skillConcerns as empty arrays. Do not request peer work or create other goals. environmentProposal must be null unless this task explicitly requests one.';
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(child.connected, 'Owned verification controller IPC must remain available');
  const exited = once(child, 'exit'); child.send({ type: 'close' });
  await Promise.race([exited, delay(120_000, undefined, { ref: false }).then(() => { throw new Error('Owned controller cleanup did not finish'); })]);
  assert.equal(child.exitCode, 0);
}

try {
  child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/serve-environment-verification.ts')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.on('data', bytes => process.stdout.write(bytes)); child.stderr!.on('data', bytes => process.stderr.write(bytes));
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller startup timed out')), 150_000);
    child!.once('error', error => { clearTimeout(timer); reject(error); }); child!.once('exit', code => { if (!origin) { clearTimeout(timer); reject(new Error(`Controller exited ${code}`)); } });
    child!.on('message', message => {
      const value = message as { type?: string; origin?: string; pid?: number };
      if (value.type === 'ready') { assert.equal(value.pid, child!.pid); assert.equal(value.origin, 'http://127.0.0.1:4315'); origin = value.origin!; clearTimeout(timer); accept(); }
    });
  });
  // Browser checks are performed through the browser skill before model work.
  if (process.argv.includes('--browser-gate')) {
    console.log('BROWSER_GATE: controller ready; press Enter after browser verification.');
    process.stdin.resume(); await once(process.stdin, 'data'); process.stdin.pause();
  }
  verified.httpHealthy = (await api<{ status: string }>('/api/health')).status === 'ok';
  let current = await state();
  const original = current.agents.find(item => item.name === 'Environment verification original') ?? await api<Agent>('/api/agents', {
    name: 'Environment verification original', persona: 'A local CSV analyst who uses explicit package paths and recorded MCP results. Report only executed work.', model: 'gpt-6-astra' });
  const proposalRun = await task(original, [
    'This is a controlled environment-construction integration test, not an open-ended package discovery task.',
    `Request this exact environment using the final environmentProposal field: ${JSON.stringify(spec)}.`,
    'Use reason: CSV parsing and an MCP echo fixture are required for the next task. requestedAccess is []. Follow the final response schema, encoding probe arguments as argumentsJson if that schema requires it.',
    'Do not install packages yourself or change local Codex configuration. The platform will build the proposal after this task completes. Set result to environment-proposal-ok.', noGrowth,
  ].join('\n'));
  assert.equal(proposalRun.result.trim(), 'environment-proposal-ok');
  current = await state();
  const proposed = current.environmentRevisions.find(item => item.sourceRunId === proposalRun.id)!;
  assert.ok(proposed, 'Actual model must produce the environment proposal');
  const ready = await waitEnvironment(proposed.id); assert.equal(ready.status, 'ready', ready.error ?? 'Environment was not ready');
  assert.equal((await state()).agents.find(item => item.id === original.id)!.environmentRevisionId, ready.id);
  verified.modelProposal = true; verified.automaticLockedBuild = true; verified.automaticActivation = true;
  assert.ok(ready.report?.checks.every(item => item.passed));
  const csv = 'name,amount\n"alpha, one",10.50\nbeta,-2.00\ngamma,0.25\n';
  const workRun = await task(original, [
    `Use csv-parse from /opt/agent-environment/environment/node_modules/csv-parse/dist/cjs/sync.cjs through an explicit Node require path to parse ${JSON.stringify(csv)} with columns:true.`,
    `Call the registered environment_call tool with server=everything, tool=echo, arguments={"message":"${nonce}"}. Actually invoke it; do not simulate its response.`,
    `Create proof.json in your actual workspace with {"total":"8.75","rows":3,"first":"alpha, one","nonce":"${nonce}"} after verifying parsed values and the real MCP echo.`,
    'Read proof.json back. Set result to environment-use-ok and include its actual content as an artifact.', noGrowth,
  ].join('\n'));
  assert.equal(workRun.result.trim(), 'environment-use-ok');
  const originalProof = await file(original, 'proof.json'); assert.deepEqual(JSON.parse(originalProof), { total: '8.75', rows: 3, first: 'alpha, one', nonce });
  const calls = (await readFile(join(directory, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(call => call.runId === workRun.id && call.tool === 'echo' && call.args.message === nonce && JSON.stringify(call.result).includes(nonce)));
  verified.actualPackageUse = true; verified.actualMcpCall = true; verified.actualWorkspaceProof = true;
  current = await state();
  const snapshot = current.snapshots.find(item => item.agentId === original.id && item.label === 'environment-verified')
    ?? await api<{ id: string }>(`/api/agents/${original.id}/snapshots`, { label: 'environment-verified' });
  const clone = current.agents.find(item => item.name === 'Environment verification clone')
    ?? await api<Agent>(`/api/agents/${original.id}/fork`, { name: 'Environment verification clone', snapshotId: snapshot.id, persona: 'An independent audit agent that reuses its cloned environment without changing the original agent.' });
  current = await state(); const cloneRevision = current.environmentRevisions.find(item => item.id === clone.environmentRevisionId)!;
  assert.ok(cloneRevision); assert.notEqual(cloneRevision.id, ready.id); assert.equal(cloneRevision.buildRunId, ready.buildRunId);
  await task(clone, [
    'Use the explicit csv-parse sync.cjs package path described in .agent/environment.json to parse "a,b\\n1,2\\n". Verify two parsed rows.',
    `Call environment_call with server=everything, tool=echo, arguments={"message":"clone-${nonce}"}. Write clone-proof.json containing {"owner":"clone","nonce":"${nonce}"} after successful execution.`,
    'Do not modify proof.json. Set result to clone-environment-ok.', noGrowth,
  ].join('\n'));
  assert.deepEqual(JSON.parse(await file(clone, 'clone-proof.json')), { owner: 'clone', nonce });
  assert.equal(await file(original, 'proof.json'), originalProof);
  const originalFiles = await api<{ entries: Array<{ path: string }> }>(`/api/agents/${original.id}/files`);
  assert.ok(!originalFiles.entries.some(item => item.path === 'clone-proof.json'));
  verified.clonedImmutableBundle = true; verified.independentWorkspaces = true;
  await api(`/api/agents/${clone.id}/environments/select`, { revisionId: null });
  await task(clone, [
    'Verify /opt/agent-environment is absent using the shell. Do not create that path or install anything. Write isolation-proof.json with {"environmentAbsent":true} only after confirming absence.',
    'Set result to environment-detached-ok.', noGrowth,
  ].join('\n'));
  assert.deepEqual(JSON.parse(await file(clone, 'isolation-proof.json')), { environmentAbsent: true });
  assert.equal((await state()).agents.find(item => item.id === original.id)!.environmentRevisionId, ready.id);
  verified.detachIsolation = true;
  await api(`/api/agents/${clone.id}/environments/select`, { revisionId: cloneRevision.id });
  const blocked = await api<EnvironmentRevision>(`/api/agents/${original.id}/environments`, { reason: 'Negative access expansion verification', spec, requestedAccess: ['authenticated remote MCP account'] });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.buildRunId, null); verified.accessExpansionBlocked = true;
  const badSpec = { packages: spec.packages, servers: [{ ...spec.servers[0], probe: { tool: 'nonexistent-environment-verification-tool', arguments: {} } }] };
  current = await state();
  const failed = current.environmentRevisions.find(item => item.agentId === original.id && item.reason === 'Negative MCP probe verification after retry classification fix')
    ?? await api<EnvironmentRevision>(`/api/agents/${original.id}/environments`, { reason: 'Negative MCP probe verification after retry classification fix', spec: badSpec, requestedAccess: [] });
  const settled = await waitEnvironment(failed.id); assert.equal(settled.status, 'failed'); assert.match(settled.error ?? '', /tool|MCP/i);
  assert.equal((await state()).runs.find(item => item.id === settled.buildRunId)!.attempt, 1, 'Functional rejection must not automatically replay');
  assert.equal((await state()).agents.find(item => item.id === original.id)!.environmentRevisionId, ready.id); verified.failedProbeKeepsActive = true;
  const forbidden = await fetch(`${origin}/api/agents/${clone.id}/environments/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revisionId: ready.id }) });
  assert.equal(forbidden.status, 409); verified.foreignSelectionDenied = true;
  const beforePause = (await budget.read()).starts.length;
  await api(`/api/agents/${clone.id}`, { status: 'paused' }, 'PATCH');
  const pending = await api<EnvironmentRevision>(`/api/agents/${clone.id}/environments`, { reason: 'Cancel queued environment verification', spec: { packages: [{ name: 'csv-parse', version: '7.0.2' }], servers: [] }, requestedAccess: [] });
  await api(`/api/environments/${pending.id}/cancel`, {});
  await api(`/api/agents/${clone.id}`, { status: 'idle' }, 'PATCH');
  assert.equal((await state()).environmentRevisions.find(item => item.id === pending.id)!.status, 'cancelled');
  assert.equal((await budget.read()).starts.length, beforePause); verified.cancelWithoutModelStart = true;
  finalState = await state();
} catch (error) { errorMessage = error instanceof Error ? error.message : String(error); console.error(errorMessage); process.exitCode = 1; }
finally {
  try {
    if (origin) finalState = await state();
    await stop();
    if (origin) {
      const store = await WorkspaceStore.open(join(directory, 'data', 'db'));
      try { finalState = await store.read(); verified.databaseReopened = true; } finally { await store.close(); }
    }
  } catch (error) { errorMessage ??= String(error); process.exitCode = 1; }
  const ledger = await budget.read();
  const report = { completedAt: new Date().toISOString(), status: errorMessage ? 'incomplete' : 'passed', error: errorMessage,
    modelStarts: ledger.starts.length, limit: ledger.limit, verified, environmentRevisions: finalState?.environmentRevisions,
    runs: finalState?.runs, modelAttempts: finalState?.modelAttempts, controlledFixture: spec, verificationDataRetained: true };
  await atomicJson(join(directory, `report-${report.completedAt.replace(/:/g, '-')}.json`), report);
  await atomicJson(join(directory, 'report.json'), report);
  console.log(JSON.stringify({ status: report.status, error: errorMessage, verified, modelStarts: ledger.starts.length, limit: 100, report: join(directory, 'report.json') }));
}
