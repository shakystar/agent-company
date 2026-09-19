import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import fastifyStatic from '@fastify/static';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { OperationalModelBudget } from '../server/operational-budget.ts';
import { atomicJson, secureDirectory } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { OperationalFixtureRuntime, resources, type BudgetCall } from '../tests/operational-budget-fixture.ts';
import type { ExecutionHooks, ExecutionInput, ExecutionResult, Workspace } from '../shared/types.ts';
import type { OperationalBudgetStatus } from '../shared/operational-budget.ts';

// Deliberately imports no environment loader, authentication, ContainerRuntime,
// process runner, or real model client. Every writable path is below this fixture.
const repository = resolve(import.meta.dirname, '..');
const directory = join(repository, '.verification', 'scoped-budget-20260907', 'browser-fixture');
const origin = 'http://127.0.0.1:4317';
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--report')) throw new Error('Supported option: --report');
const reportOnly = args.includes('--report');
const manifestPath = join(directory, 'fixture.json');
const manifestSchema = z.object({ version: z.literal(1), fixture: z.literal('scoped-budget-browser-no-model'),
  directory: z.literal(directory), ownerKey: z.uuid(), createdAt: z.iso.datetime(),
  realModelStarts: z.literal(0), directDatabaseSeeds: z.literal(0),
  ids: z.object({ teamAgent: z.uuid().optional(), personalAgent: z.uuid().optional(),
    team: z.uuid().optional(), project: z.uuid().optional() }).strict() }).strict();
type Manifest = z.infer<typeof manifestSchema>;
async function exists(path: string) {
  return Boolean(await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }));
}
async function boundedJson(path: string) {
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.size <= 4 * 1024 * 1024,
    'Fixture metadata must be a bounded independent file');
  return JSON.parse(await readFile(path, 'utf8'));
}
if (reportOnly && !await exists(manifestPath)) throw new Error('Existing browser fixture is required for --report');
await secureDirectory(directory);
const release = await lockfile.lock(join(directory, 'controller'), { realpath: false,
  lockfilePath: join(directory, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let cleanupHarness: (() => void) | undefined;
let released = false;
const unlock = async () => { if (!released) { released = true; await release(); } };

class BrowserFixtureRuntime extends OperationalFixtureRuntime {
  override async inspect() {
    return { mode: 'docker' as const, available: true, authenticated: true, simulation: true,
      image: 'fixture:no-container', model: 'scoped-budget-browser-fixture-no-model', version: 'fixture',
      message: '격리된 브라우저 검증 fixture입니다. 실제 모델·Docker·인증 접근은 0회입니다.' };
  }
  override async execute(input: ExecutionInput, hooks: ExecutionHooks): Promise<ExecutionResult> {
    if (input.checkpoint?.phase === 'complete' && input.checkpoint.previousResult) return input.checkpoint.previousResult;
    return super.execute(input, hooks);
  }
}
const policy = (status: OperationalBudgetStatus) => ({ revision: status.revision, dailyLimit: status.dailyLimit,
  projectDailyLimits: status.projectDailyLimits, teamDailyLimits: status.teamDailyLimits ?? {}, agentDailyLimits: status.agentDailyLimits ?? {} });
function projection(state: Pick<Workspace, 'agents' | 'teams' | 'projects' | 'runs' | 'conversations'>) {
  return { agents: state.agents.map(agent => ({ id: agent.id, name: agent.name, status: agent.status, model: agent.model })),
    teams: state.teams.map(team => ({ id: team.id, name: team.name, memberIds: team.memberIds })),
    projects: (state.projects ?? []).map(project => ({ id: project.id, name: project.name, teamIds: project.teamIds })),
    conversations: (state.conversations ?? []).map(room => ({ id: room.id, scope: room.scope,
      budgetProjectId: room.budgetProjectId, budgetTeamId: room.budgetTeamId })),
    runs: state.runs.map(run => ({ id: run.id, agentId: run.agentId, status: run.status, result: run.result,
      budgetProjectId: run.budgetProjectId, budgetTeamId: run.budgetTeamId, budgetRootRunId: run.budgetRootRunId,
      modelBudgetPaused: run.modelBudgetPaused, modelBudgetBlock: run.modelBudgetBlock })) };
}

try {
  let manifest: Manifest;
  if (await exists(manifestPath)) manifest = manifestSchema.parse(await boundedJson(manifestPath));
  else {
    assert.equal(await exists(join(directory, 'db')), false, 'Never adopt or reset an unmarked database');
    assert.equal(await exists(join(directory, 'operational-budget')), false, 'Never reset a pre-existing ledger');
    manifest = { version: 1, fixture: 'scoped-budget-browser-no-model', directory, ownerKey: randomUUID(),
      createdAt: new Date().toISOString(), realModelStarts: 0, directDatabaseSeeds: 0, ids: {} };
    await atomicJson(manifestPath, manifest);
  }
  const budget = await OperationalModelBudget.open({ directory: join(directory, 'operational-budget'), ownerKey: manifest.ownerKey });
  async function offlineReport(api?: Workspace) {
    assert.ok(await exists(join(directory, 'db')), 'Fixture database is missing');
    const store = await WorkspaceStore.open(join(directory, 'db'));
    try {
      const state = await store.read();
      const status = await budget.status(state.projects.map(project => project.id), {
        teamIds: state.teams.map(team => team.id), agentIds: state.agents.map(agent => agent.id),
      });
      const report = { fixture: manifest.fixture, realModelStarts: 0, directDatabaseSeeds: 0,
        generatedAt: new Date().toISOString(), source: 'closed-fixture-PGlite-and-ledger', directory, origin,
        ids: manifest.ids, policy: status, database: projection(state),
        checks: { fixtureAgentsPresent: [manifest.ids.teamAgent, manifest.ids.personalAgent].every(id => state.agents.some(agent => agent.id === id)),
          apiPolicyMatchesLedger: api?.modelBudget ? isDeepStrictEqual(policy(api.modelBudget), policy(status)) : null,
          apiAgentIdsMatchDatabase: api ? isDeepStrictEqual(api.agents.map(agent => agent.id).sort(), state.agents.map(agent => agent.id).sort()) : null } };
      await atomicJson(join(directory, 'offline-report.json'), report);
      return report;
    } finally { await store.close(); }
  }
  if (reportOnly) {
    const report = await offlineReport();
    console.log(JSON.stringify({ type: 'fixture_offline_report', path: join(directory, 'offline-report.json'),
      realModelStarts: 0, revision: report.policy.revision, checks: report.checks }));
    await unlock();
  } else {
    const dist = join(repository, 'dist');
    assert.ok(await exists(join(dist, 'index.html')), 'Build dist before starting the browser fixture');
    const runtime = new BrowserFixtureRuntime();
    app = await createApp({ dataDir: join(directory, 'db'), runtime, scheduler: resources(2), operationalBudget: budget });
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'API not found' }) : reply.sendFile('index.html'));
    app.get('/verification/state', async () => ({ fixture: manifest.fixture, realModelStarts: 0, directDatabaseSeeds: 0,
      origin, directory, ids: manifest.ids, fixtureCalls: runtime.calls.map(call => ({ runId: call.input.run.id,
        agentId: call.input.agent.id, projectId: call.input.run.budgetProjectId, teamId: call.input.run.budgetTeamId })) }));
    async function workspace(): Promise<Workspace> {
      const response = await app!.inject('/api/workspace');
      assert.equal(response.statusCode, 200, response.body); return response.json();
    }
    async function post(path: string, body: object, expected = 201) {
      const response = await app!.inject({ method: 'POST', url: path, payload: body });
      assert.equal(response.statusCode, expected, response.body); return response.json() as { id: string };
    }
    async function remember(key: keyof Manifest['ids'], id: string) {
      assert.ok(!manifest.ids[key] || manifest.ids[key] === id, 'Fixture identity changed');
      manifest.ids[key] = id; await atomicJson(manifestPath, manifest); return id;
    }
    for (const [key, name] of [['teamAgent', '[검증 fixture] 팀 에이전트'], ['personalAgent', '[검증 fixture] 개인 에이전트']] as const) {
      const current = await workspace();
      const found = manifest.ids[key] ? current.agents.find(agent => agent.id === manifest.ids[key]) : current.agents.find(agent => agent.name === name);
      if (manifest.ids[key] && !found) throw new Error('An existing fixture agent is missing; no reset was performed');
      await remember(key, found?.id ?? (await post('/api/agents', { name, persona: '브라우저 검증 fixture입니다. 실제 모델을 호출하지 않습니다.',
        model: 'scoped-budget-browser-fixture-no-model', allowWeb: false, repositoryIds: [] })).id);
    }
    const current = await workspace();
    const existingTeam = manifest.ids.team ? current.teams.find(team => team.id === manifest.ids.team) : current.teams.find(team => team.name === '[검증 fixture] 원팀');
    if (manifest.ids.team && !existingTeam) throw new Error('An existing fixture team is missing; no reset was performed');
    const teamId = await remember('team', existingTeam?.id ?? (await post('/api/teams', { name: '[검증 fixture] 원팀', memberIds: [manifest.ids.teamAgent!] })).id);
    const existingProject = manifest.ids.project ? current.projects?.find(project => project.id === manifest.ids.project)
      : current.projects?.find(project => project.name === '[검증 fixture] 한도 프로젝트');
    if (manifest.ids.project && !existingProject) throw new Error('An existing fixture project is missing; no reset was performed');
    await remember('project', existingProject?.id ?? (await post('/api/collaboration/project_create', {
      name: '[검증 fixture] 한도 프로젝트', teamIds: [teamId] }, 200)).id);

    const handled = new WeakSet<BudgetCall>(), finishing = new Set<Promise<void>>();
    const pump = setInterval(() => {
      for (const call of runtime.calls) {
        if (handled.has(call)) continue;
        handled.add(call);
        const completed = (async () => {
          try {
            call.hooks.signal.throwIfAborted();
            await call.hooks.onEvent('[브라우저 검증 fixture] 실제 모델·컨테이너 호출 없이 결과를 완료합니다.');
            const appliedSteeringCount = (await call.hooks.getSteering()).length;
            const result: ExecutionResult = { result: `[브라우저 검증 fixture · 실제 모델 호출 0회] ${call.input.agent.name}의 모의 작업이 완료됐습니다.`,
              memories: [], skills: [], artifacts: [], inputTokens: 0, outputTokens: 0, appliedSteeringCount,
              ...(call.input.run.interactionMode !== 'task' ? { route: 'discuss' as const } : {}) };
            await call.hooks.onCheckpoint?.({ phase: 'complete', previousResult: result, appliedSteeringCount });
            call.finish(result);
          } catch (error) { call.fail(error instanceof Error ? error : new Error('Fixture completion failed')); }
        })();
        finishing.add(completed); void completed.finally(() => finishing.delete(completed));
      }
    }, 100);
    pump.unref();
    let stopping: Promise<void> | undefined;
    const commands = createInterface({ input: process.stdin });
    cleanupHarness = () => { clearInterval(pump); commands.close(); };
    const stop = () => stopping ??= (async () => {
      cleanupHarness!();
      try {
        await Promise.allSettled([...finishing]);
        const api = await workspace();
        await atomicJson(join(directory, 'api-before-close.json'), { generatedAt: new Date().toISOString(),
          fixture: manifest.fixture, realModelStarts: 0, modelBudget: api.modelBudget, ...projection(api) });
        await app!.close(); app = undefined;
        const report = await offlineReport(api);
        await atomicJson(join(directory, 'closed.json'), { stoppedAt: new Date().toISOString(), pid: process.pid,
          fixture: manifest.fixture, realModelStarts: 0, checks: report.checks });
        console.log(JSON.stringify({ type: 'fixture_stopped', realModelStarts: 0, checks: report.checks }));
      } finally {
        try { await app?.close(); app = undefined; } finally { await unlock(); if (process.connected) process.disconnect(); }
      }
    })().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture shutdown failed'); process.exitCode = 1; });
    commands.on('line', line => { if (line.trim() === 'stop') void stop(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop(); });
    process.on('message', message => {
      if (message === 'stop' || message && typeof message === 'object' && 'type' in message
        && ['stop', 'shutdown', 'close'].includes(String(message.type))) void stop();
    });
    process.on('disconnect', () => { void stop(); });
    await app.listen({ host: '127.0.0.1', port: 4317 });
    await atomicJson(join(directory, 'running.json'), { startedAt: new Date().toISOString(), pid: process.pid,
      origin, fixture: manifest.fixture, realModelStarts: 0, directDatabaseSeeds: 0, ids: manifest.ids });
    console.log(JSON.stringify({ type: 'fixture_ready', origin, directory, pid: process.pid, realModelStarts: 0, ids: manifest.ids }));
  }
} catch (error) {
  cleanupHarness?.();
  try { await app?.close(); } finally { await unlock(); }
  throw error;
}
