import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import { createDesktopAccess } from '../server/desktop-access.ts';
import { DesktopSetup } from '../server/desktop-setup.ts';
import { DesktopMcp } from '../server/desktop-mcp.ts';
import { activeStorage, type StorageConfig } from '../server/storage.ts';
import type { AgentService } from '../server/service.ts';
import type { DesktopMcpCreated } from '../shared/desktop-mcp.ts';
import { WorkspaceStore } from '../server/store.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';

const until = async (check: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 8000;
  while (!await check()) { assert.ok(Date.now() < end, 'Local MCP verification deadline'); await delay(10); }
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
class NoModelRuntime extends StorageFixtureRuntime {
  override async execute(): Promise<never> { assert.fail('External MCP must not start a model in this fixture'); }
  async confirmDeploymentIdle() {}
}
async function fixture(t: test.TestContext, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-mcp-api-')), ownerKey = randomUUID();
  const appData = join(root, 'appdata'); await mkdir(appData);
  await writeFile(join(appData, 'desktop-installation.json'), JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: ownerKey }));
  const storage: StorageConfig = { rootDir: join(root, 'data'), backupDir: join(root, 'backups'), ownerKey, freeSpace: async () => 100 * 1024 ** 3 };
  const token = randomBytes(32).toString('base64url'), cookieName = `ac_desktop_${randomBytes(16).toString('hex')}`;
  let origin: string | undefined, manager!: DesktopMcp, service!: AgentService;
  const app = await createApp({ dataDir: join(storage.rootDir, 'db'), storage, runtime: new NoModelRuntime(ownerKey), ...(enabled ? {
    desktopAccess: createDesktopAccess({ token, cookieName, origin: () => origin }),
    desktopSetup: (admit: () => () => void) => new DesktopSetup({ provider: null, credentialsRoot: join(appData, 'credentials'), workspaceKey: ownerKey, admit, assertIdle() {} }),
    desktopMcp: async (value: AgentService) => {
      service = value;
      manager = await DesktopMcp.open({ appDataRoot: appData, resourceRoot: root, ownerKey, generationKey: ownerKey,
        generation: async () => (await activeStorage(storage)).workspaceKey, origin: () => origin, service,
        client: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../server/desktop-mcp-entry.ts', import.meta.url))] } });
      return manager;
    },
  } : {}) });
  t.after(async () => { await app.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /ac-desktop-mcp-api-[^\\/]+$/); await rm(root, { recursive: true, force: true }); });
  origin = await app.listen({ host: '127.0.0.1', port: 0 }); await manager?.publish();
  const headers = { host: new URL(origin).host, origin, cookie: `${cookieName}=${token}` };
  const get = (url: string) => app.inject({ url, headers });
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
  const created = enabled ? (await post('/api/agents', { name: 'Saved agent', persona: 'PRIVATE_AGENT_PERSONA' })).json() : null;
  const team = enabled ? (await post('/api/teams', { name: 'Allowed team', memberIds: [created.id], autoDiscoverTasks: false })).json() : null;
  return { app, appData, root, ownerKey, storage, headers, origin, service, manager, team, get, post,
    async grant(submitTasks = true) {
      const before = (await get('/api/desktop/mcp')).json(); assert.equal(before.available, true);
      const response = await post('/api/desktop/mcp/grants', { revision: before.revision, label: 'External editor', scope: { type: 'team', id: team.id }, submitTasks, budgetTeamId: team.id });
      assert.equal(response.statusCode, 200); return response.json<DesktopMcpCreated>();
    },
    async rpc(createdGrant: DesktopMcpCreated, method: string, params: unknown = {}, extra: Record<string, string> = {}) {
      const config = createdGrant.configuration.mcpServers.agent_company;
      const endpoint = JSON.parse(await readFile(join(appData, 'desktop-mcp-endpoint.json'), 'utf8'));
      return app.inject({ method: 'POST', url: '/api/desktop/mcp/rpc', headers: { host: headers.host,
        authorization: `Bearer ${config.env.AGENT_COMPANY_MCP_TOKEN}`, 'x-agent-company-grant': config.args.at(-1)!, 'x-agent-company-epoch': endpoint.epoch, ...extra }, payload: { method, params } });
    } };
}

function bridge(t: test.TestContext, created: DesktopMcpCreated) {
  const config = created.configuration.mcpServers.agent_company;
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  const messages: any[] = []; let pending = '', stderr = '', sequence = 0;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { pending += chunk; let index: number;
    while ((index = pending.indexOf('\n')) >= 0) { messages.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1); } });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  t.after(async () => { child.stdin.end(); const result = await ended; assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(stderr, ''); });
  return { child, ended, messages,
    async request(method: string, params: unknown = {}) { const id = ++sequence; send({ jsonrpc: '2.0', id, method, params });
      await until(() => messages.some(message => message.id === id)); return messages.find(message => message.id === id); },
    async initialize() { const result = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'actual-stdio-fixture', version: '1' } });
      assert.equal(result.result?.protocolVersion, '2025-11-25'); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); },
    async close() { child.stdin.end(); return ended; } };
}

test('MCP routes remain desktop-only, bind exact host/epoch and cannot authorize administrator APIs', async t => {
  const cli = await fixture(t, false);
  assert.equal((await cli.get('/api/desktop/mcp')).statusCode, 404);
  const f = await fixture(t), grant = await f.grant(false), config = grant.configuration.mcpServers.agent_company;
  const read = await f.rpc(grant, 'tools/list'); assert.equal(read.statusCode, 200);
  assert.equal(read.json().result.tools.some((tool: { name: string }) => tool.name === 'app_task_create'), false);
  assert.equal((await f.get('/api/workspace')).json().desktop.localMcp, true);
  const deniedHeaders: Record<string, string>[] = [{ origin: f.origin }, { cookie: f.headers.cookie }, { 'sec-fetch-site': 'same-origin' }, { 'x-agent-company-epoch': randomUUID() }, { host: '127.0.0.1:9' }, { authorization: `Bearer ${randomBytes(32).toString('base64url')}` }];
  for (const extra of deniedHeaders) {
    assert.equal((await f.rpc(grant, 'tools/list', {}, extra)).statusCode, 403);
  }
  for (const url of ['/api/workspace', '/api/desktop/mcp', '/api/desktop/setup', '/api/agents']) {
    assert.equal((await f.app.inject({ url, headers: { host: f.headers.host, authorization: `Bearer ${config.env.AGENT_COMPANY_MCP_TOKEN}` } })).statusCode, 403);
  }
  assert.equal((await f.post('/api/desktop/mcp/rpc', { method: 'tools/list', params: {} })).statusCode, 403);
  assert.equal((await f.rpc(grant, 'tools/call', { name: 'app_task_create', arguments: { title: 'Denied', idempotencyKey: 'denied' } })).json().result.isError, true);
  assert.equal((await f.rpc(grant, 'tools/call', { name: 'operator_request_decide', arguments: {} })).json().error.code, -32602);
  assert.equal((await f.rpc(grant, 'tools/list', { scope: 'override' })).json().error.code, -32602);
  assert.equal((await f.service.workspace()).teamTasks!.length, 0);
  const ledger = await readFile(join(f.appData, 'desktop-mcp-grants.json'), 'utf8');
  assert.equal(ledger.includes(config.env.AGENT_COMPANY_MCP_TOKEN), false); assert.equal(JSON.stringify(grant.status).includes('tokenHash'), false);
});

test('actual stdio child creates and retries a scoped task through real HTTP/DB, then loses access after revocation', { timeout: 20_000 }, async t => {
  const f = await fixture(t), created = await f.grant(), client = bridge(t, created);
  await client.initialize();
  assert.equal((await client.request('tools/list')).result.tools.length, 7);
  const args = { title: '한글 외부 과제', description: '실제 stdio 요청', idempotencyKey: 'stable-one' };
  const first = (await client.request('tools/call', { name: 'app_task_create', arguments: args })).result;
  assert.equal(first.isError, false); assert.equal(first.structuredContent.title, args.title);
  const again = (await client.request('tools/call', { name: 'app_task_create', arguments: args })).result;
  assert.equal(again.structuredContent.id, first.structuredContent.id);
  const wrong = await client.request('tools/call', { name: 'app_task_create', arguments: { ...args, description: 'changed' } });
  assert.equal(wrong.result.isError, true);
  const tasks = await client.request('tools/call', { name: 'app_task_list', arguments: {} }); assert.equal(tasks.result.structuredContent.total, 1);
  const workspace = await f.service.workspace(); assert.equal(workspace.runs.length, 0); assert.equal(workspace.teamTasks![0].externalClient?.label, 'External editor');
  const id = created.configuration.mcpServers.agent_company.args.at(-1)!;
  assert.equal((await f.post(`/api/desktop/mcp/grants/${id}/revoke`, { revision: created.status.revision })).statusCode, 200);
  assert.equal((await client.request('tools/list')).error.code, -32000);
  assert.equal((await client.close()).code, 0);
});

test('deployment waits for an admitted MCP mutation while held reads and revocation remain available', { timeout: 20_000 }, async t => {
  const f = await fixture(t), created = await f.grant(), gate = deferred(), started = deferred();
  const original = f.service.desktopMcp.bind(f.service);
  f.service.desktopMcp = async (...args) => { if (args[1] === 'app_task_create') { started.resolve(); await gate.promise; } return original(...args); };
  const pending = f.rpc(created, 'tools/call', { name: 'app_task_create', arguments: { title: 'Accepted before hold', idempotencyKey: 'hold-one' } });
  try {
    await started.promise; assert.equal((await f.post('/api/deployment/prepare', {})).json().phase, 'draining');
    await delay(100); assert.equal((await f.get('/api/deployment')).json().phase, 'draining');
    assert.equal((await f.rpc(created, 'tools/call', { name: 'app_task_create', arguments: { title: 'Held', idempotencyKey: 'held-two' } })).statusCode, 409);
  } finally { gate.resolve(); }
  assert.equal((await pending).json().result.isError, false);
  await until(async () => (await f.get('/api/deployment')).json().phase === 'ready');
  assert.equal((await f.rpc(created, 'tools/list')).statusCode, 200);
  assert.equal((await f.rpc(created, 'tools/call', { name: 'app_task_list' })).json().result.structuredContent.total, 1);
  assert.equal((await f.get('/api/desktop/mcp')).json().available, true);
  const id = created.configuration.mcpServers.agent_company.args.at(-1)!;
  assert.equal((await f.post(`/api/desktop/mcp/grants/${id}/revoke`, { revision: created.status.revision })).statusCode, 200);
  assert.equal((await f.rpc(created, 'tools/list')).statusCode, 403);
});

test('actual open HTTP mutation finishes before MCP endpoint and DB close; accepted task survives reopening', { timeout: 20_000 }, async t => {
  const f = await fixture(t), created = await f.grant(), config = created.configuration.mcpServers.agent_company;
  const endpointPath = join(f.appData, 'desktop-mcp-endpoint.json'), endpoint = JSON.parse(await readFile(endpointPath, 'utf8'));
  const gate = deferred(), started = deferred(), original = f.service.desktopMcp.bind(f.service);
  f.service.desktopMcp = async (...args) => { started.resolve(); await gate.promise; return original(...args); };
  const pending = fetch(f.origin + '/api/desktop/mcp/rpc', { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${config.env.AGENT_COMPANY_MCP_TOKEN}`, 'x-agent-company-grant': config.args.at(-1)!, 'x-agent-company-epoch': endpoint.epoch },
    body: JSON.stringify({ method: 'tools/call', params: { name: 'app_task_create', arguments: { title: 'Durable before close', idempotencyKey: 'closing-one' } } }) });
  await started.promise;
  f.service.beginClose();
  assert.equal((await f.rpc(created, 'tools/call', { name: 'app_task_create', arguments: {
    title: 'Not admitted during close', idempotencyKey: 'closing-two',
  } })).statusCode, 409);
  let closed = false; const closing = f.app.close().then(() => { closed = true; });
  try { await delay(40); assert.equal(closed, false); assert.equal(JSON.parse(await readFile(endpointPath, 'utf8')).epoch, endpoint.epoch); }
  finally { gate.resolve(); }
  const response = await pending; assert.equal(response.status, 200); assert.equal((await response.json()).result.isError, false); await closing;
  await assert.rejects(readFile(endpointPath), { code: 'ENOENT' });
  const store = await WorkspaceStore.open(join(f.storage.rootDir, 'db'));
  try { const state = await store.read(); assert.equal(state.teamTasks[0].title, 'Durable before close'); assert.equal(state.runs.length, 0); }
  finally { await store.close(); }
});

test('real workspace restoration invalidates old MCP grants and requires restart before new grants', { timeout: 20_000 }, async t => {
  const f = await fixture(t), created = await f.grant();
  const backups = await f.service.createBackup(), staged = await f.service.prepareRestore(backups.backups[0].id);
  await f.service.activateRestore(staged.id);
  const status = (await f.get('/api/desktop/mcp')).json(); assert.equal(status.available, false); assert.notEqual(status.generationKey, created.status.generationKey);
  assert.equal((await f.rpc(created, 'tools/list')).statusCode, 403);
  assert.equal((await f.post('/api/desktop/mcp/grants', { revision: status.revision, label: 'After restore', scope: { type: 'team', id: f.team.id }, submitTasks: false, budgetTeamId: f.team.id })).statusCode, 403);
  const id = created.configuration.mcpServers.agent_company.args.at(-1)!;
  assert.equal((await f.post(`/api/desktop/mcp/grants/${id}/revoke`, { revision: created.status.revision })).statusCode, 200);
  assert.equal((await f.service.workspace()).runs.length, 0);
});
