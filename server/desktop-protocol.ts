import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { desktopUpdateControlSchema, desktopUpdateStatusSchema,
  type DesktopUpdateControl, type DesktopUpdateStatus } from './desktop-update-preparation.ts';

export const DESKTOP_PROTOCOL_VERSION = 1;
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const desktopStartSchema = z.object({ type: z.literal('start'), protocol: z.literal(DESKTOP_PROTOCOL_VERSION),
  nonce: secret, token: secret, cookieName: z.string().regex(/^ac_desktop_[a-f0-9]{32}$/),
  resourceRoot: z.string().min(1).max(4000), appDataRoot: z.string().min(1).max(4000) }).strict();
export type DesktopStart = z.infer<typeof desktopStartSchema>;
export interface DesktopController {
  origin: string; workspaceKey: string; close(): Promise<void>;
  beginClose?(): void;
  update?(request: DesktopUpdateControl, signal: AbortSignal): Promise<DesktopUpdateStatus>;
}
const shutdownSchema = z.object({ type: z.literal('shutdown'), protocol: z.literal(DESKTOP_PROTOCOL_VERSION), nonce: secret }).strict();
const updateSchema = desktopUpdateControlSchema.extend({
  protocol: z.literal(DESKTOP_PROTOCOL_VERSION), nonce: secret, requestId: z.uuid(),
}).strict();
export interface DesktopProtocolOptions {
  input: Readable; output: Writable;
  start: (request: DesktopStart, signal: AbortSignal) => Promise<DesktopController>;
  startTimeoutMs?: number;
}

/** Private parent pipe only. Credentials are input, never argv, URLs, stdout or diagnostic text. */
export async function runDesktopProtocol(options: DesktopProtocolOptions): Promise<number> {
  const controller = new AbortController(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', starting: Promise<void> | undefined, child: DesktopController | undefined;
  let controlPending: Promise<void> | undefined;
  let nonce: string | undefined, stopping = false, failure = false, finished = false;
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });
  const send = (value: object) => {
    if (!options.output.destroyed && options.output.writable) options.output.write(`${JSON.stringify(value)}\n`);
  };
  const stop = (failed: boolean) => {
    failure ||= failed;
    if (stopping) return;
    stopping = true; clearTimeout(timer); controller.abort();
    try { child?.beginClose?.(); } catch { failure = true; }
    void (async () => {
      try { await starting; } catch { failure = true; }
      // A close/EOF aborts control and waits for its real completion before
      // releasing the controller/database lease. It never acknowledges early.
      try { await controlPending; } catch { failure = true; }
      // Invalid ready metadata can reject after a live controller was returned.
      // Its cleanup must run even when startup validation failed.
      try { await child?.close(); } catch { failure = true; }
      finished = true;
      send({ type: failure ? 'error' : 'stopped', protocol: DESKTOP_PROTOCOL_VERSION,
        ...(nonce ? { nonce } : {}), ...(failure ? { code: 'DESKTOP_SESSION_FAILED' } : {}) });
      finish(failure ? 1 : 0);
    })();
  };
  const timer = setTimeout(() => stop(true), options.startTimeoutMs ?? 10_000);
  const line = (text: string) => {
    if (stopping || !text.length) { if (!stopping) stop(true); return; }
    try {
      const message: unknown = JSON.parse(text);
      if (!starting) {
        const request = desktopStartSchema.parse(message);
        nonce = request.nonce; clearTimeout(timer);
        // Defer start until `starting` is assigned so synchronous stream events cannot bypass close.
        starting = Promise.resolve().then(async () => {
          if (stopping) return;
          child = await options.start(request, controller.signal);
          const origin = new URL(child.origin);
          if (origin.origin !== child.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
            || !origin.port || !z.uuid().safeParse(child.workspaceKey).success) throw new Error('Invalid ready');
          if (!stopping) send({ type: 'ready', protocol: DESKTOP_PROTOCOL_VERSION, nonce,
            origin: child.origin, workspaceKey: child.workspaceKey });
        });
        void starting.catch(() => stop(true));
      } else {
        const request = z.union([shutdownSchema, updateSchema]).parse(message);
        if (request.nonce !== nonce) throw new Error('Invalid parent');
        if (request.type === 'shutdown') { stop(false); return; }
        if (!child || controlPending) throw new Error('Invalid control sequence');
        const control = child.update?.bind(child);
        const operation = Promise.resolve().then(async () => {
          if (stopping) return;
          let response: object;
          try {
            response = control ? { status: desktopUpdateStatusSchema.parse(await control(
              { type: request.type, updateId: request.updateId }, controller.signal)) }
              : { code: 'DESKTOP_UPDATE_UNAVAILABLE' };
          } catch { response = { code: 'DESKTOP_UPDATE_PREPARATION_FAILED' }; }
          if (!stopping) {
            controlPending = undefined;
            send({ type: 'update-status', protocol: DESKTOP_PROTOCOL_VERSION,
              nonce, requestId: request.requestId, updateId: request.updateId, ...response });
          }
        }).finally(() => { if (controlPending === operation) controlPending = undefined; });
        controlPending = operation;
      }
    } catch { stop(true); }
  };
  const onData = (data: Buffer | string) => {
    if (stopping) return;
    try { buffer += typeof data === 'string' ? data : decoder.decode(data, { stream: true }); }
    catch { stop(true); return; }
    // Bound the whole pending frame before parsing; a parent does not send unbounded bulk data.
    if (Buffer.byteLength(buffer) > 16 * 1024) { buffer = ''; stop(true); return; }
    let newline: number;
    while (!stopping && (newline = buffer.indexOf('\n')) >= 0) {
      const record = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); line(record);
    }
  };
  const onEnd = () => {
    try { buffer += decoder.decode(); } catch { stop(true); return; }
    stop(Boolean(buffer.length || !starting));
  };
  const onError = () => stop(true);
  options.input.on('data', onData).once('end', onEnd).once('close', onEnd).once('error', onError);
  options.output.once('error', onError).once('close', onError);
  try { return await done; }
  finally {
    clearTimeout(timer); buffer = '';
    options.input.off('data', onData).off('end', onEnd).off('close', onEnd).off('error', onError);
    options.output.off('error', onError).off('close', onError);
    if (finished) options.input.pause();
  }
}
