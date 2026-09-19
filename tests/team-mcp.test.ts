import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

// The same untranspiled module is copied into the Node worker image.
const { createTeamBridge, createWorkerChannel } = await import(new URL('../worker/team-mcp.mjs', import.meta.url).href);
const catalog = [{ name: 'peer_message', description: 'Send a message to an approved teammate.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } }];
const socketName = () => process.platform === 'win32' ? `\\\\.\\pipe\\ac-team-test-${randomUUID()}` : join(tmpdir(), `ac-team-test-${randomUUID()}.sock`);

async function harness(t: TestContext, timeoutMs = 1000) {
  const socketPath = socketName();
  const requests: any[] = [];
  const bus = new EventEmitter();
  const bridge = await createTeamBridge({ socketPath, tools: catalog, timeoutMs,
    emit: (request: unknown) => { requests.push(request); bus.emit('request', request); } });
  const socket = createConnection({ path: socketPath });
  await once(socket, 'connect');
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  t.after(async () => { socket.destroy(); lines.close(); await bridge.close(); });
  const next = async () => {
    const value = await iterator.next();
    assert.equal(value.done, false, 'MCP connection closed before its response');
    return JSON.parse(value.value!);
  };
  const send = (id: number, method: string, params: unknown = {}) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const initialize = async () => {
    send(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const result = await next();
    assert.equal(result.result.protocolVersion, '2025-06-18');
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  return { bridge, socket, socketPath, next, send, initialize, requests,
    request: () => once(bus, 'request').then(([value]) => value) };
}

test('MCP initializes, lists only the injected catalog and does not reply to notifications', { timeout: 5000 }, async t => {
  const h = await harness(t);
  await h.initialize();
  h.send(1, 'tools/list');
  assert.deepEqual((await h.next()).result.tools, catalog);
  h.send(2, 'ping');
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 2, result: {} });
  assert.deepEqual(h.requests, []);
});

test('MCP routes concurrent calls and out-of-order parent responses by independent IDs', { timeout: 5000 }, async t => {
  const h = await harness(t);
  await h.initialize();
  const requestedA = h.request();
  h.send(1, 'tools/call', { name: 'peer_message', arguments: { text: '첫째' } });
  const requestA = await requestedA;
  const requestedB = h.request();
  h.send(2, 'tools/call', { name: 'peer_message', arguments: { text: '둘째' } });
  const requestB = await requestedB;
  assert.notEqual(requestA.id, requestB.id);
  assert.deepEqual(requestA.arguments, { text: '첫째' });
  assert.equal(requestA.type, 'tool_request');
  h.bridge.acceptResponse({ type: 'tool_response', id: requestB.id, result: { delivered: '둘째' } });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"delivered":"둘째"}' }] } });
  h.bridge.acceptResponse({ type: 'tool_response', id: requestA.id, error: '팀 접근 범위를 벗어났습니다.' });
  const denied = await h.next();
  assert.equal(denied.id, 1);
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /접근 범위/);
  assert.equal(h.bridge.pendingCount, 0);
  assert.equal(h.bridge.acceptResponse({ type: 'tool_response', id: requestA.id, result: {} }), false);
});

test('MCP rejects malformed input, pre-initialize calls and unknown tools without dispatch', { timeout: 5000 }, async t => {
  const h = await harness(t);
  h.socket.write('{bad}\n');
  assert.equal((await h.next()).error.code, -32700);
  h.send(1, 'tools/list');
  assert.equal((await h.next()).error.code, -32002);
  await h.initialize();
  h.send(2, 'tools/call', { name: 'host_shell', arguments: {} });
  assert.equal((await h.next()).error.code, -32602);
  h.send(3, 'tools/call', { name: 'peer_message', arguments: [] });
  assert.equal((await h.next()).error.code, -32602);
  h.send(4, 'resources/read');
  assert.equal((await h.next()).error.code, -32601);
  assert.deepEqual(h.requests, []);
});

test('MCP bounds pending requests and cancellation never replays a tool', { timeout: 5000 }, async t => {
  const h = await harness(t, 4000);
  await h.initialize();
  for (let id = 1; id <= 17; id++) h.send(id, 'tools/call', { name: 'peer_message' });
  const response = await h.next();
  assert.equal(response.id, 17);
  assert.equal(response.result.isError, true);
  assert.equal(h.requests.length, 16);
  assert.equal(h.bridge.pendingCount, 16);
  h.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`);
  h.send(18, 'ping');
  assert.equal((await h.next()).id, 18);
  assert.equal(h.bridge.pendingCount, 15);
  assert.equal(h.bridge.acceptResponse({ type: 'tool_response', id: h.requests[0].id, result: {} }), false);
  assert.equal(h.requests.length, 16);
});

test('MCP timeout is bounded and late responses cannot satisfy later requests', { timeout: 5000 }, async t => {
  const h = await harness(t, 40);
  await h.initialize();
  h.send(1, 'tools/call', { name: 'peer_message' });
  const result = await h.next();
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /timed out/);
  assert.equal(h.bridge.pendingCount, 0);
  assert.equal(h.bridge.acceptResponse({ type: 'tool_response', id: h.requests[0].id, result: {} }), false);
});

test('MCP rejects oversized UTF-8 requests and returns bounded errors for oversized results', { timeout: 5000 }, async t => {
  const h = await harness(t);
  await h.initialize();
  const requested = h.request();
  h.send(1, 'tools/call', { name: 'peer_message' });
  const request = await requested;
  h.bridge.acceptResponse({ type: 'tool_response', id: request.id, result: 'x'.repeat(1024 * 1024) });
  assert.equal((await h.next()).result.isError, true);
  const closed = once(h.socket, 'close');
  h.socket.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peer_message', arguments: { text: '가'.repeat(90_000) } } }));
  await closed;
  assert.equal(h.requests.length, 1);
});

test('MCP socket shutdown clears every pending callback', { timeout: 5000 }, async t => {
  const h = await harness(t);
  await h.initialize();
  const requested = h.request();
  h.send(1, 'tools/call', { name: 'peer_message' });
  await requested;
  assert.equal(h.bridge.pendingCount, 1);
  await h.bridge.close();
  assert.equal(h.bridge.pendingCount, 0);
});

test('the actual stdio MCP executable completes a tool round trip without a network port or model', { timeout: 5000 }, async t => {
  const socketPath = socketName();
  let bridge: any;
  bridge = await createTeamBridge({ socketPath, tools: catalog,
    emit: (request: any) => queueMicrotask(() => bridge.acceptResponse({ type: 'tool_response', id: request.id, result: { received: request.arguments } })) });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../worker/team-mcp.mjs', import.meta.url)), '--socket', socketPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', value => { stderr += value.toString(); });
  t.after(async () => { child.kill(); lines.close(); await bridge.close(); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  const initialized = await iterator.next();
  assert.equal(JSON.parse(initialized.value!).result.serverInfo.name, 'agent-company-team');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peer_message', arguments: { text: '협업' } } })}\n`);
  const result = JSON.parse((await iterator.next()).value!);
  assert.deepEqual(JSON.parse(result.result.content[0].text), { received: { text: '협업' } });
  const completed = once(child, 'close');
  child.stdin.end();
  assert.equal((await completed)[0], 0);
  assert.equal(stderr, '');
});

test('worker input retains legacy EOF JSON and reads interactive payload before EOF', async () => {
  const legacy = new PassThrough();
  const normal = createWorkerChannel(legacy);
  legacy.end(JSON.stringify({ text: '기억' }, null, 2));
  assert.deepEqual(await normal.payload, { text: '기억' });
  assert.equal(normal.signal.aborted, false);

  const stream = new PassThrough();
  const channel = createWorkerChannel(stream);
  const initial = { interactiveCollaboration: true, input: { run: 'one' } };
  const response = { type: 'tool_response', id: 'request-one', result: { value: '응답' } };
  stream.write(`${JSON.stringify(initial)}\n${JSON.stringify(response)}\n`);
  assert.deepEqual(await channel.payload, initial);
  const delivered: unknown[] = [];
  channel.onResponse((value: unknown) => delivered.push(value));
  assert.deepEqual(delivered, [response]);
  stream.end();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(channel.signal.aborted, true);
  assert.match(channel.signal.reason.message, /연결이 종료/);
  stream.destroy();
});

test('worker input enforces payload and response limits and rejects invalid interactive replies', async () => {
  const tooLarge = new PassThrough();
  const oversized = createWorkerChannel(tooLarge);
  const rejected = assert.rejects(oversized.payload, /입력 한도/);
  tooLarge.write('x'.repeat(8 * 1024 * 1024 + 1));
  await rejected;
  tooLarge.destroy();
  for (const reply of [{ type: 'tool_response', id: 'one' }, { type: 'unexpected', id: 'one', result: {} },
    { type: 'tool_response', id: 'one', result: '가'.repeat(400_000) }]) {
    const stream = new PassThrough();
    const channel = createWorkerChannel(stream);
    stream.write('{"interactiveCollaboration":true}\n');
    await channel.payload;
    stream.write(`${JSON.stringify(reply)}\n`);
    assert.equal(channel.signal.aborted, true);
    stream.destroy();
  }
});

test('invalid collaboration catalogs fail before opening the IPC endpoint', async () => {
  for (const tools of [[catalog[0], catalog[0]], [{ ...catalog[0], name: 'bad.name' }], [{ ...catalog[0], inputSchema: [] }]]) {
    await assert.rejects(createTeamBridge({ socketPath: socketName(), tools, emit: () => {} }), /definition/);
  }
});

test('worker auto-approves only its required team MCP while retaining the global sandbox and approval policy', async () => {
  const source = await readFile(new URL('../worker/entry.mjs', import.meta.url), 'utf8');
  assert.match(source, /mcp_servers\.team\.command="node"/);
  assert.match(source, /\/app\/team-mcp\.mjs/);
  assert.match(source, /mcp_servers\.team\.required=true/);
  assert.deepEqual([...source.matchAll(/mcp_servers\.([a-zA-Z0-9_-]+)\.default_tools_approval_mode="prompt"/g)]
    .map(match => match[1]), ['team']);
  assert.match(source, /mcp_servers\.team\.tools\.\$\{tool\.name\}\.approval_mode="approve"/);
  assert.match(source, /for \(const tool of payload\.input\.collaboration\.tools\)/);
  assert.match(source, /--ignore-user-config/);
  assert.match(source, /approval_policy="never"/);
  assert.match(source, /const discussing = learning \|\| run\.interactionMode === 'auto' \|\| run\.interactionMode === 'discuss'/);
  assert.match(source, /\['--sandbox', discussing \? 'read-only' : 'workspace-write'\]/);
  assert.match(source, /sandbox_mode="\$\{discussing \? 'read-only' : 'workspace-write'\}"/);
  assert.match(source, /sandbox_workspace_write\.network_access=false/);
  assert.doesNotMatch(source, /dangerously-bypass-approvals-and-sandbox|sandbox_mode="danger-full-access"/);
});
