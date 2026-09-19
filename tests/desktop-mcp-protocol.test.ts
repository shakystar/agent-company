import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopMcpCallError, runDesktopMcpProtocol, type DesktopMcpCall } from '../server/desktop-mcp-protocol.ts';

const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } };
function fixture(call: DesktopMcpCall = async () => ({ tools: [] })) {
  const input = new PassThrough(), output = new PassThrough(), messages: any[] = []; let buffer = '';
  output.on('data', chunk => { buffer += chunk.toString('utf8'); let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } });
  const result = runDesktopMcpProtocol({ input, output, call });
  const send = (method: string, id?: number | string, params?: unknown) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }), ...(params === undefined ? {} : { params }) })}\n`);
  const reply = async (id: number | string, occurrence = 0) => {
    const deadline = Date.now() + 3000;
    while (messages.filter(message => message.id === id).length <= occurrence) { assert.ok(Date.now() < deadline, 'MCP response deadline'); await delay(5); }
    return messages.filter(message => message.id === id)[occurrence];
  };
  return { input, output, messages, result, send, reply,
    async initialize() { send('initialize', 1, init); assert.equal((await reply(1)).result.protocolVersion, '2025-11-25'); send('notifications/initialized'); },
    async close() { input.end(); return result; } };
}

test('stdio requires authenticated initialization and notification before tools; unknown methods never dispatch', async () => {
  const calls: string[] = [], f = fixture(async method => { calls.push(method); return { tools: [] }; });
  f.send('tools/list', 0); assert.equal((await f.reply(0)).error.code, -32002);
  f.send('initialize', 1, init); assert.equal((await f.reply(1)).result.protocolVersion, '2025-11-25');
  f.send('tools/list', 2); assert.equal((await f.reply(2)).error.code, -32002);
  f.send('notifications/initialized'); f.send('tools/call', undefined, { name: 'app_task_create' });
  f.send('operator_request_decide', 3); assert.equal((await f.reply(3)).error.code, -32601);
  f.send('tools/list', 4); assert.deepEqual((await f.reply(4)).result, { tools: [] });
  f.send('initialize', 5, init); assert.equal((await f.reply(5)).error.code, -32600);
  assert.deepEqual(calls, ['tools/list', 'tools/list']); assert.equal(await f.close(), 0);
});

test('stdio authenticates initialization failures and reports fixed errors without upstream secrets', async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts === 1) throw new Error('PRIVATE_ENDPOINT_TOKEN'); return { tools: [] }; });
  f.send('initialize', 1, init); assert.equal((await f.reply(1)).error.code, -32000);
  assert.equal(JSON.stringify(f.messages).includes('PRIVATE_ENDPOINT_TOKEN'), false);
  f.send('initialize', 2, init); assert.equal((await f.reply(2)).result.protocolVersion, '2025-11-25');
  assert.equal(await f.close(), 0);
});

test('stdio incrementally decodes UTF-8 frames and rejects invalid JSON, batches and malformed IDs', async () => {
  const f = fixture(async (_, params) => ({ params })); await f.initialize();
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'unicode', method: 'tools/call', params: { name: '한글😀' } }) + '\n');
  for (const byte of bytes) f.input.write(Buffer.from([byte]));
  assert.equal((await f.reply('unicode')).result.params.name, '한글😀');
  f.input.write('{broken}\n[]\n{"jsonrpc":"2.0","id":null,"method":"ping"}\n');
  f.send('ping', 9); await f.reply(9);
  assert.deepEqual(f.messages.filter(message => message.id === null).map(message => message.error.code), [-32700, -32600, -32600]);
  assert.equal(await f.close(), 0);
});

test('stdio cancellation and EOF abort pending requests and wait for callback cleanup', async () => {
  let aborted = false, finish!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(async (method, _, signal) => { if (method === 'tools/list') return { tools: [] };
    signal.addEventListener('abort', () => { aborted = true; }); started(); await gate; return {}; });
  await f.initialize(); f.send('tools/call', 2, { name: 'app_task_list' }); await entered;
  f.send('notifications/cancelled', undefined, { requestId: 2 }); assert.equal(aborted, true);
  let closed = false; const closing = f.close().then(result => { closed = true; return result; });
  await delay(20); assert.equal(closed, false); finish(); assert.equal(await closing, 0);
  assert.equal(f.messages.some(message => message.id === 2), false);
});

test('stdio EOF releases blocked writes and exits the standalone child with an unread stdout pipe', { timeout: 15_000 }, async t => {
  const input = new PassThrough();
  let written!: () => void, releaseWrite!: () => void;
  const writing = new Promise<void>(resolve => { written = resolve; });
  const output = new Writable({ write(_chunk, _encoding, callback) { releaseWrite = callback; written(); } });
  const closedOutput = once(output, 'close');
  const protocol = runDesktopMcpProtocol({ input, output, call: async () => ({}) });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`); await writing; input.end();
  try {
    const done = await Promise.race([protocol, delay(500).then(() => 'write still pending')]);
    assert.equal(done, 0); assert.equal(output.destroyed, true); await closedOutput;
  } finally { releaseWrite(); output.destroy(); await protocol; }

  const directory = await mkdtemp(join(tmpdir(), 'desktop-mcp-stdout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const method = JSON.parse(body).method;
      if (method === 'tools/call') calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: method === 'tools/list' ? { tools: [] } : { text: 'x'.repeat(230 * 1024) } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const ownerKey = randomUUID(), endpoint = join(directory, 'desktop-mcp-endpoint.json');
  await writeFile(endpoint, JSON.stringify({ version: 1, ownerKey, epoch: randomUUID(), origin: `http://127.0.0.1:${address.port}` }), { mode: 0o600 });
  const entry = process.env.MCP_COMPILED_FIXTURE_ENTRY ?? fileURLToPath(new URL('../server/desktop-mcp-entry.ts', import.meta.url));
  const entryArgs = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
  const child = spawn(process.execPath, [...entryArgs,
    '--endpoint-file', endpoint, '--owner-key', ownerKey, '--grant-id', randomUUID()],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_COMPANY_MCP_TOKEN: randomBytes(32).toString('base64url') }, windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; child.stdout.resume(); });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const onData = (chunk: Buffer) => { stdout += chunk.toString(); };
  child.stdout.on('data', onData);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init })}\n`);
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < deadline, `child deadline: calls=${calls}, buffered=${child.stdout.readableLength}, stderr=${stderr}`); assert.equal(child.exitCode, null, stderr); await delay(5); }
  };
  await waitFor(() => stdout.includes('\n')); assert.equal(JSON.parse(stdout).result.protocolVersion, '2025-11-25');
  child.stdout.pause(); child.stdout.off('data', onData);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  for (let id = 2; id < 9; id++) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {} })}\n`);
  await waitFor(() => calls === 7 && child.stdout.readableLength > 0);
  await delay(50); // Let completed HTTP reads fill the OS pipe while stdout remains paused.
  child.stdin.end();
  const shutdown = await Promise.race([exited, delay(2000).then(() => 'child did not exit')]);
  assert.deepEqual(shutdown, [0, null], stderr); child.stdout.resume();
});

test('stdio preserves active request IDs and returns known request errors without forwarding extra fields', async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(async (method, params) => { if (method === 'tools/list') return { tools: [] };
    if ((params as any).bad) throw new DesktopMcpCallError(-32602); await gate; return { done: true }; });
  await f.initialize(); f.send('tools/call', 2, {}); f.send('tools/call', 2, {});
  assert.equal((await f.reply(2)).error.code, -32600); finish(); assert.equal((await f.reply(2, 1)).result.done, true);
  f.send('tools/call', 3, { bad: true }); assert.deepEqual((await f.reply(3)).error, { code: -32602, message: 'Invalid tool request' });
  assert.equal(await f.close(), 0);
});

test('stdio closes on oversized, malformed UTF-8 or truncated frames and stops bounded request floods', async () => {
  for (const bytes of [Buffer.alloc(256 * 1024 + 1, 97), Buffer.from([0xc3, 0x28]), Buffer.from('{truncated')]) {
    const f = fixture(); f.input.end(bytes); assert.equal(await f.result, 1);
  }
  const f = fixture(); f.input.write(Array.from({ length: 20 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n').join(''));
  assert.equal(await f.result, 1);
});
