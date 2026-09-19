import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import fastifyStatic from '@fastify/static';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { GitHubOperationJournal } from '../server/github-journal.ts';
import { ResourceScheduler } from '../server/resources.ts';
import { atomicJson, secureDirectory } from '../server/storage.ts';
import type { ServiceOptions } from '../server/service.ts';
import type { RuntimeDriver, Workspace } from '../shared/types.ts';

// No environment loader, GitHub authentication, network client, process runner,
// ContainerRuntime, or model client. All writable state belongs to this fixture.
const repository = resolve(import.meta.dirname, '..');
const directory = join(repository, '.verification', 'github-20260909', 'browser-fixture');
const origin = 'http://127.0.0.1:4318';
const remoteRepository = 'formnest-studio/studio-site';
const fixture = 'github-browser-no-model-no-network' as const;
const manifestPath = join(directory, 'fixture.json');
const counts = { realModelStarts: 0, realGitHubRequests: 0, realDockerStarts: 0,
  credentialReads: 0, directDatabaseSeeds: 0 } as const;
const manifestSchema = z.object({ version: z.literal(1), fixture: z.literal(fixture),
  directory: z.literal(directory), ownerKey: z.uuid(), createdAt: z.iso.datetime(),
  journalIdentity: z.uuid().optional(), ids: z.object({ developer: z.uuid().optional(), reviewer: z.uuid().optional(),
    team: z.uuid().optional(), project: z.uuid().optional(), connection: z.uuid().optional() }).strict() }).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Transport = NonNullable<ServiceOptions['github']>['transport'];
if (process.argv.length !== 2) throw new Error('This fixture takes no command-line options.');
async function exists(path: string) {
  return Boolean(await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }));
}
async function boundedJson(path: string) {
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.size <= 64 * 1024,
    'Fixture metadata must be a bounded independent file');
  return JSON.parse(await readFile(path, 'utf8'));
}
const runtime: RuntimeDriver = {
  async inspect() {
    return { mode: 'docker', available: false, authenticated: false, simulation: true,
      image: 'fixture:no-container', model: 'github-browser-fixture-no-model', version: 'fixture',
      message: 'GitHub UI 모의 검증입니다. 실제 모델·GitHub·Docker·인증 접근은 0회이며 작업 실행은 차단됩니다.' };
  },
  async execute() { throw new Error('GitHub 브라우저 fixture는 실제 작업을 실행하지 않습니다.'); },
};
const mockCalls: Array<{ operation: 'inspect'; repository: string; at: string }> = [];
let mockInspectionCount = 0;
function mockTransport(guard: () => Promise<void> = async () => {}): Transport {
  const unsupported = async () => { await guard(); throw new Error('이 모의 fixture는 저장소 접속 확인만 지원합니다.'); };
  return {
    async inspect(name, signal) {
      await guard(); signal?.throwIfAborted();
      assert.equal(name, remoteRepository, 'Only the fixture repository is supported');
      mockInspectionCount += 1;
      mockCalls.push({ operation: 'inspect', repository: name, at: new Date().toISOString() });
      if (mockCalls.length > 100) mockCalls.shift();
      return { id: 1362601656, fullName: name, defaultBranch: 'main', private: true };
    },
    listFiles: unsupported, readFile: unsupported, publish: unsupported,
    pullRequest: unsupported, getPullRequest: unsupported,
  };
}
await secureDirectory(directory);
const release = await lockfile.lock(join(directory, 'controller'), { realpath: false,
  lockfilePath: join(directory, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let cleanupHarness: (() => void) | undefined;
let released = false;
const unlock = async () => { if (!released) { released = true; await release(); } };
try {
  let manifest: Manifest;
  if (await exists(manifestPath)) manifest = manifestSchema.parse(await boundedJson(manifestPath));
  else {
    for (const child of ['db', 'github-operations']) {
      assert.equal(await exists(join(directory, child)), false, 'Never adopt or reset unmarked fixture state');
    }
    manifest = { version: 1, fixture, directory, ownerKey: randomUUID(), createdAt: new Date().toISOString(), ids: {} };
    await atomicJson(manifestPath, manifest);
  }
  const journal = await GitHubOperationJournal.open({ directory: join(directory, 'github-operations'),
    ownerKey: manifest.ownerKey, allowCreate: !manifest.journalIdentity, expectedIdentity: manifest.journalIdentity });
  manifest.journalIdentity = journal.identity;
  await atomicJson(manifestPath, manifest);
  const dist = join(repository, 'dist');
  assert.ok(await exists(join(dist, 'index.html')), 'Build dist before starting the browser fixture');
  const fixtureHtml = (await readFile(join(dist, 'index.html'), 'utf8'))
    .replace(/<title>[^<]*<\/title>/, '<title>[모의 GitHub 검증 · 4318] Agent Company</title>')
    .replace('<body>', '<body><div role="note" style="position:sticky;top:0;z-index:10000;padding:6px 12px;background:#613d08;color:#fff;font:13px sans-serif;text-align:center">4318 · GitHub UI 모의 검증 · 실제 모델/GitHub/Docker/인증 접근 0회 · 작업 실행 차단</div>');
  app = await createApp({ dataDir: join(directory, 'db'), runtime,
    scheduler: new ResourceScheduler({ capacity: { memoryMiB: 2048, cpus: 2 },
      defaultRequest: { minimum: { memoryMiB: 1024, cpus: 1 }, preferred: { memoryMiB: 1024, cpus: 1 } } }),
    beforeModelStart: async () => { throw new Error('브라우저 fixture에서는 모델 호출을 허용하지 않습니다.'); },
    github: { transport: mockTransport(), transportFor: guard => mockTransport(guard), journal,
      status: () => ({ configured: true, writable: true, missing: [], repositories: [remoteRepository] }) } });
  app.get('/', async (_request, reply) => reply.type('text/html').send(fixtureHtml));
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'API not found' }) : reply.type('text/html').send(fixtureHtml));
  const verificationState = () => ({ fixture, ...counts, origin, directory, pid: process.pid,
    ids: manifest.ids, mockInspectionCount, mockCalls, journalIdentity: journal.identity });
  app.get('/verification/state', async () => verificationState());
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
  for (const [key, name] of [['developer', '[GitHub 검증 fixture] 개발'], ['reviewer', '[GitHub 검증 fixture] QA']] as const) {
    const current = await workspace();
    const found = manifest.ids[key] ? current.agents.find(agent => agent.id === manifest.ids[key]) : current.agents.find(agent => agent.name === name);
    if (manifest.ids[key] && !found) throw new Error('An existing fixture agent is missing; no reset was performed');
    await remember(key, found?.id ?? (await post('/api/agents', { name, persona: 'GitHub UI 모의 검증용입니다. 실제 작업은 실행하지 않습니다.',
      model: 'github-browser-fixture-no-model', allowWeb: false, repositoryIds: [] })).id);
  }
  const current = await workspace();
  const existingTeam = manifest.ids.team ? current.teams.find(team => team.id === manifest.ids.team)
    : current.teams.find(team => team.name === '[GitHub 검증 fixture] 제작 팀');
  if (manifest.ids.team && !existingTeam) throw new Error('An existing fixture team is missing; no reset was performed');
  const teamId = await remember('team', existingTeam?.id ?? (await post('/api/teams', { name: '[GitHub 검증 fixture] 제작 팀',
    memberIds: [manifest.ids.developer!, manifest.ids.reviewer!], autoDiscoverTasks: false })).id);
  const existingProject = manifest.ids.project ? current.projects?.find(project => project.id === manifest.ids.project)
    : current.projects?.find(project => project.name === '[GitHub 검증 fixture] 대표 사이트');
  if (manifest.ids.project && !existingProject) throw new Error('An existing fixture project is missing; no reset was performed');
  await remember('project', existingProject?.id ?? (await post('/api/collaboration/project_create', {
    name: '[GitHub 검증 fixture] 대표 사이트', teamIds: [teamId] }, 200)).id);
  const existingConnection = manifest.ids.connection ? current.connections.find(connection => connection.id === manifest.ids.connection)
    : current.connections.find(connection => connection.repository === remoteRepository);
  if (manifest.ids.connection && !existingConnection) throw new Error('An existing fixture connection is missing; no reset was performed');
  await remember('connection', existingConnection?.id ?? (await post('/api/connections', { repository: remoteRepository, access: 'write' })).id);
  // Keep a newly seeded connection unverified and without grants for browser interaction.
  const commands = createInterface({ input: process.stdin });
  cleanupHarness = () => commands.close();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    cleanupHarness!();
    try {
      const state = await workspace();
      await atomicJson(join(directory, 'api-before-close.json'), { ...verificationState(), generatedAt: new Date().toISOString(),
        agents: state.agents, teams: state.teams, projects: state.projects, connections: state.connections, runs: state.runs });
      await app!.close(); app = undefined;
      await atomicJson(join(directory, 'closed.json'), { ...verificationState(), stoppedAt: new Date().toISOString() });
      console.log(JSON.stringify({ type: 'fixture_stopped', ...counts }));
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
  await app.listen({ host: '127.0.0.1', port: 4318 });
  await atomicJson(join(directory, 'running.json'), { ...verificationState(), startedAt: new Date().toISOString() });
  console.log(JSON.stringify({ type: 'fixture_ready', ...verificationState() }));
} catch (error) {
  cleanupHarness?.();
  try { await app?.close(); } finally { await unlock(); }
  throw error;
}
