import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import lockfile from 'proper-lockfile';
import { command, type CommandOptions } from '../server/process.ts';
import { workspaceVolume } from '../server/runtime.ts';
import { atomicJson } from '../server/storage.ts';
import { WorkspaceStore, type WorkspaceState } from '../server/store.ts';
import type { Agent, ExecutionCheckpoint, Run, Workspace } from '../shared/types.ts';
import { campaign } from './lifecycle-campaign.ts';
import { LifecycleClient } from './lifecycle-client.ts';

// This script is an explicitly invoked real campaign, never a unit-test fixture.
// Root owns execution; its persisted shared gate is the sole model-start budget.
const context = await campaign();
const directory = join(context.directory, 'recovery');
const workspaceKey = context.manifest.workspaces.recovery;
const runtime = { ...context.config, workspaceKey };
const client = new LifecycleClient('recovery');
const names = ['worker-kill', 'controller-kill', 'cancel'] as const;
type CaseName = typeof names[number];
const caseSchema = z.object({
  name: z.enum(names), protocol: z.uuid(), prompt: z.string(), agentId: z.uuid().optional(), runId: z.uuid().optional(),
  stage: z.enum(['new', 'run-created', 'ready', 'action-intended', 'interrupted', 'resumed', 'passed']),
  sessionId: z.uuid().optional(), initialAttemptId: z.uuid().optional(), targetContainerId: z.string().optional(),
  actionAt: z.string().optional(), actionReceipt: z.string().optional(), starts: z.number().int().optional(),
  files: z.object({ started: z.string().nullable(), steps: z.string().nullable(), done: z.string().nullable() }).optional(),
  completedAt: z.string().optional(),
});
type CaseState = z.infer<typeof caseSchema>;
const stateSchema = z.object({ version: z.literal(1), workspaceKey: z.uuid(), cases: z.array(caseSchema).length(3) });
type State = z.infer<typeof stateSchema>;
type Files = NonNullable<CaseState['files']>;
const statePath = join(directory, 'state.json');
let errorMessage: string | null = null, finalState: WorkspaceState | undefined;
let controllerOpened = false;

async function regularJson(path: string, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes, `Invalid verification file: ${path}`);
  return JSON.parse(await readFile(path, 'utf8'));
}

function prompt(name: CaseName, protocol: string): string {
  const marker = JSON.stringify({ protocol, case: name });
  const program = [
    'import json, os, time',
    'from pathlib import Path',
    `expected = json.loads(${JSON.stringify(marker)})`,
    `line = ${JSON.stringify(`once:${protocol}\n`)}`,
    'started, steps, done = map(Path, ["started.json", "steps.log", "done.json"])',
    'def save(path, text):',
    '    with path.open("x", encoding="utf-8") as output:',
    '        output.write(text); output.flush(); os.fsync(output.fileno())',
    'if not started.exists():',
    '    save(started, json.dumps(expected, sort_keys=True))',
    '    save(steps, line)',
    '    time.sleep(90)',
    'else:',
    '    assert json.loads(started.read_text(encoding="utf-8")) == expected',
    '    assert steps.read_text(encoding="utf-8") == line',
    'if not done.exists():',
    '    save(done, json.dumps(expected, sort_keys=True))',
    'assert json.loads(done.read_text(encoding="utf-8")) == expected',
    'assert steps.read_text(encoding="utf-8") == line',
    `print(${JSON.stringify(`lifecycle-${name}-ok`)})`,
  ].join('\n');
  return [
    '이 격리 작업공간의 중단·재개를 검증합니다. 아래 Python 표준 라이브러리 코드를 실제 실행합니다. 최초 실행은 파일을 fsync한 뒤 90초 대기하고, 재개 실행은 이미 저장된 marker를 확인하여 중복 쓰기 없이 완료합니다.',
    'started.json·steps.log·done.json을 삭제하거나 덮어쓰지 않습니다. 중단된 세션이면 기존 명령이 계속 실행 중인지 먼저 확인하고, 종료된 명령만 아래 분기로 이어갑니다. 스크립트가 완료되고 실제 파일을 읽어 확인하기 전에 작업을 완료했다고 반환하지 않습니다.',
    `Python 코드:\n${program}`,
    `성공 시 result는 lifecycle-${name}-ok입니다. memories·skills·skillConcerns·artifacts는 모두 빈 배열입니다. 외부·웹·팀 작업과 스킬 생성은 하지 않습니다. 검증 식별자는 ${protocol}입니다.`,
  ].join('\n\n');
}

let state: State;
try { state = stateSchema.parse(await regularJson(statePath)); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  state = { version: 1, workspaceKey, cases: names.map(name => { const protocol = randomUUID(); return { name, protocol, prompt: prompt(name, protocol), stage: 'new' }; }) };
  await atomicJson(statePath, state);
}
assert.equal(state.workspaceKey, workspaceKey);
assert.deepEqual(state.cases.map(item => item.name), [...names]);
const save = () => atomicJson(statePath, state);
const docker = (args: string[], options: CommandOptions = {}) => runtime.wslDistro
  ? command('wsl.exe', ['--distribution', runtime.wslDistro, '--exec', 'docker', ...args], { timeoutMs: 30_000, ...options })
  : command('docker', args, { timeoutMs: 30_000, ...options });
const workspace = () => client.api<Workspace>('/api/workspace');
const runOf = (value: Workspace | WorkspaceState, item: CaseState) => {
  const run = value.runs.find(run => run.id === item.runId);
  assert.ok(run, `Missing verification run ${item.runId}`); return run;
};

async function startController() { controllerOpened = true; await client.start(); }
async function readClosedDatabase(): Promise<WorkspaceState> {
  assert.equal(client.origin, '', 'Close the controller before opening its database');
  const root = join(directory, 'data');
  // The same unmodified lease also prevents accidental inspection of a DB owned
  // by a different, still-live verification controller after startup failure.
  const release = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
  try {
    const store = await WorkspaceStore.open(join(root, 'db'));
    try { return await store.read(); } finally { await store.close(); }
  } finally { await release(); }
}
async function closeAndRead(): Promise<WorkspaceState> {
  await client.stop(); return readClosedDatabase();
}

interface InspectedContainer {
  Id: string; Name: string; State: { Running: boolean };
  Config: { Labels: Record<string, string> };
  Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }>;
}
async function inspectContainer(nameOrId: string): Promise<InspectedContainer | null> {
  assert.match(nameOrId, /^(?:ac-[a-z0-9-]+|[a-f0-9]{64})$/);
  const result = await docker(['inspect', '--type=container', nameOrId]);
  if (result.code !== 0) {
    if (/No such (?:object|container)/i.test(result.stderr)) return null;
    throw new Error(`Cannot inspect owned container: ${result.stderr}`);
  }
  const [container] = JSON.parse(result.stdout) as InspectedContainer[];
  assert.match(container.Id, /^[a-f0-9]{64}$/); return container;
}
function ownedContainer(container: InspectedContainer, runId: string, name: string) {
  assert.equal(container.Name, `/${name}`);
  assert.equal(container.Config.Labels.app, 'agent-company');
  assert.equal(container.Config.Labels['agent-company.workspace'], workspaceKey);
  assert.ok(container.Mounts.some(mount => mount.Type === 'volume' && mount.Name === workspaceVolume(runtime, runId) && mount.Destination === '/workspace'));
}
async function ownedVolume(runId: string): Promise<boolean> {
  const volume = workspaceVolume(runtime, runId);
  const inspected = await docker(['volume', 'inspect', volume, '--format', '{{json .Labels}}']);
  if (inspected.code !== 0) {
    if (/No such volume/i.test(inspected.stderr)) return false;
    throw new Error(`Cannot inspect verification volume: ${inspected.stderr}`);
  }
  const labels = JSON.parse(inspected.stdout) as Record<string, string>;
  assert.equal(labels.app, 'agent-company'); assert.equal(labels['agent-company.workspace'], workspaceKey); assert.equal(labels['agent-company.run'], runId);
  return true;
}

async function files(runId: string): Promise<Files | null> {
  if (!await ownedVolume(runId)) return null;
  const name = `ac-lifecycle-probe-${randomUUID()}`;
  const program = `const fs=require('node:fs');const out={};for(const [key,name] of [['started','started.json'],['steps','steps.log'],['done','done.json']]){try{const path='/workspace/'+name;const stat=fs.lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw Error('Invalid marker');out[key]=fs.readFileSync(path,'utf8')}catch(error){if(error.code!=='ENOENT')throw error;out[key]=null}}process.stdout.write(JSON.stringify(out));`;
  try {
    const read = await docker(['run', '--rm', '--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${workspaceKey}`,
      '--label', `agent-company.run=${runId}`, '--label', 'agent-company.verification=lifecycle-recovery-probe',
      '--read-only', '--network=none', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=64', '--memory=64m', '--cpus=0.25',
      '--mount', `type=volume,source=${workspaceVolume(runtime, runId)},target=/workspace,readonly`, '--entrypoint=node', runtime.image, '-e', program]);
    assert.equal(read.code, 0, read.stderr);
    return caseSchema.shape.files.unwrap().parse(JSON.parse(read.stdout));
  } finally {
    const container = await inspectContainer(name);
    if (container) {
      ownedContainer(container, runId, name);
      assert.equal(container.Config.Labels['agent-company.run'], runId);
      assert.equal(container.Config.Labels['agent-company.verification'], 'lifecycle-recovery-probe');
      const removed = await docker(['rm', '-f', container.Id]); assert.equal(removed.code, 0, removed.stderr);
    }
  }
}
function verifyFiles(item: CaseState, actual: Files, done: boolean) {
  assert.deepEqual(JSON.parse(actual.started ?? ''), { protocol: item.protocol, case: item.name });
  assert.equal(actual.steps, `once:${item.protocol}\n`, 'A resumed task must not repeat the durable step');
  if (done) assert.deepEqual(JSON.parse(actual.done ?? ''), { protocol: item.protocol, case: item.name });
  else assert.equal(actual.done, null, 'The interruption must precede task completion');
}
function available(run: Run) {
  if (run.modelBudgetPaused) throw new Error('The shared 20-start campaign budget is exhausted; existing progress is retained');
  if (run.status === 'failed') throw new Error(`Verification Run failed and was retained: ${run.error}`);
}

async function getOrCreateRun(item: CaseState) {
  let current = await workspace();
  const name = `Lifecycle recovery ${item.name} ${item.protocol.slice(0, 8)}`;
  const agent = current.agents.find(agent => agent.id === item.agentId || agent.name === name)
    ?? await client.api<Agent>('/api/agents', { name, persona: '검증 공간 안에서 저장된 marker와 세션을 사용해 중복 쓰기 없이 작업을 이어가는 개인 에이전트입니다.', model: runtime.model, allowWeb: false });
  item.agentId = agent.id; await save();
  current = await workspace();
  let run = current.runs.find(run => run.id === item.runId || (run.agentId === agent.id && run.prompt === item.prompt));
  if (!run) {
    const ledger = await context.budget.read();
    const needed = item.name === 'cancel' ? 1 : 2;
    assert.ok(ledger.limit - ledger.starts.length >= needed, `This case needs ${needed} model starts; existing campaign state is retained`);
    run = await client.api<Run>(`/api/agents/${agent.id}/runs`, { prompt: item.prompt });
  }
  assert.equal(run.agentId, agent.id); assert.equal(run.prompt, item.prompt);
  item.runId = run.id;
  if (item.stage === 'new') item.stage = 'run-created';
  await save();
}

async function waitReady(item: CaseState) {
  const deadline = Date.now() + runtime.timeoutMs + 60_000;
  while (Date.now() < deadline) {
    const current = await workspace(), run = runOf(current, item); available(run);
    assert.ok(!['succeeded', 'cancelled'].includes(run.status), 'Task ended before its intended interruption');
    let checkpoint: ExecutionCheckpoint | undefined;
    try { checkpoint = await regularJson(join(directory, 'checkpoints', `${item.runId}.json`)) as ExecutionCheckpoint; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (run.status === 'running' && checkpoint?.phase === 'task' && checkpoint.sessionId) {
      z.uuid().parse(checkpoint.sessionId);
      const observed = await files(item.runId!);
      if (observed?.started && observed.steps) {
        verifyFiles(item, observed, false);
        const attempt = current.modelAttempts?.find(attempt => attempt.runId === item.runId && attempt.status === 'started' && attempt.phase === 'task');
        assert.ok(attempt, 'A started attempt must be durable before interruption');
        item.sessionId = checkpoint.sessionId; item.initialAttemptId = attempt.id; item.files = observed; item.stage = 'ready'; await save();
        return;
      }
    }
    await delay(1000);
  }
  throw new Error('No durable session checkpoint and fsynced marker appeared before the deadline');
}
async function waitTerminal(item: CaseState, expected: 'succeeded' | 'cancelled') {
  const deadline = Date.now() + runtime.timeoutMs + 120_000;
  while (Date.now() < deadline) {
    const current = await workspace(), run = runOf(current, item); available(run);
    if (['succeeded', 'cancelled'].includes(run.status)) {
      assert.equal(run.status, expected);
      if (current.agents.find(agent => agent.id === item.agentId)?.status === 'idle') return current;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${expected}; existing Run is retained`);
}

async function performAction(item: CaseState) {
  if (item.name === 'worker-kill') {
    const name = `ac-${item.runId}-task`;
    const container = await inspectContainer(name);
    assert.ok(container?.State.Running, 'Expected task container is not running');
    ownedContainer(container, item.runId!, name);
    assert.ok(container.Mounts.some(mount => mount.Destination === '/workspace' && mount.RW));
    item.targetContainerId = container.Id; item.stage = 'action-intended'; await save();
    const killed = await docker(['kill', '--signal=KILL', container.Id]); assert.equal(killed.code, 0, killed.stderr);
    item.actionReceipt = `docker kill acknowledged ${container.Id}`;
  } else if (item.name === 'controller-kill') {
    item.stage = 'action-intended'; await save();
    await client.stop(true);
    item.actionReceipt = 'Owned controller SIGKILL and child exit acknowledged';
  } else {
    item.stage = 'action-intended'; await save();
    await client.api(`/api/runs/${item.runId}/cancel`, {});
    item.actionReceipt = 'Explicit cancellation API acknowledged';
  }
  item.actionAt = new Date().toISOString(); item.stage = 'interrupted'; await save();
  if (item.name === 'controller-kill') {
    console.log('Waiting 31 seconds for the unchanged production controller lease to become stale');
    await delay(31_000); await startController();
  }
}

function verifyStored(item: CaseState, stored: WorkspaceState) {
  const run = runOf(stored, item), expectedStarts = item.name === 'cancel' ? 1 : 2;
  assert.equal(run.status, item.name === 'cancel' ? 'cancelled' : 'succeeded');
  const attempts = stored.modelAttempts.filter(attempt => attempt.runId === item.runId);
  assert.equal(attempts.length, expectedStarts, 'Unexpected automatic retry or duplicate model start');
  assert.ok(attempts.some(attempt => attempt.id === item.initialAttemptId && attempt.status !== 'succeeded'));
  assert.equal(stored.executionStates[item.runId!]?.lastSessionId, item.sessionId, 'Resume must keep the same Codex session');
  assert.equal(attempts.some(attempt => attempt.status === 'started'), false);
  if (item.name !== 'cancel') assert.equal(run.result.trim(), `lifecycle-${item.name}-ok`);
  item.starts = attempts.length;
}

try {
  // Ambiguous interruption cannot authorize killing a replacement worker or a
  // second controller. Leave its evidence intact for the root campaign owner.
  assert.ok(!state.cases.some(item => item.stage === 'action-intended'), 'An unacknowledged prior interruption requires evidence review; no replacement Run was created');
  for (const item of state.cases) {
    if (item.stage === 'passed') { console.log(`Reusing completed case ${item.name}`); continue; }
    console.log(`Recovery case ${item.name}: ${item.stage}`);
    await startController();
    await getOrCreateRun(item);
    if (['new', 'run-created', 'ready'].includes(item.stage)) { await waitReady(item); await performAction(item); }
    if (item.name === 'cancel') {
      const before = await waitTerminal(item, 'cancelled');
      const ids = before.modelAttempts?.filter(attempt => attempt.runId === item.runId).map(attempt => attempt.id);
      await client.stop(); await startController();
      await delay(5000);
      const after = await workspace(); assert.equal(runOf(after, item).status, 'cancelled');
      assert.deepEqual(after.modelAttempts?.filter(attempt => attempt.runId === item.runId).map(attempt => attempt.id), ids);
    } else await waitTerminal(item, 'succeeded');
    const actual = await files(item.runId!); assert.ok(actual); verifyFiles(item, actual, item.name !== 'cancel');
    item.files = actual; item.stage = 'resumed'; await save();
    finalState = await closeAndRead(); verifyStored(item, finalState);
    const starts = (await context.budget.read()).starts.filter(start => start.runId === item.runId);
    assert.equal(starts.length, item.starts, 'Shared ledger and durable attempt count must agree');
    item.stage = 'passed'; item.completedAt = new Date().toISOString(); await save();
  }
  assert.equal(state.cases.reduce((total, item) => total + (item.starts ?? 0), 0), 5);
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error); process.exitCode = 1; console.error(errorMessage);
} finally {
  try {
    if (controllerOpened) {
      await client.stop();
      finalState = await readClosedDatabase();
    }
  } catch (error) {
    errorMessage ??= error instanceof Error ? error.message : String(error); process.exitCode = 1;
  }
  const ledger = await context.budget.read();
  let previous: { runs?: unknown; modelAttempts?: unknown } = {};
  if (!finalState) {
    try { previous = await regularJson(join(directory, 'report.json')) as typeof previous; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const report = { status: errorMessage ? 'incomplete' : 'passed', error: errorMessage, completedAt: new Date().toISOString(),
    workspaceKey, limit: ledger.limit, campaignStarts: ledger.starts.length, recoveryStarts: ledger.starts.filter(start => state.cases.some(item => item.runId === start.runId)).length,
    cases: state.cases, runs: finalState?.runs ?? previous.runs, modelAttempts: finalState?.modelAttempts ?? previous.modelAttempts,
    verificationDataRetained: true, productionConfigurationChanged: false, originalVolumesDeleted: false };
  await atomicJson(join(directory, 'report.json'), report);
  console.log(JSON.stringify({ status: report.status, recoveryStarts: report.recoveryStarts, campaignStarts: report.campaignStarts, report: join(directory, 'report.json') }));
}
