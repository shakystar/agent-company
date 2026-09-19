import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { openDesktopAccountHome } from './desktop-account-home.ts';

const boundedText = z.string().max(4096);
const loginId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const officialLoginUrl = z.string().max(16_384).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com'
      && !url.port && !url.username && !url.password && !url.hash;
  } catch { return false; }
});
const accountSchema = z.object({
  account: z.discriminatedUnion('type', [z.object({ type: z.literal('apiKey') }),
    z.object({ type: z.literal('chatgpt'), email: boundedText.nullable(), planType: z.string().max(64) })]).nullish(),
  requiresOpenaiAuth: z.boolean(),
});
const loginInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apiKey'), apiKey: z.string().min(1).max(8192).regex(/^\S+$/) }).strict(),
  z.object({ type: z.literal('chatgpt') }).strict(),
  z.object({ type: z.literal('chatgptDeviceCode') }).strict(),
]);
const loginResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apiKey') }),
  z.object({ type: z.literal('chatgpt'), loginId, authUrl: officialLoginUrl }),
  z.object({ type: z.literal('chatgptDeviceCode'), loginId,
    verificationUrl: officialLoginUrl, userCode: z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/) }),
]);
const completedSchema = z.object({ loginId: loginId.nullish(), success: z.boolean() });
export type DesktopCodexAccount = z.infer<typeof accountSchema>;
export type DesktopCodexLogin = z.infer<typeof loginInputSchema>;
export type DesktopCodexLoginResult = z.infer<typeof loginResultSchema>;
export type DesktopCodexAccountEvent = { type: 'accountChanged' }
  | { type: 'loginCompleted'; loginId: string | null; success: boolean }
  | { type: 'failed'; code: DesktopCodexAccountError['code'] };
type ErrorCode = 'CODEX_ACCOUNT_INVALID_INPUT' | 'CODEX_ACCOUNT_START_FAILED' | 'CODEX_ACCOUNT_PROTOCOL_FAILED'
  | 'CODEX_ACCOUNT_REQUEST_FAILED' | 'CODEX_ACCOUNT_TIMEOUT' | 'CODEX_ACCOUNT_CLOSED'
  | 'CODEX_ACCOUNT_BUSY' | 'CODEX_ACCOUNT_EXIT_FAILED' | 'CODEX_ACCOUNT_LEASE_LOST' | 'CODEX_ACCOUNT_CLEANUP_FAILED'
  | 'CODEX_ACCOUNT_WRITER_ACTIVE';

/** Never attach upstream error text, stderr, request params, URLs or credentials. */
export class DesktopCodexAccountError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'DesktopCodexAccountError'; }
}
export interface DesktopCodexAccountOptions {
  executable: string;
  credentialsRoot: string;
  workspaceKey: string;
  requestTimeoutMs?: number;
  onEvent?: (event: DesktopCodexAccountEvent) => void;
  /** Required by a configured container runtime. Runs under the home lease before any account child starts. */
  assertNoCredentialWriters?: () => Promise<void>;
  /** Process adapter for contract tests; product callers use the explicit bundled executable. */
  spawn?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}
export interface DesktopCodexAccountClient {
  readAccount(refreshToken?: boolean): Promise<DesktopCodexAccount>;
  startLogin(input: DesktopCodexLogin): Promise<DesktopCodexLoginResult>;
  cancelLogin(id: string): Promise<{ status: 'canceled' | 'notFound' }>;
  logout(): Promise<void>;
  /** Resolves only after child exit, pipe closure and lease release. No force termination. */
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

async function checkedExecutable(value: string): Promise<string> {
  if (!isAbsolute(value) || /[\x00-\x1f]/.test(value) || value.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    throw new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT');
  }
  const path = resolve(value);
  let cursor = parse(path).root;
  const parts = relative(cursor, path).split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink() || (i === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT');
    }
  }
  if (!parts.length || relative(path, await realpath(path))) throw new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT');
  return path;
}

/** Official managed account protocol only: no thread/turn/tool RPC or external-token login. */
export async function openDesktopCodexAccount(options: DesktopCodexAccountOptions): Promise<DesktopCodexAccountClient> {
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT');
  let executable: string;
  try { executable = await checkedExecutable(options.executable); }
  catch { throw new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT'); }
  // No search of USERPROFILE, HOME, PATH, .env, or any existing host authentication.
  let home: Awaited<ReturnType<typeof openDesktopAccountHome>>;
  try { home = await openDesktopAccountHome(options.credentialsRoot, options.workspaceKey); }
  catch (error) {
    throw new DesktopCodexAccountError(error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED'
      ? 'CODEX_ACCOUNT_BUSY' : 'CODEX_ACCOUNT_START_FAILED');
  }
  try {
    await options.assertNoCredentialWriters?.();
    home.signal.throwIfAborted();
  } catch {
    const failure = new DesktopCodexAccountError(home.signal.aborted ? 'CODEX_ACCOUNT_LEASE_LOST' : 'CODEX_ACCOUNT_WRITER_ACTIVE');
    try { await home.release(); }
    catch { throw new DesktopCodexAccountError(home.signal.aborted ? 'CODEX_ACCOUNT_LEASE_LOST' : 'CODEX_ACCOUNT_CLEANUP_FAILED'); }
    throw failure;
  }
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home.directory };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[name]; if (value !== undefined) env[name] = value;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawn ?? ((file, args, config) => spawn(file, args, { ...config, stdio: 'pipe' })))(executable,
      ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'],
      { cwd: home.directory, env, windowsHide: true, shell: false });
  } catch {
    try { await home.release(); } catch { throw new DesktopCodexAccountError('CODEX_ACCOUNT_CLEANUP_FAILED'); }
    throw new DesktopCodexAccountError('CODEX_ACCOUNT_START_FAILED');
  }
  type Pending = { resolve: (value: unknown) => void; reject: (error: DesktopCodexAccountError) => void; timer: NodeJS.Timeout };
  const pending = new Map<number, Pending>();
  let sequence = 0, stopping = false, failure: DesktopCodexAccountError | undefined;
  let buffer: Buffer = Buffer.alloc(0), outputEnded = false, exited = false;
  let finish!: () => void, finishError!: (error: DesktopCodexAccountError) => void;
  const closed = new Promise<void>((yes, no) => { finish = yes; finishError = no; });
  // Callers may not be awaiting close when the child fails. Preserve its rejection without an unhandled rejection.
  void closed.catch(() => {});
  const emit = (event: DesktopCodexAccountEvent) => {
    try { options.onEvent?.(event); }
    catch { stop(new DesktopCodexAccountError('CODEX_ACCOUNT_PROTOCOL_FAILED')); }
  };
  const stop = (error?: DesktopCodexAccountError) => {
    const newlyFailed = error && !failure;
    if (error) failure ??= error;
    stopping = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer); request.reject(failure ?? new DesktopCodexAccountError('CODEX_ACCOUNT_CLOSED'));
    }
    pending.clear(); buffer = Buffer.alloc(0);
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    if (newlyFailed) emit({ type: 'failed', code: failure!.code });
  };
  const protocolFailure = () => stop(new DesktopCodexAccountError('CODEX_ACCOUNT_PROTOCOL_FAILED'));
  const send = (message: object) => {
    try { child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) protocolFailure(); }); }
    catch { protocolFailure(); }
  };
  const request = async <T>(method: string, params: object, schema: z.ZodType<T>): Promise<T> => {
    if (stopping) throw failure ?? new DesktopCodexAccountError('CODEX_ACCOUNT_CLOSED');
    if (pending.size) throw new DesktopCodexAccountError('CODEX_ACCOUNT_BUSY');
    const id = ++sequence;
    const response = new Promise<unknown>((yes, no) => {
      const timer = setTimeout(() => stop(new DesktopCodexAccountError('CODEX_ACCOUNT_TIMEOUT')), timeout);
      pending.set(id, { resolve: yes, reject: no, timer });
      send({ id, method, params });
    });
    const result = schema.safeParse(await response);
    if (!result.success) {
      protocolFailure(); throw failure!;
    }
    return result.data;
  };
  const frame = (bytes: Buffer) => {
    try {
      const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!message || typeof message !== 'object' || Array.isArray(message)) return protocolFailure();
      const item = message as Record<string, unknown>;
      if (item.jsonrpc !== undefined && item.jsonrpc !== '2.0') return protocolFailure();
      if ('id' in item) {
        if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || 'method' in item) return protocolFailure();
        const awaiting = pending.get(item.id);
        if (!awaiting || ('result' in item) === ('error' in item)) return protocolFailure();
        pending.delete(item.id); clearTimeout(awaiting.timer);
        if ('error' in item) awaiting.reject(new DesktopCodexAccountError('CODEX_ACCOUNT_REQUEST_FAILED'));
        else awaiting.resolve(item.result);
      } else if (typeof item.method === 'string') {
        if (item.method === 'account/login/completed') {
          const result = completedSchema.safeParse(item.params);
          if (!result.success) return protocolFailure();
          emit({ type: 'loginCompleted', loginId: result.data.loginId ?? null, success: result.data.success });
        } else if (item.method === 'account/updated') emit({ type: 'accountChanged' });
        // Other bounded notifications are intentionally not forwarded or retained.
      } else protocolFailure();
    } catch { protocolFailure(); }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopping) return;
    let offset = 0;
    while (!stopping && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline === -1 ? chunk.length : newline;
      if (buffer.length + end - offset > 128 * 1024) return protocolFailure();
      buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
      if (newline === -1) return;
      const complete = buffer; buffer = Buffer.alloc(0); frame(complete); offset = end + 1;
    }
  });
  child.stdout.once('end', () => {
    outputEnded = true;
    if (buffer.length || !stopping) protocolFailure();
  });
  child.stdout.once('error', protocolFailure);
  child.stdin.once('error', protocolFailure);
  child.stderr.once('error', protocolFailure);
  // Drain diagnostics without storing or exposing upstream text, which can contain credentials.
  child.stderr.resume();
  child.once('error', () => stop(new DesktopCodexAccountError('CODEX_ACCOUNT_START_FAILED')));
  child.once('exit', (code, signal) => {
    exited = true;
    if (code !== 0 || signal !== null) stop(new DesktopCodexAccountError('CODEX_ACCOUNT_EXIT_FAILED'));
    else if (!stopping) stop(new DesktopCodexAccountError('CODEX_ACCOUNT_CLOSED'));
  });
  const leaseLost = () => stop(new DesktopCodexAccountError('CODEX_ACCOUNT_LEASE_LOST'));
  home.signal.addEventListener('abort', leaseLost, { once: true });
  if (home.signal.aborted) leaseLost();
  child.once('close', () => {
    // close follows exit (or failed spawn) and all child stdio closure.
    if (!exited && !failure) stop(new DesktopCodexAccountError('CODEX_ACCOUNT_START_FAILED'));
    if (!outputEnded && !failure) protocolFailure();
    stop(); home.signal.removeEventListener('abort', leaseLost);
    void home.release().then(() => { if (failure) finishError(failure); else finish(); }, () => {
      finishError(failure ?? new DesktopCodexAccountError('CODEX_ACCOUNT_CLEANUP_FAILED'));
    });
  });
  const close = () => { stop(); return closed; };
  const client: DesktopCodexAccountClient = {
    closed, close,
    readAccount: (refreshToken = false) => {
      if (typeof refreshToken !== 'boolean') return Promise.reject(new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT'));
      return request('account/read', { refreshToken }, accountSchema);
    },
    startLogin: async input => {
      const parsed = loginInputSchema.safeParse(input);
      if (!parsed.success) throw new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT');
      const result = await request('account/login/start', parsed.data, loginResultSchema);
      if (result.type !== parsed.data.type) { protocolFailure(); throw failure!; }
      return result;
    },
    cancelLogin: id => {
      if (!loginId.safeParse(id).success) return Promise.reject(new DesktopCodexAccountError('CODEX_ACCOUNT_INVALID_INPUT'));
      return request('account/login/cancel', { loginId: id }, z.object({ status: z.enum(['canceled', 'notFound']) }));
    },
    logout: async () => { await request('account/logout', {}, z.object({})); },
  };
  try {
    const ready = await request('initialize', { clientInfo: { name: 'agent_company_desktop', version: '0.1.0' },
      capabilities: { experimentalApi: false } },
    z.object({ codexHome: z.string().max(4096), platformFamily: boundedText, platformOs: boundedText, userAgent: boundedText }));
    if (!isAbsolute(ready.codexHome) || relative(home.directory, resolve(ready.codexHome))) throw new DesktopCodexAccountError('CODEX_ACCOUNT_PROTOCOL_FAILED');
    if (stopping) throw failure ?? new DesktopCodexAccountError('CODEX_ACCOUNT_CLOSED');
    send({ method: 'initialized' });
    return client;
  } catch (error) {
    stop(error instanceof DesktopCodexAccountError ? error : new DesktopCodexAccountError('CODEX_ACCOUNT_START_FAILED'));
    try { await closed; } catch { /* Retain the first redacted startup failure. */ }
    throw failure!;
  }
}
