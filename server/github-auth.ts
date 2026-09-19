import { createPrivateKey, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type GitHubAccess = 'read' | 'write';
export interface GitHubConfig {
  appId?: string;
  installationId?: string;
  privateKeyFile?: string;
  repositories: string[];
  forbiddenRoots: string[];
}
export interface GitHubAuthStatus { configured: boolean; missing: string[]; repositories: string[] }
export interface GitHubAuthOptions {
  fetch?: typeof globalThis.fetch;
  /** Trusted dependency injection for tests; production uses the bounded regular-file reader. */
  readFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
  now?: () => number;
  timeoutMs?: number;
}

const apiOrigin = 'https://api.github.com';
const apiVersion = '2026-03-10';
const maximumKeyBytes = 65_536;
const maximumResponseBytes = 262_144;
const fields = ['AGENT_GITHUB_APP_ID', 'AGENT_GITHUB_INSTALLATION_ID', 'AGENT_GITHUB_PRIVATE_KEY_FILE', 'AGENT_GITHUB_REPOSITORIES'] as const;

export class GitHubAuthError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GitHubAuthError'; }
}
const invalidConfig = () => new GitHubAuthError('GITHUB_CONFIG_INVALID', 'GitHub App 설정 형식 또는 비밀키 보관 위치가 올바르지 않습니다.');
const invalidScope = () => new GitHubAuthError('GITHUB_SCOPE_INVALID', 'GitHub App 설치 또는 토큰의 저장소·권한 범위가 일치하지 않습니다.');
const keyError = () => new GitHubAuthError('GITHUB_KEY_INVALID', 'GitHub App 비밀키를 안전하게 읽거나 서명할 수 없습니다.');

function repositoryName(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i.test(value)) throw invalidConfig();
  const name = value.split('/')[1];
  if (name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) throw invalidConfig();
  return value.toLowerCase();
}
function within(root: string, target: string) {
  const part = relative(root, target);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}
function privatePath(path: string, roots: string[]) {
  // Reject device/UNC paths and alternate data streams on Windows as well as relative paths.
  if (!isAbsolute(path) || path.includes('\0') || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')))
    || roots.some(root => within(root, resolve(path)))) throw invalidConfig();
  return resolve(path);
}

export function readGitHubConfig(env: NodeJS.ProcessEnv = process.env, options: { workspaceRoot?: string; forbiddenRoots?: string[] } = {}): GitHubConfig {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const forbiddenRoots = [...new Set([workspaceRoot, resolve(workspaceRoot, env.AGENT_DATA_DIR ?? '.data'),
    ...(env.AGENT_BACKUP_DIR ? [resolve(workspaceRoot, env.AGENT_BACKUP_DIR)] : []),
    ...(options.forbiddenRoots ?? []).map(path => resolve(path)),
    ...(process.platform === 'win32' ? [] : ['/workspace', '/app'])])];
  const [appId, installationId, keyFile, list] = fields.map(field => env[field]?.trim() || undefined);
  if ([appId, installationId].some(value => value !== undefined && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))) throw invalidConfig();
  const repositories = list ? list.split(',').map(value => repositoryName(value.trim())) : [];
  if (repositories.length > 500 || new Set(repositories).size !== repositories.length) throw invalidConfig();
  return { appId, installationId, privateKeyFile: keyFile ? privatePath(keyFile, forbiddenRoots) : undefined, repositories, forbiddenRoots };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidScope();
  return value as Record<string, unknown>;
}
function abortError() { return new GitHubAuthError('GITHUB_ABORTED', 'GitHub 인증 요청이 취소되었거나 제한 시간을 초과했습니다.'); }
function aborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(abortError()); }
  return new Promise((resolveResult, rejectResult) => {
    const onAbort = () => rejectResult(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolveResult, rejectResult).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class GitHubAppAuth {
  #config: GitHubConfig;
  #fetch: typeof globalThis.fetch;
  #readFile: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
  #now: () => number;
  #timeoutMs: number;
  constructor(config: GitHubConfig, options: GitHubAuthOptions = {}) {
    // Copy configuration so a caller cannot expand an existing provider's authority by mutation.
    this.#config = readGitHubConfig({ AGENT_GITHUB_APP_ID: config.appId, AGENT_GITHUB_INSTALLATION_ID: config.installationId,
      AGENT_GITHUB_PRIVATE_KEY_FILE: config.privateKeyFile, AGENT_GITHUB_REPOSITORIES: config.repositories.join(',') },
    { forbiddenRoots: config.forbiddenRoots });
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#readFile = options.readFile ?? ((path, signal) => this.#readPrivateKey(path, signal));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) throw invalidConfig();
  }
  status(): GitHubAuthStatus {
    const c = this.#config;
    const present = [c.appId, c.installationId, c.privateKeyFile, c.repositories.length];
    const missing = fields.filter((_field, index) => !present[index]);
    return { configured: missing.length === 0, missing, repositories: [...c.repositories] };
  }
  async #readPrivateKey(path: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const original = await lstat(path);
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.size < 1 || original.size > maximumKeyBytes) throw keyError();
    const canonicalRoots = await Promise.all(this.#config.forbiddenRoots.map(async root => {
      try { return await realpath(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return root; throw keyError(); }
    }));
    const canonical = privatePath(await realpath(path), [...this.#config.forbiddenRoots, ...canonicalRoots]);
    const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== original.size || info.dev !== original.dev || info.ino !== original.ino
        || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw keyError();
      const buffer = Buffer.alloc(maximumKeyBytes + 1);
      let size = 0;
      try {
        while (size < buffer.length) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size !== info.size || size > maximumKeyBytes) throw keyError();
        return Buffer.from(buffer.subarray(0, size));
      } finally { buffer.fill(0); }
    } finally { await file.close(); }
  }
  async #json(path: string, jwt: string, signal: AbortSignal, body?: object) {
    const response = await aborted(this.#fetch(`${apiOrigin}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'X-GitHub-Api-Version': apiVersion,
        'User-Agent': 'agent-company', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new GitHubAuthError('GITHUB_HTTP_ERROR', `GitHub 인증 요청이 실패했습니다. HTTP ${response.status}.`);
    }
    const rejectResponse = () => { void response.body?.cancel().catch(() => undefined); throw invalidScope(); };
    if (response.redirected || (response.url && new URL(response.url).origin !== apiOrigin)) rejectResponse();
    const length = Number(response.headers.get('content-length'));
    if (!Number.isFinite(length) || length < 0 || length > maximumResponseBytes || !response.body) rejectResponse();
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await aborted(reader.read(), signal);
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maximumResponseBytes) throw invalidScope();
        chunks.push(part.value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally { void reader.cancel().catch(() => undefined); }
  }
  /** Controller-internal credential only. Never persist or include it in a worker/tool response. */
  async token(repository: string, access: GitHubAccess, signal?: AbortSignal, expectedRepositoryId?: number): Promise<string> {
    try {
      if (!this.status().configured) throw new GitHubAuthError('GITHUB_NOT_CONFIGURED', 'GitHub App 연결 설정이 완료되지 않았습니다.');
      const normalized = repositoryName(repository);
      if (!this.#config.repositories.includes(normalized) || !['read', 'write'].includes(access)) throw invalidScope();
      if (expectedRepositoryId !== undefined && (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId < 1)) throw invalidScope();
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#timeoutMs)]);
      if (requestSignal.aborted) throw abortError();
      const bytes = Buffer.from(await aborted(this.#readFile(this.#config.privateKeyFile!, requestSignal), requestSignal));
      let jwt: string;
      try {
        if (bytes.byteLength < 1 || bytes.byteLength > maximumKeyBytes) throw keyError();
        const key = createPrivateKey(bytes);
        if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw keyError();
        const now = Math.floor(this.#now() / 1000);
        const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
          iat: now - 60, exp: now + 540, iss: this.#config.appId,
        })).toString('base64url')}`;
        jwt = `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
      } catch { throw keyError(); } finally { bytes.fill(0); }
      const [owner, name] = normalized.split('/');
      const installation = await this.#json(`/repos/${owner}/${name}/installation`, jwt, requestSignal);
      if (String(installation.id) !== this.#config.installationId || String(installation.app_id) !== this.#config.appId
        || String(record(installation.account).login).toLowerCase() !== owner || installation.suspended_at !== null) throw invalidScope();
      const permissions = { contents: access, pull_requests: access, metadata: 'read' };
      const issued = await this.#json(`/app/installations/${this.#config.installationId}/access_tokens`, jwt, requestSignal,
        { ...(expectedRepositoryId === undefined ? { repositories: [name] } : { repository_ids: [expectedRepositoryId] }), permissions });
      const granted = record(issued.permissions);
      if (Object.keys(granted).length !== Object.keys(permissions).length
        || Object.entries(permissions).some(([permission, level]) => granted[permission] !== level)) throw invalidScope();
      if (issued.repository_selection !== 'selected' || !Array.isArray(issued.repositories) || issued.repositories.length !== 1
        || String(record(issued.repositories[0]).full_name).toLowerCase() !== normalized
        || expectedRepositoryId !== undefined && record(issued.repositories[0]).id !== expectedRepositoryId) throw invalidScope();
      const expires = typeof issued.expires_at === 'string' ? Date.parse(issued.expires_at) : NaN;
      if (!Number.isFinite(expires) || expires <= this.#now() + 60_000 || expires > this.#now() + 3_660_000
        || typeof issued.token !== 'string' || issued.token.length < 1 || issued.token.length > 32_768 || !/^[\x21-\x7e]+$/.test(issued.token)) throw invalidScope();
      if (requestSignal.aborted) throw abortError();
      return issued.token;
    } catch (error) {
      if (error instanceof GitHubAuthError) throw error;
      // Fetch, filesystem, PEM and JSON errors can include credentials or response content.
      throw new GitHubAuthError('GITHUB_AUTH_FAILED', 'GitHub App 인증을 완료하지 못했습니다. 연결 설정과 접근 권한을 확인해야 합니다.');
    }
  }
}
