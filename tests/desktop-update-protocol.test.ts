import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runDesktopProtocol, type DesktopController, type DesktopStart } from '../server/desktop-protocol.ts';

const until = async (check: () => boolean) => {
  for (let n = 0; n < 200 && !check(); n++) await delay(5);
  assert.ok(check(), 'Private control response missing');
};
const start = (): DesktopStart => ({ type: 'start', protocol: 1, nonce: randomBytes(32).toString('base64url'),
  token: randomBytes(32).toString('base64url'), cookieName: `ac_desktop_${randomBytes(16).toString('hex')}`,
  resourceRoot: 'C:\\fixture-resources', appDataRoot: 'C:\\fixture-data' });
function harness(controller: Partial<DesktopController> = {}) {
  const input = new PassThrough(), output = new PassThrough(), request = start(), frames: Record<string, any>[] = [];
  output.on('data', data => frames.push(JSON.parse(String(data))));
  const done = runDesktopProtocol({ input, output, start: async () => ({ origin: 'http://127.0.0.1:22421',
    workspaceKey: randomUUID(), close: async () => {}, ...controller }) });
  const send = (value: object) => input.write(`${JSON.stringify(value)}\n`);
  send(request);
  const command = (type: string, updateId = randomUUID()) => ({ type, protocol: 1, nonce: request.nonce, requestId: randomUUID(), updateId });
  return { input, output, request, frames, done, send, command };
}
const ready = { phase: 'ready' as const, activeRunCount: 0, pendingRunCount: 4 };

test('native preparation replies correlate attempt and request, while ordinary shutdown remains unchanged', async () => {
  const calls: unknown[] = [];
  const h = harness({ update: async (request, signal) => { assert.equal(signal.aborted, false); calls.push(request); return ready; } });
  await until(() => h.frames.length === 1);
  const command = h.command('prepare-update'); h.send(command);
  await until(() => h.frames.length === 2);
  assert.deepEqual(h.frames[1], { type: 'update-status', protocol: 1, nonce: h.request.nonce,
    requestId: command.requestId, updateId: command.updateId, status: ready });
  assert.deepEqual(calls, [{ type: 'prepare-update', updateId: command.updateId }]);
  h.send({ type: 'shutdown', protocol: 1, nonce: h.request.nonce });
  assert.equal(await h.done, 0); assert.equal(h.frames.at(-1)?.type, 'stopped');
  assert.ok(!JSON.stringify(h.frames).includes(h.request.token));
});

test('control rejection or unsupported updater returns a fixed response without terminating the controller', async () => {
  for (const kind of ['unsupported', 'failure', 'invalid-status'] as const) {
    const h = harness(kind === 'unsupported' ? {} : { update: async () => {
      if (kind === 'failure') throw new Error('PRIVATE-EXCEPTION');
      return { ...ready, extra: 'PRIVATE-EXCEPTION' };
    } });
    await until(() => h.frames.length === 1); h.send(h.command('prepare-update'));
    await until(() => h.frames.length === 2);
    assert.equal(h.frames[1].code, kind === 'unsupported' ? 'DESKTOP_UPDATE_UNAVAILABLE' : 'DESKTOP_UPDATE_PREPARATION_FAILED');
    assert.ok(!JSON.stringify(h.frames).includes('PRIVATE-EXCEPTION'));
    h.input.end(); assert.equal(await h.done, 0);
  }
});

test('shutdown and EOF close admission and abort pending control, but wait for actual control cleanup before stopped', async () => {
  for (const end of ['shutdown', 'eof'] as const) {
    let release!: () => void, began = false, aborted = false, closed = false, closing = false;
    const h = harness({ beginClose: () => { closing = true; }, close: async () => { assert.equal(closing, true); closed = true; },
      update: async (_request, signal) => {
        began = true; signal.addEventListener('abort', () => { aborted = true; });
        await new Promise<void>(resolve => { release = resolve; }); return ready;
      } });
    await until(() => h.frames.length === 1); h.send(h.command('prepare-update')); await until(() => began);
    if (end === 'shutdown') h.send({ type: 'shutdown', protocol: 1, nonce: h.request.nonce }); else h.input.end();
    await until(() => aborted); assert.equal(closing, true); assert.equal(closed, false);
    assert.equal(h.frames.length, 1); release(); assert.equal(await h.done, 0);
    assert.equal(closed, true); assert.deepEqual(h.frames.map(frame => frame.type), ['ready', 'stopped']);
  }
});

test('malformed nonce, request id, attempt id and additional control fields fail closed', async () => {
  for (const change of [{ nonce: 'x'.repeat(43) }, { requestId: 'not-uuid' }, { updateId: 'bad' }, { url: 'https://untrusted.invalid/' }]) {
    let called = false, closed = false;
    const h = harness({ update: async () => { called = true; return ready; }, close: async () => { closed = true; } });
    await until(() => h.frames.length === 1); h.send({ ...h.command('prepare-update'), ...change });
    assert.equal(await h.done, 1); assert.equal(called, false); assert.equal(closed, true);
    assert.equal(h.frames.at(-1)?.code, 'DESKTOP_SESSION_FAILED');
  }
});

test('overlapping controls cannot mutate preparation concurrently or acknowledge stopped before pending control settles', async () => {
  let release!: () => void, calls = 0, closed = false;
  const h = harness({ update: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return ready; },
    close: async () => { closed = true; } });
  await until(() => h.frames.length === 1); h.send(h.command('prepare-update')); await until(() => calls === 1);
  h.send(h.command('cancel-update')); await delay(10); assert.equal(closed, false);
  release(); assert.equal(await h.done, 1); assert.equal(calls, 1); assert.equal(closed, true);
});

test('a parent can send its next control immediately when a response arrives', async () => {
  const h = harness({ update: async () => ready }); let replies = 0;
  await until(() => h.frames.length === 1);
  h.output.on('data', data => {
    if (JSON.parse(String(data)).type !== 'update-status') return;
    replies++;
    if (replies < 3) h.send(h.command('update-status'));
    else h.send({ type: 'shutdown', protocol: 1, nonce: h.request.nonce });
  });
  h.send(h.command('prepare-update'));
  assert.equal(await h.done, 0); assert.equal(replies, 3);
});
