import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const { createTeamBridge } = await import(new URL('../worker/team-mcp.mjs', import.meta.url).href);
const { collectWorkspacePreview } = await import(new URL('../worker/browser-source.mjs', import.meta.url).href);
const catalog = ['browser_open', 'browser_action', 'environment_call', 'artifact_read'].map(name => ({
  name, description: name, inputSchema: { type: 'object' },
}));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2E8AAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const screenshot = { __browserMcpContent: { content: [{ type: 'text', text: '390 × 844 preview' }, image] } };
const socketName = () => process.platform === 'win32' ? `\\\\.\\pipe\\ac-browser-test-${randomUUID()}` : join(tmpdir(), `ac-browser-test-${randomUUID()}.sock`);

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-browser-source-'));
  await mkdir(join(root, 'site'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function harness(t: TestContext, workspaceRoot?: string) {
  const requests: any[] = [];
  const bus = new EventEmitter();
  const socketPath = socketName();
  const connectedBridge = await createTeamBridge({ socketPath, tools: catalog, workspaceRoot, timeoutMs: 4000,
    emit: (request: unknown) => { requests.push(request); bus.emit('request', request); } });
  const socket = createConnection({ path: socketPath });
  await once(socket, 'connect');
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  t.after(async () => { socket.destroy(); lines.close(); await connectedBridge.close(); });
  const next = async () => {
    const line = await iterator.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value!);
  };
  const send = (id: number, method: string, params: unknown = {}) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  send(0, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal((await next()).result.protocolVersion, '2025-06-18');
  return { bridge: connectedBridge, socket, send, next, requests, request: () => once(bus, 'request').then(([value]) => value) };
}

test('workspace browser preview captures bounded binary files and no absolute paths', async t => {
  const root = await workspace(t);
  await mkdir(join(root, 'site', 'demo'));
  await writeFile(join(root, 'site', 'index.html'), '<h1>테스트</h1>');
  await writeFile(join(root, 'site', 'demo', 'pixel.png'), Buffer.from(png, 'base64'));
  const result = await collectWorkspacePreview({ kind: 'workspace', path: 'site' }, { workspaceRoot: root });
  assert.deepEqual(result.source, { kind: 'workspace', path: 'site' });
  assert.deepEqual(result.files.map((file: any) => file.path), ['demo/pixel.png', 'index.html']);
  assert.equal(result.files[0].contentBase64, png);
  assert.equal(Buffer.from(result.files[1].contentBase64, 'base64').toString(), '<h1>테스트</h1>');
});

test('workspace browser preview rejects traversal, hidden and reserved source paths', async t => {
  const root = await workspace(t);
  for (const path of ['../site', '/site', 'site/..', 'site/.private', 'site\\file', 'site//demo', 'site/auth.json',
    'site/CREDENTIALS.JSON', 'site/AGENTS.md', 'site/file:stream', 'site/%2e%2e', 'site/name.', 'site/name ']) {
    await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path }, { workspaceRoot: root }), /path|permitted/);
  }
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'site', workspaceRoot: '/secret' }, { workspaceRoot: root }), /source/);
});

test('workspace browser preview rejects forbidden descendants and normalized duplicates', async t => {
  const root = await workspace(t);
  for (const [index, name] of ['.env', 'AGENTS.md', 'auth.json', 'credentials.json'].entries()) {
    const directory = `sensitive-${index}`;
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, name), 'must not leave workspace');
    await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: directory }, { workspaceRoot: root }), /reserved/);
  }
  await writeFile(join(root, 'site', '\u00e9.html'), 'one');
  await writeFile(join(root, 'site', 'e\u0301.html'), 'two');
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'site' }, { workspaceRoot: root }), /duplicate normalized/);
});

test('workspace browser preview rejects inner and outer directory links and hard-linked files', async t => {
  const root = await workspace(t);
  await mkdir(join(root, 'inside'));
  await writeFile(join(root, 'inside', 'private.txt'), 'private');
  const outside = await mkdtemp(join(tmpdir(), 'ac-browser-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.txt'), 'outside');
  await symlink(join(root, 'inside'), join(root, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(outside, join(root, 'site', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'inside-link' }, { workspaceRoot: root }), /links/);
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'site' }, { workspaceRoot: root }), /links/);
  await mkdir(join(root, 'hardlinked'));
  await link(join(root, 'inside', 'private.txt'), join(root, 'hardlinked', 'private.txt'));
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'hardlinked' }, { workspaceRoot: root }), /single-link/);
});

test('workspace browser preview rejects special files without reading them', { skip: process.platform === 'win32' }, async t => {
  const root = await workspace(t);
  const created = spawnSync('mkfifo', [join(root, 'site', 'pipe')]);
  assert.equal(created.status, 0);
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'site' }, { workspaceRoot: root }), /regular files/);
});

test('workspace browser preview enforces file and total byte limits, count and cancellation', { timeout: 60_000 }, async t => {
  const root = await workspace(t);
  await mkdir(join(root, 'oversized'));
  await writeFile(join(root, 'oversized', 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'oversized' }, { workspaceRoot: root }), /limit/);
  await mkdir(join(root, 'total'));
  for (let n = 0; n < 5; n++) await writeFile(join(root, 'total', `${n}.bin`), Buffer.alloc(2 * 1024 * 1024));
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'total' }, { workspaceRoot: root }), /limit/);
  await mkdir(join(root, 'many'));
  for (let n = 0; n < 1001; n++) await writeFile(join(root, 'many', `${n}.txt`), '');
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'many' }, { workspaceRoot: root }), /limit/);
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'site' }, { workspaceRoot: root }), /no regular files/);
  const controller = new AbortController();
  controller.abort(new Error('capture cancelled'));
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'site' }, { workspaceRoot: root, signal: controller.signal }), /capture cancelled/);
});

test('browser_open forwards collected files above normal request cap without echoing them to MCP', { timeout: 5000 }, async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'site', 'index.html'), 'x'.repeat(300 * 1024));
  const h = await harness(t, root);
  const dispatched = h.request();
  h.send(1, 'tools/call', { name: 'browser_open', arguments: { source: { kind: 'workspace', path: 'site' }, entry: 'index.html' } });
  const request = await dispatched;
  assert.equal(request.arguments.files.length, 1);
  assert.equal(Buffer.from(request.arguments.files[0].contentBase64, 'base64').length, 300 * 1024);
  h.bridge.acceptResponse({ type: 'tool_response', id: request.id, result: { sessionId: 'preview', opened: true } });
  const response = await h.next();
  assert.deepEqual(JSON.parse(response.result.content[0].text), { sessionId: 'preview', opened: true });
  assert.doesNotMatch(JSON.stringify(response), /contentBase64|xxxx/);
});

test('browser_open leaves artifact authorization to controller and rejects caller file injection', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const args = { source: { kind: 'artifacts', scope: { type: 'project', id: 'project-one' }, prefix: 'site' } };
  const dispatched = h.request();
  h.send(1, 'tools/call', { name: 'browser_open', arguments: args });
  const request = await dispatched;
  assert.deepEqual(request.arguments, args);
  h.bridge.acceptResponse({ type: 'tool_response', id: request.id, error: 'Denied project' });
  assert.equal((await h.next()).result.isError, true);
  h.send(2, 'tools/call', { name: 'browser_open', arguments: { ...args, files: [{ path: 'stolen', contentBase64: 'eA==' }] } });
  assert.match((await h.next()).result.content[0].text, /collected by the worker/);
  assert.equal(h.requests.length, 1);
});

test('only browser screenshot responses become MCP image blocks for the matching tool and action', { timeout: 5000 }, async t => {
  const h = await harness(t);
  for (const [index, name, action] of [[1, 'browser_action', 'screenshot'], [2, 'environment_call', 'screenshot'],
    [3, 'artifact_read', 'screenshot'], [4, 'browser_action', 'snapshot'], [5, 'browser_open', 'screenshot']] as const) {
    const dispatched = h.request();
    h.send(index, 'tools/call', { name, arguments: { action } });
    const request = await dispatched;
    h.bridge.acceptResponse({ type: 'tool_response', id: request.id, result: screenshot });
    const result = (await h.next()).result;
    if (index === 1) assert.deepEqual(result, screenshot.__browserMcpContent);
    else {
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      assert.deepEqual(JSON.parse(result.content[0].text), screenshot);
    }
  }
});

test('concurrent screenshot and environment responses keep their own content permissions', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const first = h.request();
  h.send(1, 'tools/call', { name: 'browser_action', arguments: { action: 'screenshot' } });
  const browserRequest = await first;
  const second = h.request();
  h.send(2, 'tools/call', { name: 'environment_call', arguments: { action: 'screenshot' } });
  const environmentRequest = await second;
  h.bridge.acceptResponse({ type: 'tool_response', id: environmentRequest.id, result: screenshot });
  const environmentResponse = await h.next();
  assert.equal(environmentResponse.id, 2);
  assert.equal(environmentResponse.result.content[0].type, 'text');
  h.bridge.acceptResponse({ type: 'tool_response', id: browserRequest.id, result: screenshot });
  const browserResponse = await h.next();
  assert.equal(browserResponse.id, 1);
  assert.deepEqual(browserResponse.result, screenshot.__browserMcpContent);
});

test('browser screenshot envelopes reject URLs, resources, MIME confusion and noncanonical base64', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const invalid = [
    { content: [{ type: 'resource_link', uri: 'https://example.invalid/image.png' }] },
    { content: [{ ...image, image_url: 'https://example.invalid/image.png' }] },
    { content: [{ ...image, data: 'https://example.invalid/image.png' }] },
    { content: [{ ...image, data: 'data:image/png;base64,' + png }] },
    { content: [{ ...image, mimeType: 'image/jpeg' }] },
    { content: [{ ...image, mimeType: 'image/svg+xml' }] },
    { content: [{ ...image, data: png + '\n' }] },
    { content: [{ ...image, data: 'eA==' }] },
    { content: [{ type: 'text', text: 'okay', resource: 'file:///secret' }] },
    { content: [image], isError: 'yes' },
  ];
  for (const [index, envelope] of invalid.entries()) {
    const dispatched = h.request();
    h.send(index + 1, 'tools/call', { name: 'browser_action', arguments: { action: 'screenshot' } });
    const request = await dispatched;
    h.bridge.acceptResponse({ type: 'tool_response', id: request.id, result: { __browserMcpContent: envelope } });
    const result = (await h.next()).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid browser screenshot/);
    assert.equal(result.content[0].type, 'text');
  }
});

test('browser screenshot image bytes and final JSONL responses remain bounded', { timeout: 5000 }, async t => {
  const h = await harness(t);
  const huge = Buffer.alloc(600 * 1024 + 1);
  Buffer.from(png, 'base64').copy(huge);
  for (const [index, result] of [
    { __browserMcpContent: { content: [{ ...image, data: huge.toString('base64') }] } },
    { __browserMcpContent: { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }, image] } },
  ].entries()) {
    const dispatched = h.request();
    h.send(index + 1, 'tools/call', { name: 'browser_action', arguments: { action: 'screenshot' } });
    const request = await dispatched;
    h.bridge.acceptResponse({ type: 'tool_response', id: request.id, result });
    const response = await h.next();
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].type, 'text');
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024);
  }
});

test('browser screenshot byte validation accepts a large bounded payload and caps combined images', { timeout: 5000 }, async t => {
  const h = await harness(t);
  // Header-valid payloads isolate transport byte validation from image decoding,
  // which is performed by the platform-owned browser renderer.
  const data = Buffer.alloc(350 * 1024);
  Buffer.from(png, 'base64').copy(data);
  const largeImage = { ...image, data: data.toString('base64') };
  for (const [index, content] of [[largeImage], [largeImage, largeImage]].entries()) {
    const dispatched = h.request();
    h.send(index + 1, 'tools/call', { name: 'browser_action', arguments: { action: 'screenshot' } });
    const request = await dispatched;
    h.bridge.acceptResponse({ type: 'tool_response', id: request.id, result: { __browserMcpContent: { content } } });
    const result = (await h.next()).result;
    if (index === 0) assert.deepEqual(result.content, content);
    else assert.equal(result.isError, true);
  }
});
