import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../server/service.ts';
import { createApp } from '../server/app.ts';
import { StorageFixtureRuntime } from './storage-fixture.ts';
import type { BrowserCapture, BrowserRequest } from '../shared/browser.ts';
import type { ExecutionInput } from '../shared/types.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const sourceFiles = [{ path: 'index.html', contentBase64: Buffer.from('<button>Actual preview</button>').toString('base64') }];
const workspaceOpen = { source: { kind: 'workspace', path: 'site' }, files: sourceFiles };
const screenshot = () => ({ content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
  metadata: { width: 1, height: 1, url: 'http://127.0.0.1:4173/index.html?secret=omitted#private-fragment' } });
type BrowserCall = { input: ExecutionInput; request: BrowserRequest; signal: AbortSignal };
class BrowserFixtureRuntime extends StorageFixtureRuntime {
  browserEnabled = true;
  browserAvailable = true;
  readonly browserCalls: BrowserCall[] = [];
  response?: (call: BrowserCall) => unknown | Promise<unknown>;
  async callBrowser(input: ExecutionInput, request: BrowserRequest, signal: AbortSignal): Promise<unknown> {
    const call = { input, request, signal }; this.browserCalls.push(call);
    return this.response ? this.response(call) : request.action === 'screenshot' ? screenshot() : { open: request.action !== 'close' };
  }
}
async function until(check: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ac-browser-service-'));
  const runtime = new BrowserFixtureRuntime(randomUUID());
  const dataDir = join(directory, 'db');
  const service = await AgentService.create({ dataDir, runtime });
  let closed = false;
  const close = async () => { if (!closed) { await service.close(); closed = true; } };
  const agent = await service.createAgent({ name: 'Browser tester', persona: 'Inspect real pages' });
  const start = async () => {
    const before = runtime.calls.length;
    const run = await service.startRun(agent.id, 'Inspect the isolated site');
    await until(() => runtime.calls.length > before, 'Fixture worker did not start');
    return { run, execution: runtime.calls[before], tool: runtime.calls[before].hooks.onTool! };
  };
  const cleanup = async () => {
    await close();
    const relativePath = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(relativePath.startsWith('ac-browser-service-') && !relativePath.includes('..'));
    await rm(directory, { recursive: true });
  };
  return { directory, dataDir, runtime, service, agent, start, close, cleanup };
}
type ImageEnvelope = { __browserMcpContent: { content: [{ type: 'text'; text: string }, { type: 'image'; mimeType: string; data: string }] } };
const envelopeCapture = (result: ImageEnvelope): BrowserCapture => JSON.parse(result.__browserMcpContent.content[0].text).capture;

test('screenshots preserve real image content, run-bound metadata, DB/blob persistence and guarded image/download HTTP endpoints', async () => {
  const f = await fixture(); let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const { run, tool } = await f.start();
    await tool('browser_open', workspaceOpen);
    const envelope = await tool('browser_action', { action: 'screenshot' }) as ImageEnvelope;
    assert.equal(envelope.__browserMcpContent.content[1].type, 'image');
    assert.deepEqual(Buffer.from(envelope.__browserMcpContent.content[1].data, 'base64'), png);
    const capture = envelopeCapture(envelope);
    assert.equal(capture.runId, run.id); assert.equal(capture.agentId, f.agent.id); assert.equal(capture.conversationId, null);
    assert.deepEqual(capture.scope, { type: 'agent', id: f.agent.id });
    assert.equal(capture.bytes, png.length); assert.equal(capture.sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(capture.sourceHash, createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'));
    assert.equal(capture.url, 'http://127.0.0.1:4173/index.html'); assert.equal(capture.width, 1); assert.equal(capture.height, 1);
    assert.match(envelope.__browserMcpContent.content[0].text, /기능 검증 완료를 뜻하지 않습니다/);
    assert.deepEqual((await f.service.workspace()).browserCaptures, [capture]);
    const file = await f.service.downloadBrowserCapture(capture.id);
    assert.deepEqual(file.bytes, png); assert.equal(file.mediaType, 'image/png'); assert.equal(file.path, `capture-${capture.id}.png`);
    await f.service.cancelRun(run.id); await f.close();
    app = await createApp({ dataDir: f.dataDir, runtime: f.runtime });
    const persisted = (await app.inject({ method: 'GET', url: '/api/workspace' })).json();
    assert.deepEqual(persisted.browserCaptures, [capture]);
    const image = await app.inject({ method: 'GET', url: `/api/browser/captures/${capture.id}/image` });
    assert.equal(image.statusCode, 200); assert.deepEqual(image.rawPayload, png);
    assert.match(String(image.headers['content-type']), /^image\/png/); assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.equal(image.headers['cache-control'], 'no-store'); assert.match(String(image.headers['content-security-policy']), /default-src 'none'; sandbox/);
    const download = await app.inject({ method: 'GET', url: `/api/browser/captures/${capture.id}/download` });
    assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, png);
    assert.match(String(download.headers['content-disposition']), /attachment/);
    assert.equal((await app.inject({ method: 'GET', url: `/api/browser/captures/${capture.id}/image`, headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/browser/captures/${randomUUID()}/image` })).statusCode, 404);
  } finally { await app?.close(); await f.cleanup(); }
});

test('shared source resolves only current authorized scope and rejects file injection or unsafe paths before runtime calls', async () => {
  const f = await fixture();
  try {
    const peer = await f.service.createAgent({ name: 'Peer', persona: 'Separate work' });
    const allowed = await f.service.createTeam({ name: 'Allowed', memberIds: [f.agent.id] });
    const forbidden = await f.service.createTeam({ name: 'Forbidden', memberIds: [peer.id] });
    await f.service.importFile({ scope: { type: 'team', id: allowed.id }, path: 'site/index.html', mediaType: 'text/html',
      base64: sourceFiles[0].contentBase64 });
    const { tool } = await f.start();
    const open = { source: { kind: 'artifacts', scope: { type: 'team', id: allowed.id }, prefix: 'site' } };
    await tool('browser_open', open);
    const actual = f.runtime.browserCalls[0].request;
    assert.equal(actual.action, 'open'); if (actual.action !== 'open') assert.fail('Expected open');
    assert.deepEqual(actual.files, sourceFiles);
    const capture = envelopeCapture(await tool('browser_action', { action: 'screenshot' }) as ImageEnvelope);
    assert.deepEqual(capture.scope, { type: 'team', id: allowed.id });
    const before = f.runtime.browserCalls.length;
    await assert.rejects(tool('browser_open', { source: { ...open.source, scope: { type: 'team', id: forbidden.id } } }), /공유 범위/);
    await assert.rejects(tool('browser_open', { ...open, files: sourceFiles }), /파일을 주입/);
    for (const path of ['../outside', '.env', 'nested/.hidden', 'C:/Users/private', 'auth.json', 'nested/id_rsa', 'file%2fprivate']) {
      await assert.rejects(tool('browser_open', { source: { kind: 'workspace', path }, files: sourceFiles }));
      await assert.rejects(tool('browser_open', { ...workspaceOpen, files: [{ path, contentBase64: 'YQ==' }] }));
    }
    await assert.rejects(tool('browser_open', { ...workspaceOpen, files: [...sourceFiles, { ...sourceFiles[0], path: 'INDEX.HTML' }] }), /중복/);
    assert.equal(f.runtime.browserCalls.length, before);
  } finally { await f.cleanup(); }
});

test('membership revoked while a screenshot is pending prevents image delivery and storage, and future calls are blocked', async () => {
  const f = await fixture();
  try {
    const peer = await f.service.createAgent({ name: 'Peer', persona: 'Team member' });
    const team = await f.service.createTeam({ name: 'Shared preview', memberIds: [f.agent.id, peer.id] });
    await f.service.importFile({ scope: { type: 'team', id: team.id }, path: 'site/index.html', mediaType: 'text/html', base64: sourceFiles[0].contentBase64 });
    const { tool } = await f.start();
    await tool('browser_open', { source: { kind: 'artifacts', scope: { type: 'team', id: team.id }, prefix: 'site' } });
    let complete!: (value: unknown) => void;
    f.runtime.response = () => new Promise(resolve => { complete = resolve; });
    const pending = tool('browser_action', { action: 'screenshot' });
    const rejected = assert.rejects(pending, /공유 범위/);
    await until(() => Boolean(complete), 'Screenshot did not reach runtime');
    await f.service.updateTeam(team.id, { memberIds: [peer.id] }); complete(screenshot()); await rejected;
    assert.deepEqual((await f.service.workspace()).browserCaptures ?? [], []);
    const before = f.runtime.browserCalls.length;
    await assert.rejects(tool('browser_action', { action: 'snapshot' }), /공유 범위/);
    assert.equal(f.runtime.browserCalls.length, before);
  } finally { await f.cleanup(); }
});

test('cancellation or runtime capability revocation during screenshot suppresses the response and stored capture', async () => {
  for (const revoke of ['cancel', 'capability'] as const) {
    const f = await fixture();
    try {
      const { run, tool } = await f.start(); await tool('browser_open', workspaceOpen);
      let complete!: (value: unknown) => void;
      f.runtime.response = () => new Promise(resolve => { complete = resolve; });
      const pending = tool('browser_action', { action: 'screenshot' });
      const rejected = assert.rejects(pending, /진행 중인 일반 작업|브라우저가 연결되지 않았습니다/);
      await until(() => Boolean(complete), 'Screenshot did not reach runtime');
      if (revoke === 'cancel') await f.service.cancelRun(run.id); else f.runtime.browserEnabled = false;
      complete(screenshot()); await rejected;
      assert.deepEqual((await f.service.workspace()).browserCaptures ?? [], []);
      await assert.rejects(tool('browser_action', { action: 'snapshot' }));
    } finally { await f.cleanup(); }
  }
});

test('untrusted image bytes, encoding, dimensions and non-isolated screenshot URLs never become captures', async () => {
  const f = await fixture();
  try {
    const { tool } = await f.start(); await tool('browser_open', workspaceOpen);
    const original = screenshot();
    for (const response of [
      { ...original, content: [{ ...original.content[0], data: Buffer.from('not an image').toString('base64') }] },
      { ...original, content: [{ ...original.content[0], data: `${original.content[0].data}\n` }] },
      { ...original, content: [{ ...original.content[0], mimeType: 'text/html' }] },
      { ...original, content: [original.content[0], original.content[0]] },
      { ...original, metadata: { ...original.metadata, width: 1921 } },
      { ...original, metadata: { ...original.metadata, height: 0 } },
      ...['https://127.0.0.1:4173/', 'http://external.example/', 'http://user:password@127.0.0.1:4173/', 'file:///private', 'not a URL']
        .map(url => ({ ...original, metadata: { ...original.metadata, url } })),
    ]) {
      f.runtime.response = () => response;
      await assert.rejects(tool('browser_action', { action: 'screenshot' }));
      assert.deepEqual((await f.service.workspace()).browserCaptures ?? [], []);
    }
  } finally { await f.cleanup(); }
});

test('browserBusy preserves the checkpoint and result, releases the worker lease, and does not restart models while the slot is busy', async () => {
  const f = await fixture(); let resumed: AgentService | undefined;
  try {
    const { run, execution, tool } = await f.start(); const sessionId = randomUUID();
    await execution.hooks.onCheckpoint!({ phase: 'task', sessionId, appliedSteeringCount: 0 });
    f.runtime.response = () => { f.runtime.browserAvailable = false; return { browserBusy: true }; };
    const waiting = await tool('browser_open', workspaceOpen);
    assert.equal((waiting as { waiting: boolean }).waiting, true);
    for (let attempt = 0; attempt < 4; attempt += 1) assert.deepEqual(await tool('browser_open', workspaceOpen), waiting);
    assert.equal(f.runtime.browserCalls.length, 1);
    execution.finish();
    await until(async () => (await f.service.workspace()).runs.find(item => item.id === run.id)?.status === 'queued', 'Run did not enter browser wait');
    const queued = await f.service.workspace();
    assert.equal(queued.runs.find(item => item.id === run.id)?.browserWaiting, true);
    assert.equal(queued.runs.find(item => item.id === run.id)?.result, 'fixture complete');
    assert.equal(queued.resources?.reserved.memoryMiB, 0); assert.equal(queued.resources?.reserved.cpus, 0);
    await delay(80); assert.equal(f.runtime.calls.length, 1);
    await f.close();
    f.runtime.browserAvailable = true; f.runtime.response = undefined;
    resumed = await AgentService.create({ dataDir: f.dataDir, runtime: f.runtime });
    await until(() => f.runtime.calls.length === 2, 'Preserved browser-wait run did not resume');
    assert.equal(f.runtime.calls[1].input.run.id, run.id);
    assert.equal(f.runtime.calls[1].input.checkpoint?.sessionId, sessionId);
    assert.equal(f.runtime.calls[1].input.previousResult?.result, 'fixture complete');
    assert.equal(f.runtime.calls[1].input.run.browserWaiting, false);
    await resumed.cancelRun(run.id);
  } finally { await resumed?.close(); await f.cleanup(); }
});

test('closing or a failed reopen invalidates the old source and prevents stale screenshot attribution', async () => {
  const f = await fixture();
  try {
    const { tool } = await f.start(); await tool('browser_open', workspaceOpen);
    await tool('browser_action', { action: 'close' });
    await assert.rejects(tool('browser_action', { action: 'screenshot' }), /소스를 다시 열어야/);
    await tool('browser_open', workspaceOpen);
    f.runtime.response = () => { throw new Error('opening replacement failed'); };
    await assert.rejects(tool('browser_open', { ...workspaceOpen, source: { kind: 'workspace', path: 'replacement' } }), /replacement failed/);
    await assert.rejects(tool('browser_action', { action: 'screenshot' }), /소스를 다시 열어야/);
    assert.deepEqual((await f.service.workspace()).browserCaptures ?? [], []);
  } finally { await f.cleanup(); }
});
