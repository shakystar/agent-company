import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { DesktopDockerTarget } from './desktop-docker-target.ts';
import { DesktopRuntimeAuthError, openDesktopRuntimeAuth, type DesktopRuntimeAuthLease } from './desktop-runtime-auth.ts';
import type { RuntimeAuthBinding, RuntimeAuthBindingLease } from './runtime-auth-binding.ts';

type ErrorCode = 'DESKTOP_DOCKER_AUTH_INVALID' | 'DESKTOP_DOCKER_AUTH_ABORTED' | 'DESKTOP_DOCKER_AUTH_BUSY'
  | 'DESKTOP_DOCKER_AUTH_WRITER_ACTIVE' | 'DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED' | 'DESKTOP_DOCKER_AUTH_CLEANUP_PENDING';
export class DesktopDockerAuthError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'DesktopDockerAuthError'; }
}
const fail = (code: ErrorCode) => new DesktopDockerAuthError(code);
const redacted = (error: unknown) => error instanceof DesktopRuntimeAuthError || error instanceof DesktopDockerAuthError
  ? error : fail('DESKTOP_DOCKER_AUTH_INVALID');
const markerSchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop-codex'), workspaceKey: z.uuid() }).strict();
type Waiting = { signal: AbortSignal; state: 'queued' | 'entered' | 'settled'; abort: () => void;
  resolve: (lease: RuntimeAuthBindingLease) => void; reject: (error: Error) => void };
type Holding = { home: DesktopRuntimeAuthLease; closing: boolean; released: boolean; releasePromise?: Promise<void>;
  source: string; controller: AbortController; detach: () => void };

/** One installation owns one credential writer at a time, across Run/workspace generations. */
export class DesktopDockerAuth implements RuntimeAuthBinding {
  readonly ownerKey: string;
  private readonly credentialsRoot: string;
  private readonly target: DesktopDockerTarget;
  private readonly queue: Waiting[] = [];
  private entering = false;
  private active?: Holding;
  private pending?: Holding;
  private unrecoverable?: Error;
  private accountAdmission = false;

  constructor(options: { credentialsRoot: string; workspaceKey: string; target: DesktopDockerTarget }) {
    if (!z.uuid().safeParse(options.workspaceKey).success || !isAbsolute(options.credentialsRoot)
      || /[\x00-\x1f\x7f]/.test(options.credentialsRoot)
      || options.credentialsRoot.split(/[\\/]/).some(part => part === '.' || part === '..')
      || typeof options.target?.command !== 'function' || typeof options.target.mapAuthFile !== 'function') throw fail('DESKTOP_DOCKER_AUTH_INVALID');
    if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(options.credentialsRoot)
      || options.credentialsRoot.slice(3).split(/[\\/]/).some(part => /[<>:"|?*]|[. ]$/.test(part)
        || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
    this.ownerKey = options.workspaceKey; this.credentialsRoot = resolve(options.credentialsRoot); this.target = options.target;
    if (this.credentialsRoot === parse(this.credentialsRoot).root) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
  }

  async hasCredentials(): Promise<boolean> {
    // Presence only: no auth bytes are opened and no absent home/marker is initialized here.
    try {
      const home = join(this.credentialsRoot, 'codex');
      let cursor = parse(home).root;
      const directories: Array<{ path: string; dev: bigint; ino: bigint }> = [];
      for (const component of relative(cursor, home).split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, component);
        const info = await lstat(cursor, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink() || relative(cursor, await realpath(cursor))) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
        directories.push({ path: cursor, dev: info.dev, ino: info.ino });
      }
      const markerPath = join(home, 'desktop-codex-home.json'), before = await lstat(markerPath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
      const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const bytes = Buffer.alloc(4097);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
        let length = 0;
        while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
        if (BigInt(length) !== before.size) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
        const marker = markerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
        if (marker.workspaceKey !== this.ownerKey) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
        for (const now of [await handle.stat({ bigint: true }), await lstat(markerPath, { bigint: true })]) {
          if (!now.isFile() || now.nlink !== 1n || now.dev !== before.dev || now.ino !== before.ino || now.size !== before.size
            || now.mtimeNs !== before.mtimeNs || now.ctimeNs !== before.ctimeNs) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
        }
      } finally { bytes.fill(0); await handle.close(); }
      const authPath = join(home, 'auth.json'), auth = await lstat(authPath, { bigint: true });
      if (!auth.isFile() || auth.isSymbolicLink() || auth.nlink !== 1n || relative(authPath, await realpath(authPath))) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
      for (const entry of directories) {
        const now = await lstat(entry.path, { bigint: true });
        if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== entry.dev || now.ino !== entry.ino
          || relative(entry.path, await realpath(entry.path))) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
      }
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw redacted(error);
    }
  }

  async assertNoWriters(): Promise<void> {
    // Intentionally independent of active/queue state: openRuntimeAuth calls this under its own lease.
    let result;
    try { result = await this.target.command('docker', ['ps', '-aq', '--filter', `label=agent-company.credential-owner=${this.ownerKey}`], { timeoutMs: 15_000 }); }
    catch { throw fail('DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED'); }
    if (result.code !== 0 || result.stdout.length > 128 * 1024) throw fail('DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED');
    const lines = result.stdout ? result.stdout.replace(/\r?\n$/, '').split(/\r?\n/) : [];
    if (lines.some(line => !/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(line))
      || new Set(lines.map(line => line.slice(0, 12))).size !== lines.length) throw fail('DESKTOP_DOCKER_AUTH_IDLE_UNCONFIRMED');
    if (lines.length) throw fail('DESKTOP_DOCKER_AUTH_WRITER_ACTIVE');
  }

  async assertIdle(): Promise<void> {
    const busy = () => this.accountAdmission || this.entering || this.active || this.pending || this.unrecoverable || this.queue.length;
    if (busy()) throw fail('DESKTOP_DOCKER_AUTH_BUSY');
    await this.assertNoWriters();
    if (busy()) throw fail('DESKTOP_DOCKER_AUTH_BUSY');
  }

  /** Synchronous UI admission; the account child still performs the real writer check under its home lease. */
  assertAccountAvailable(): void {
    if (this.accountAdmission || this.entering || this.active || this.pending || this.unrecoverable || this.queue.length) {
      throw fail('DESKTOP_DOCKER_AUTH_BUSY');
    }
  }

  admitAccount(): () => void {
    this.assertAccountAvailable(); this.accountAdmission = true;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.accountAdmission = false; this.pump();
    };
  }

  acquire(signal: AbortSignal): Promise<RuntimeAuthBindingLease> {
    if (signal.aborted) return Promise.reject(fail('DESKTOP_DOCKER_AUTH_ABORTED'));
    if (this.unrecoverable) return Promise.reject(this.unrecoverable);
    return new Promise((yes, no) => {
      const item: Waiting = { signal, state: 'queued', resolve: yes, reject: no, abort: () => {
        if (item.state !== 'queued') return;
        item.state = 'settled';
        const index = this.queue.indexOf(item); if (index !== -1) this.queue.splice(index, 1);
        signal.removeEventListener('abort', item.abort); no(fail('DESKTOP_DOCKER_AUTH_ABORTED'));
        this.pump();
      } };
      this.queue.push(item); signal.addEventListener('abort', item.abort, { once: true });
      if (signal.aborted) item.abort(); else this.pump();
    });
  }

  private pump(): void {
    if (this.accountAdmission || this.entering || this.active || this.pending || this.unrecoverable) return;
    const item = this.queue.shift(); if (!item) return;
    item.state = 'entered'; this.entering = true;
    void this.enter(item).finally(() => { this.entering = false; this.pump(); });
  }

  private async enter(item: Waiting): Promise<void> {
    let holding: Holding | undefined;
    const check = () => { if (item.signal.aborted) throw fail('DESKTOP_DOCKER_AUTH_ABORTED'); };
    try {
      check();
      const home = await openDesktopRuntimeAuth({ credentialsRoot: this.credentialsRoot, workspaceKey: this.ownerKey,
        assertNoWriters: () => this.assertNoWriters() });
      const controller = new AbortController();
      const canceled = () => controller.abort(fail('DESKTOP_DOCKER_AUTH_ABORTED'));
      const lost = () => controller.abort(new DesktopRuntimeAuthError('DESKTOP_RUNTIME_AUTH_LEASE_LOST'));
      item.signal.addEventListener('abort', canceled, { once: true }); home.signal.addEventListener('abort', lost, { once: true });
      holding = { home, closing: false, released: false, source: '', controller, detach: () => {
        item.signal.removeEventListener('abort', canceled); home.signal.removeEventListener('abort', lost);
      } };
      if (home.signal.aborted) lost(); if (item.signal.aborted) canceled();
      controller.signal.throwIfAborted();
      holding.source = await this.target.mapAuthFile(home.authFile, controller.signal);
      await home.validate(); controller.signal.throwIfAborted();
      this.active = holding;
      const selected = holding;
      item.resolve({ source: selected.source, ownerKey: this.ownerKey, signal: controller.signal,
        validate: async () => {
          if (selected.closing || selected.released || this.active !== selected) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
          controller.signal.throwIfAborted(); await home.validate(); controller.signal.throwIfAborted();
          if (selected.closing || selected.released || this.active !== selected) throw fail('DESKTOP_DOCKER_AUTH_INVALID');
        },
        release: () => this.releaseHolding(selected),
      });
    } catch (error) {
      let failure = redacted(item.signal.aborted ? fail('DESKTOP_DOCKER_AUTH_ABORTED') : error);
      if (holding) {
        try { await this.releaseHolding(holding); } catch (cleanup) { failure = redacted(cleanup); }
      } else if (failure instanceof DesktopRuntimeAuthError
        && ['DESKTOP_RUNTIME_AUTH_CLEANUP_FAILED', 'DESKTOP_RUNTIME_AUTH_LEASE_LOST'].includes(failure.code)) this.unrecoverable = failure;
      item.reject(failure);
    } finally { item.state = 'settled'; item.signal.removeEventListener('abort', item.abort); }
  }

  private releaseHolding(holding: Holding): Promise<void> {
    holding.closing = true;
    if (holding.releasePromise) return holding.releasePromise;
    if (holding.released) return Promise.resolve();
    const finish = () => {
      holding.released = true; holding.detach();
      if (this.active === holding) this.active = undefined;
      if (this.pending === holding) this.pending = undefined;
      this.pump();
    };
    holding.releasePromise = (async () => {
      try { await holding.home.release(); finish(); }
      catch (error) {
        // This one error is reported after the underlying file lease was successfully unlocked.
        if (error instanceof DesktopRuntimeAuthError && error.code === 'DESKTOP_RUNTIME_AUTH_INVALID') finish();
        else {
          if (this.active === holding) this.active = undefined;
          this.pending = holding;
        }
        throw redacted(error);
      }
    })();
    void holding.releasePromise.catch(() => { if (!holding.released) holding.releasePromise = undefined; });
    return holding.releasePromise;
  }

  retryCleanup(): Promise<void> {
    if (this.unrecoverable) return Promise.reject(this.unrecoverable);
    return this.pending ? this.releaseHolding(this.pending) : Promise.resolve();
  }
}
