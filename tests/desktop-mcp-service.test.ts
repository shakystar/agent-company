import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AgentService } from '../server/service.ts';
import { activeStorage, type StorageConfig } from '../server/storage.ts';
import { WorkspaceStore } from '../server/store.ts';
import { boundedDesktopMcpResult, DesktopMcpServiceError, desktopMcpTools } from '../server/desktop-mcp-service.ts';
import type { DesktopMcpGrant } from '../shared/desktop-mcp.ts';
import type { Project, SharedArtifact, TeamTask } from '../shared/collaboration.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import { waitFor } from './operational-budget-fixture.ts';

const denied = (code: string) => (error: unknown) => error instanceof DesktopMcpServiceError && error.code === code;
const internal = (service: AgentService) => service as unknown as { store: WorkspaceStore };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-desktop-mcp-service-'));
  const config: StorageConfig = { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: randomUUID(), freeSpace: async () => 100 * 1024 ** 3 };
  const runtime = new StorageFixtureRuntime(config.ownerKey);
  const service = await AgentService.create({ dataDir: join(config.rootDir, 'db'), runtime, storage: config });
  t.after(async () => {
    await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'ac-desktop-mcp-service-')));
    await rm(directory, { recursive: true });
  });
  const alice = await service.createAgent({ name: 'Public Alice', persona: 'PRIVATE_PERSONA_SENTINEL' });
  const outsider = await service.createAgent({ name: 'OTHER_SCOPE_AGENT_SENTINEL', persona: 'PRIVATE_OTHER_PERSONA' });
  const team = await service.createTeam({ name: 'Allowed team', description: 'Shared team description', workflow: 'Shared workflow', memberIds: [alice.id], autoDiscoverTasks: false });
  const otherTeam = await service.createTeam({ name: 'OTHER_SCOPE_TEAM_SENTINEL', memberIds: [outsider.id], autoDiscoverTasks: false });
  const project = await service.collaboration('project_create', { name: 'Allowed project', teamIds: [team.id, otherTeam.id] }) as Project;
  const grant: DesktopMcpGrant = { id: randomUUID(), label: 'Editor client', scope: { type: 'team', id: team.id }, submitTasks: true,
    budgetTeamId: team.id, generationKey: config.ownerKey, createdAt: new Date().toISOString(), revokedAt: null };
  const call = async (operation: string, args: unknown = {}, selected = grant): Promise<any> => service.desktopMcp(selected, operation, args);
  const publish = async (scope = grant.scope, content = 'Shared content') => service.collaboration('artifact_publish', { scope, name: `${randomUUID()}.txt`, content }) as Promise<SharedArtifact>;
  return { service, config, runtime, alice, outsider, team, otherTeam, project, grant, call, publish };
}

test('desktop MCP tools expose only scoped public operations and reject operator, actor, scope and budget injection', async t => {
  const f = await fixture(t);
  assert.deepEqual(desktopMcpTools.map(tool => tool.name), ['app_context', 'app_task_list', 'app_task_read', 'app_task_create', 'app_artifact_list', 'app_artifact_read', 'app_run_read']);
  for (const tool of desktopMcpTools) assert.equal(tool.inputSchema.additionalProperties, false);
  const result = await f.call('app_context');
  assert.equal(result.scope.id, f.team.id); assert.equal(result.members.items.length, 1); assert.equal(result.members.items[0].name, f.alice.name);
  const text = JSON.stringify(result);
  for (const hidden of ['PRIVATE_PERSONA_SENTINEL', 'OTHER_SCOPE_AGENT_SENTINEL', 'OTHER_SCOPE_TEAM_SENTINEL', f.project.id]) assert.equal(text.includes(hidden), false);
  for (const operation of ['project_update', 'task_claim', 'agent_start', 'operator_request_decide', '__proto__']) {
    await assert.rejects(f.call(operation), denied('MCP_INPUT_INVALID'));
  }
  for (const extra of [{ scope: { type: 'team', id: f.otherTeam.id } }, { actor: null }, { grant: f.grant }, { budgetTeamId: f.otherTeam.id }, { assigneeAgentId: f.alice.id }]) {
    await assert.rejects(f.call('app_task_create', { title: 'Denied', idempotencyKey: 'denied', ...extra }), denied('MCP_INPUT_INVALID'));
  }
  for (const page of [{ limit: 21 }, { offset: -1 }, { limit: 0 }, { offset: 0.5 }]) await assert.rejects(f.call('app_task_list', page), denied('MCP_INPUT_INVALID'));
  assert.equal((await f.service.workspace()).teamTasks!.length, 0);
  assert.equal(f.runtime.calls.length, 0);
});

test('desktop MCP creation atomically records external provenance and isolates retry keys without starting agents', async t => {
  const f = await fixture(t), input = { title: 'Client request', description: 'Scoped delivery', idempotencyKey: 'same-local-key' };
  const results = await Promise.all([f.call('app_task_create', input), f.call('app_task_create', input), f.call('app_task_create', input)]);
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  const first = results[0], otherGrant = { ...f.grant, id: randomUUID(), label: 'X'.repeat(100) };
  const second = await f.call('app_task_create', input, otherGrant); assert.notEqual(first.id, second.id);
  assert.equal(second.source.label, otherGrant.label);
  await assert.rejects(f.call('app_task_create', { ...input, description: 'Changed retry body' }), denied('MCP_CONFLICT'));
  await assert.rejects(f.call('app_task_create', { title: 'Missing key' }), denied('MCP_INPUT_INVALID'));
  await assert.rejects(f.call('app_task_create', input, { ...f.grant, submitTasks: false }), denied('MCP_SUBMIT_DENIED'));
  const state = await f.service.workspace(), task = state.teamTasks!.find(task => task.id === first.id)!;
  assert.equal(state.teamTasks!.length, 2); assert.equal(task.createdByAgentId, null);
  assert.deepEqual(task.externalClient, { id: f.grant.id, label: f.grant.label });
  assert.equal(task.status, 'open'); assert.equal(task.assigneeAgentId, null);
  assert.equal(task.budgetTeamId, f.team.id); assert.equal(task.budgetProjectId, null);
  assert.match(task.idempotencyKey!, new RegExp(`^desktop:${f.grant.id}:[a-f0-9]{64}$`));
  assert.equal(JSON.stringify(first).includes(task.idempotencyKey!), false);
  assert.equal(first.source.type, 'externalClient'); assert.equal(first.source.label, f.grant.label);
  assert.equal(f.runtime.calls.length, 0); assert.equal(state.runs.length, 0);
  const list = await f.call('app_task_list', { limit: 1 }); assert.equal(list.items.length, 1); assert.equal(list.total, 2); assert.equal(list.nextOffset, 1);
  assert.equal((await f.call('app_task_list', { offset: 1, limit: 1 })).nextOffset, null);
  const operator = await f.service.collaboration('task_create', { scope: f.grant.scope, title: 'Operator origin', budgetProjectId: null,
    idempotencyKey: `desktop:${f.grant.id}:${createHash('sha256').update('reserved-key').digest('hex')}` }) as TeamTask;
  await assert.rejects(f.call('app_task_create', { title: 'Operator origin', idempotencyKey: 'reserved-key' }), denied('MCP_CONFLICT'));
  assert.equal((await f.service.workspace()).teamTasks!.find(task => task.id === operator.id)!.externalClient, undefined);
});

test('desktop MCP rechecks live scope and project origin-team linkage for reads and creation', async t => {
  const f = await fixture(t), projectGrant = { ...f.grant, id: randomUUID(), scope: { type: 'project' as const, id: f.project.id }, budgetTeamId: f.team.id };
  await f.service.validateDesktopMcpGrantScope(projectGrant);
  const task = await f.call('app_task_create', { title: 'Project request', idempotencyKey: 'project-one' }, projectGrant);
  assert.equal((await f.service.workspace()).teamTasks!.find(item => item.id === task.id)!.budgetTeamId, f.team.id);
  await assert.rejects(f.call('app_task_create', { title: 'Unselected team', idempotencyKey: 'project-two' }, { ...projectGrant, budgetTeamId: null }), denied('MCP_SCOPE_DENIED'));
  const readGrant = { ...projectGrant, submitTasks: false, budgetTeamId: null };
  assert.equal((await f.call('app_context', {}, readGrant)).members.items.length, 2);
  await f.service.collaboration('project_update', { projectId: f.project.id, expectedVersion: f.project.version, name: f.project.name, description: '', teamIds: [f.otherTeam.id] });
  await assert.rejects(f.call('app_task_read', { taskId: task.id }, projectGrant), denied('MCP_SCOPE_DENIED'));
  const changed = await f.call('app_context', {}, readGrant); assert.equal(changed.members.items.length, 1); assert.equal(changed.members.items[0].id, f.outsider.id);
  await assert.rejects(f.call('app_context', {}, { ...f.grant, revokedAt: new Date().toISOString() }), denied('MCP_SCOPE_DENIED'));
  await internal(f.service).store.change(state => { state.teams = state.teams.filter(team => team.id !== f.team.id); });
  await assert.rejects(f.call('app_context'), denied('MCP_SCOPE_DENIED'));
});

test('desktop MCP shared artifact access is scope exact and Unicode paging preserves every character', async t => {
  const f = await fixture(t), content = `${'a'.repeat(255)}😀한글${'b'.repeat(300)}`;
  const artifact = await f.publish(f.grant.scope, content);
  const outside = await f.publish({ type: 'team', id: f.otherTeam.id }, 'OTHER_SCOPE_CONTENT_SENTINEL');
  const list = await f.call('app_artifact_list'); assert.equal(list.total, 1); assert.equal(list.items[0].id, artifact.id);
  assert.equal(JSON.stringify(list).includes(content), false);
  await assert.rejects(f.call('app_artifact_read', { artifactId: outside.id }), denied('MCP_NOT_FOUND'));
  let offset: number | null = 0, joined = '';
  while (offset !== null) {
    const page = await f.call('app_artifact_read', { artifactId: artifact.id, offset, limit: 1 });
    assert.equal(page.content.items.length, 1); assert.ok(Array.from(page.content.items[0].text).length <= 256);
    assert.equal(page.content.totalCharacters, Array.from(content).length);
    joined += page.content.items[0].text; offset = page.content.nextOffset;
  }
  assert.equal(joined, content); assert.equal(joined.includes('\ufffd'), false);
});

test('desktop MCP run reads require actual task claims and omit prompts, raw errors and private artifacts', async t => {
  const f = await fixture(t), created = await f.call('app_task_create', { title: 'Complete scoped task', description: 'Request text', idempotencyKey: 'run-task' });
  const run = await f.service.startTeamTask(created.id, f.alice.id, created.version);
  await waitFor(() => f.runtime.calls.length === 1);
  const artifact = await f.publish(), outside = await f.publish({ type: 'team', id: f.otherTeam.id }, 'OTHER_SCOPE_ARTIFACT');
  await f.runtime.calls[0].hooks.onTool!('task_complete', { taskId: created.id, expectedVersion: created.version + 1, outcome: 'Shared task outcome', artifactIds: [artifact.id] });
  f.runtime.calls[0].finish();
  await waitFor(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'succeeded');
  const privateRunId = randomUUID(), result = `${'😀'.repeat(256)}public remainder`;
  await internal(f.service).store.change(state => {
    const current = state.runs.find(item => item.id === run.id)!;
    current.result = result; current.error = 'PRIVATE_RAW_ERROR_TOKEN'; current.prompt = 'PRIVATE_PROMPT_SENTINEL';
    current.artifacts = [{ id: randomUUID(), name: 'PRIVATE_ARTIFACT_NAME', mediaType: 'text/plain', content: 'PRIVATE_ARTIFACT_CONTENT' }];
    state.teamTasks.find(item => item.id === created.id)!.artifactIds.push(outside.id);
    state.runs.push({ ...structuredClone(current), id: privateRunId, result: 'UNCLAIMED_RESULT' });
  });
  const output = await f.call('app_run_read', { runId: run.id, offset: 0, limit: 1 }), serialized = JSON.stringify(output);
  for (const hidden of ['PRIVATE_RAW_ERROR_TOKEN', 'PRIVATE_PROMPT_SENTINEL', 'PRIVATE_ARTIFACT_NAME', 'PRIVATE_ARTIFACT_CONTENT', 'OTHER_SCOPE_ARTIFACT', outside.id]) assert.equal(serialized.includes(hidden), false);
  assert.equal(output.artifacts.items.length, 1); assert.equal(output.artifacts.items[0].id, artifact.id);
  assert.equal(output.result.items[0].text, '😀'.repeat(256)); assert.equal(output.result.nextOffset, 1);
  const final = await f.call('app_run_read', { runId: run.id, offset: 1, limit: 1 }); assert.equal(final.result.items[0].text, 'public remainder');
  await assert.rejects(f.call('app_run_read', { runId: privateRunId }), denied('MCP_NOT_FOUND'));
  await assert.rejects(f.call('app_run_read', { runId: run.id }, { ...f.grant, scope: { type: 'team', id: f.otherTeam.id }, budgetTeamId: f.otherTeam.id }), denied('MCP_NOT_FOUND'));
  const task = await f.call('app_task_read', { taskId: created.id }); assert.equal(task.status, 'done'); assert.equal(task.text.items.map((item: { text: string }) => item.text).join(''), 'Request textShared task outcome');
  assert.ok(Buffer.byteLength(serialized) <= 64 * 1024);
});

test('desktop MCP uses existing opt-in task discovery and never changes team policy or resumes work', async t => {
  const f = await fixture(t);
  await f.service.updateTeam(f.team.id, { autoDiscoverTasks: true });
  const task = await f.call('app_task_create', { title: 'Discover normal open task', idempotencyKey: 'discover-one' });
  await waitFor(() => f.runtime.calls.length === 1);
  const state = await f.service.workspace();
  assert.equal(state.taskDiscoveries!.length, 1); assert.equal(state.taskDiscoveries![0].taskId, task.id);
  assert.equal(state.teamTasks!.find(item => item.id === task.id)!.status, 'open');
  assert.equal(state.teamTasks!.find(item => item.id === task.id)!.assigneeAgentId, null);
  assert.equal(state.teams.find(team => team.id === f.team.id)!.autoDiscoverTasks, true);
  await f.service.updateTeam(f.team.id, { autoDiscoverTasks: false }); f.runtime.calls[0].finish();
});

test('desktop MCP denies restore races inside the store queue and rejects old generation grants after real DB restoration', async t => {
  const f = await fixture(t), saved = await f.call('app_task_create', { title: 'Preserved task', idempotencyKey: 'preserved' });
  const backups = await f.service.createBackup(), staged = await f.service.prepareRestore(backups.backups[0].id);
  const store = internal(f.service).store, original = store.changeLocked.bind(store);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  let intercept = true;
  store.changeLocked = async action => { if (intercept) { intercept = false; reached(); await gate; } return original(action); };
  const attempt = f.call('app_task_create', { title: 'Must not cross restore', idempotencyKey: 'restore-race' });
  const deniedAttempt = assert.rejects(attempt, denied('MCP_BUSY'));
  await entered;
  const restoring = f.service.activateRestore(staged.id); release();
  await deniedAttempt; await restoring;
  await assert.rejects(f.call('app_task_list'), denied('MCP_GENERATION_CHANGED'));
  const active = await activeStorage(f.config), currentGrant = { ...f.grant, id: randomUUID(), generationKey: active.workspaceKey };
  const tasks = await f.call('app_task_list', {}, currentGrant); assert.equal(tasks.total, 1); assert.equal(tasks.items[0].id, saved.id);
  assert.deepEqual(tasks.items[0].source, { type: 'externalClient', id: f.grant.id, label: f.grant.label });
  const old = await WorkspaceStore.open(join(f.config.rootDir, 'db'));
  try { assert.equal((await old.read()).teamTasks.length, 1); } finally { await old.close(); }
  assert.equal((await f.service.storageStatus()).paused, true); assert.equal(f.runtime.calls.length, 0);
});

test('desktop MCP bounds worst-case escaped text and redacts unexpected failures', async t => {
  const f = await fixture(t);
  const task = await f.call('app_task_create', { title: '\u0001'.repeat(200), description: '\u0001'.repeat(8000), idempotencyKey: 'bounded' });
  const page = await f.call('app_task_read', { taskId: task.id, limit: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024); assert.equal(page.text.items.length, 20);
  assert.throws(() => boundedDesktopMcpResult({ value: 'x'.repeat(64 * 1024) }), denied('MCP_RESPONSE_LIMIT'));
  const store = internal(f.service).store, original = store.changeLocked.bind(store);
  store.changeLocked = async () => { throw new Error('PRIVATE_DATABASE_PATH_TOKEN'); };
  try {
    await assert.rejects(f.call('app_context'), error => error instanceof DesktopMcpServiceError && error.code === 'MCP_OPERATION_FAILED' && !error.message.includes('PRIVATE_DATABASE_PATH_TOKEN'));
  } finally { store.changeLocked = original; }
});
