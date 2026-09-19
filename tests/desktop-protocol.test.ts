import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { runDesktopProtocol, type DesktopStart, type DesktopController } from '../server/desktop-protocol.ts';

const request = (): DesktopStart => ({ type: 'start', protocol: 1, nonce: randomBytes(32).toString('base64url'),
  token: randomBytes(32).toString('base64url'), cookieName: `ac_desktop_${randomBytes(16).toString('hex')}`,
  resourceRoot: 'C:\\설치 자원', appDataRoot: 'C:\\사용자 데이터' });
const waitFor = async (predicate: () => boolean) => {
  for (let n = 0; n < 200 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'protocol did not reach expected state');
};

test('private framed protocol publishes exact ready without credentials and closes before stopped', async () => {
  const input = new PassThrough(), output = new PassThrough(), messages: string[] = [], order: string[] = [];
  output.on('data', data => { messages.push(String(data)); order.push(JSON.parse(String(data)).type); });
  const req = request(); let captured: DesktopStart | undefined;
  const run = runDesktopProtocol({ input, output, start: async value => {
    captured = value; return { origin: 'http://127.0.0.1:23456', workspaceKey: randomUUID(),
      close: async () => { order.push('closed'); } };
  } });
  const bytes = Buffer.from(`${JSON.stringify(req)}\r\n`);
  // Include splits inside UTF-8 and a line split, as Rust shell events need not align to frames.
  for (const byte of bytes) input.write(Buffer.from([byte]));
  await waitFor(() => messages.length === 1);
  assert.deepEqual(captured, req);
  assert.equal(JSON.parse(messages[0]).nonce, req.nonce);
  input.write(`${JSON.stringify({ type: 'shutdown', protocol: 1, nonce: req.nonce })}\n`);
  assert.equal(await run, 0);
  assert.deepEqual(order, ['ready', 'closed', 'stopped']);
  assert.ok(!messages.join('').includes(req.token));
  assert.ok(!messages.join('').includes(req.cookieName));
});

test('EOF during startup aborts admission and waits for returned controller cleanup', async () => {
  const input = new PassThrough(), output = new PassThrough(); let release!: () => void, started = false, closed = false, aborted = false;
  let text = ''; output.on('data', chunk => { text += chunk; });
  const run = runDesktopProtocol({ input, output, start: async (_request, signal) => {
    started = true; signal.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(resolve => { release = resolve; });
    return { origin: 'http://127.0.0.1:23456', workspaceKey: randomUUID(), close: async () => { closed = true; } };
  } });
  input.write(`${JSON.stringify(request())}\n`); await waitFor(() => started);
  input.end(); await waitFor(() => aborted);
  assert.equal(closed, false); release(); assert.equal(await run, 0); assert.equal(closed, true);
  assert.ok(!text.includes('ready'));
});

test('malformed, excessive, duplicate, wrong nonce and unsupported protocol frames fail closed', async t => {
  for (const kind of ['json', 'oversize', 'protocol', 'duplicate', 'nonce', 'partial'] as const) {
    await t.test(kind, async () => {
      const input = new PassThrough(), output = new PassThrough(); let text = '', closed = 0, starts = 0;
      output.on('data', chunk => { text += chunk; });
      const req = request();
      const run = runDesktopProtocol({ input, output, start: async () => { starts++;
        return { origin: 'http://127.0.0.1:23456', workspaceKey: randomUUID(), close: async () => { closed++; } }; } });
      if (kind === 'json') input.end('{invalid\n');
      if (kind === 'oversize') input.end('a'.repeat(16 * 1024 + 1));
      if (kind === 'protocol') input.end(`${JSON.stringify({ ...req, protocol: 2 })}\n`);
      if (kind === 'partial') input.end('{');
      if (kind === 'duplicate' || kind === 'nonce') {
        input.write(`${JSON.stringify(req)}\n`); await waitFor(() => text.includes('ready'));
        input.write(`${JSON.stringify(kind === 'duplicate' ? req : { type: 'shutdown', protocol: 1, nonce: request().nonce })}\n`);
      }
      assert.equal(await run, 1); assert.equal(starts, closed);
      assert.ok(!text.includes(req.token)); assert.match(text, /DESKTOP_SESSION_FAILED/);
    });
  }
});

test('invalid ready and startup exceptions close resources without leaking exception text', async () => {
  for (const origin of ['http://evil.example:1234', 'http://127.0.0.1:23456/path', 'throw']) {
    const input = new PassThrough(), output = new PassThrough(); const req = request(); let text = '', closed = false;
    output.on('data', chunk => { text += chunk; });
    const run = runDesktopProtocol({ input, output, start: async (): Promise<DesktopController> => {
      if (origin === 'throw') throw new Error(req.token);
      return { origin, workspaceKey: randomUUID(), close: async () => { closed = true; } };
    } });
    input.write(`${JSON.stringify(req)}\n`); assert.equal(await run, 1);
    assert.equal(closed, origin !== 'throw'); assert.ok(!text.includes(req.token)); assert.ok(!text.includes('ready'));
  }
});

test('missing handshake has a bounded wait', async () => {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  assert.equal(await runDesktopProtocol({ input, output, startTimeoutMs: 10, start: async () => { throw new Error('must not start'); } }), 1);
});

test('truncated UTF-8 on parent EOF is a failed frame and still closes the live controller', async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '', closed = false;
  output.on('data', chunk => { text += chunk; });
  const run = runDesktopProtocol({ input, output, start: async () => ({ origin: 'http://127.0.0.1:23456',
    workspaceKey: randomUUID(), close: async () => { closed = true; } }) });
  input.write(`${JSON.stringify(request())}\n`); await waitFor(() => text.includes('ready'));
  input.end(Buffer.from([0xe3]));
  assert.equal(await run, 1); assert.equal(closed, true);
});
