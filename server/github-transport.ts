import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GITHUB_REQUEST_JSON_MAX_BYTES, GITHUB_RESULT_ENCODED_MAX_BYTES, GITHUB_READ_MAX_BYTES, GITHUB_LIST_MAX_FILES,
  repositoryJsonBytes, repositoryResultEncodedBytes } from '../shared/repositories.ts';

// GitHub GraphQL commits provide atomic expectedHeadOid validation; the REST
// update-ref endpoint's force:false is only a fast-forward check, not a CAS.
// https://docs.github.com/en/graphql/reference/commits#createcommitonbranch
// https://docs.github.com/en/graphql/reference/git#filechanges
const apiOrigin = 'https://api.github.com';
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const limits = { response: 4 * 1024 * 1024, file: GITHUB_READ_MAX_BYTES, files: 100, tree: 10_000 };
const treeEntrySchema = z.object({ path: z.string().max(1024), mode: z.string(), type: z.enum(['blob', 'tree', 'commit']), sha: shaSchema, size: z.number().int().nonnegative().optional() });
type TreeEntry = z.infer<typeof treeEntrySchema>;
const commitSchema = z.object({ sha: shaSchema, tree: z.object({ sha: shaSchema }), parents: z.array(z.object({ sha: shaSchema })).max(100), message: z.string().max(100_000) });
const prSchema = z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']), title: z.string().max(1000), body: z.string().max(100_000).nullable(), merged: z.boolean().optional(),
  head: z.object({ ref: z.string(), sha: shaSchema, repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), sha: shaSchema, repo: z.object({ full_name: z.string() }).nullable() }) });

export class GitHubTransportError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 502, readonly httpStatus?: number) {
    super(message); this.name = 'GitHubTransportError';
  }
}
const invalid = (message = 'GitHub 요청 입력이 올바르지 않습니다.') => new GitHubTransportError('GITHUB_INPUT', message, 400);
const conflict = () => new GitHubTransportError('GITHUB_CONFLICT', '저장소 HEAD가 변경됐습니다. 최신 파일을 확인한 뒤 새 작업으로 진행해야 합니다.', 409);
const malformed = () => new GitHubTransportError('GITHUB_RESPONSE', 'GitHub 응답 형식을 확인할 수 없습니다.');
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw malformed(); return result.data; }
function bridgeResult<T>(value: T): T {
  if (repositoryResultEncodedBytes(value) > GITHUB_RESULT_ENCODED_MAX_BYTES) throw new GitHubTransportError('GITHUB_SIZE', 'GitHub 결과의 MCP 인코딩 크기가 512KiB 한도를 초과했습니다.', 413);
  return value;
}
function repositoryName(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(value)
    || ['.', '..'].includes(value.split('/')[1])) throw invalid('저장소는 owner/repository 형식이어야 합니다.');
  return value;
}
function refName(value: string) {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('.') || value.endsWith('/')
    || value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) || value.startsWith('refs/')) throw invalid('Git ref 형식이 올바르지 않습니다.');
  return value;
}
function publicationBranch(value: string) {
  refName(value);
  if (!/^agent-company\/[a-zA-Z0-9][a-zA-Z0-9-]{0,59}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,79})?$/.test(value)) throw invalid('agent-company 실행 전용 브랜치만 작성할 수 있습니다.');
  return value;
}
/** Reject paths rather than normalizing them into a different target. */
export function githubFilePath(value: string) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.normalize('NFC') !== value
    || /[\\\u0000-\u001f\u007f:%]/.test(value) || value.startsWith('/') || value.endsWith('/')) throw invalid('저장소 파일 경로가 올바르지 않습니다.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:\.git|\.gitmodules|\.env(?:\..*)?|\.ssh|\.codex|\.agent-runtime|\.npmrc|\.netrc|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|cookies?(?:\..*)?|sessions?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)
    || /\.(?:pem|p12|pfx|key)$/i.test(part)) || parts.some((part, index) => part.toLowerCase() === '.github' && parts[index + 1]?.toLowerCase() === 'workflows')) {
    throw invalid('인증·비밀·워크플로·Git 내부 파일은 이 연결로 처리하지 않습니다.');
  }
  return value;
}
function safeText(value: string, maxBytes: number) {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value || value.includes('\0') || Buffer.byteLength(value) > maxBytes) throw invalid('UTF-8 텍스트 크기 또는 형식이 올바르지 않습니다.');
  // This catches recognizable credentials, not every possible secret. The
  // service must also keep its secret store outside artifacts and worker input.
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/.test(value)) throw invalid('자격증명으로 보이는 내용은 외부로 전송하지 않습니다.');
  return value;
}
function gitBlob(content: string) { const bytes = Buffer.from(content); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');
const repoPath = (repository: string) => `/repos/${repositoryName(repository)}`;
const recoverable = (error: unknown) => error instanceof GitHubTransportError && [409, 422, 502, 503, 504].includes(error.httpStatus ?? error.statusCode);
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('GitHub request aborted')); };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

export interface GitHubPublishInput {
  branch: string; baseBranch: string; expectedHeadSha: string; files: Array<{ path: string; content: string }>; message: string;
}
export interface GitHubReviseInput extends GitHubPublishInput { number: number }
export interface GitHubPublication { branch: string; headSha: string; commitUrl: string; unchanged: boolean; replayed: boolean }
export interface GitHubPullRequest { number: number; url: string; head: string; base: string; headSha: string; baseSha: string; state: 'open' | 'closed'; existing: boolean; title: string; body: string; merged?: boolean }
export interface GitHubTransportOptions {
  token: (repository: string, access: 'read' | 'write', signal?: AbortSignal) => Promise<string>;
  fetch?: typeof globalThis.fetch;
}
export class GitHubTransport {
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: GitHubTransportOptions) { this.fetcher = options.fetch ?? globalThis.fetch; }

  private async request(repository: string, access: 'read' | 'write', path: string, signal?: AbortSignal, body?: unknown) {
    repositoryName(repository);
    if (!(path.startsWith(`${repoPath(repository)}/`) || path === repoPath(repository) || path === '/graphql')) throw invalid();
    const deadline = AbortSignal.timeout(20_000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response: Response;
    try {
      combined.throwIfAborted();
      const token = await abortable(this.options.token(repository, access, combined), combined);
      combined.throwIfAborted();
      if (!token || token.length > 20_000 || /[\r\n]/.test(token)) throw new GitHubTransportError('GITHUB_AUTH', 'GitHub 연결 인증을 사용할 수 없습니다.', 503);
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized && Buffer.byteLength(serialized) > limits.response) throw invalid('GitHub 전송 크기 제한을 초과했습니다.');
      response = await abortable(this.fetcher(`${apiOrigin}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'agent-company', ...(serialized ? { 'Content-Type': 'application/json' } : {}) }, body: serialized }), combined);
      if (response.redirected || response.status >= 300 && response.status < 400) throw new GitHubTransportError('GITHUB_REDIRECT', 'GitHub 리디렉션은 허용하지 않습니다.');
      if (response.url && new URL(response.url).origin !== apiOrigin) throw new GitHubTransportError('GITHUB_REDIRECT', 'GitHub 외부 응답은 허용하지 않습니다.');
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubTransportError('GITHUB_HTTP', `GitHub 요청이 HTTP ${response.status} 상태로 실패했습니다.`, [401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502, response.status);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > limits.response) { await response.body?.cancel(); throw new GitHubTransportError('GITHUB_SIZE', 'GitHub 응답 크기 제한을 초과했습니다.', 413); }
      if (!response.body) throw malformed();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const part = await abortable(reader.read(), combined); if (part.done) break;
          total += part.value.byteLength;
          if (total > limits.response) { await reader.cancel(); throw new GitHubTransportError('GITHUB_SIZE', 'GitHub 응답 크기 제한을 초과했습니다.', 413); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw malformed(); }
      return { value, hasNext: /rel="next"/.test(response.headers.get('link') ?? '') };
    } catch (error) {
      if (error instanceof GitHubTransportError) throw error;
      if (signal?.aborted) throw new GitHubTransportError('GITHUB_ABORTED', 'GitHub 요청이 중단됐습니다.', 409);
      if (deadline.aborted) throw new GitHubTransportError('GITHUB_TIMEOUT', 'GitHub 요청 시간이 초과됐습니다.', 504);
      // Fetch errors and provider errors may contain tokens or response bodies.
      throw new GitHubTransportError('GITHUB_NETWORK', 'GitHub 연결 요청을 완료하지 못했습니다.');
    }
  }
  private async json(repository: string, access: 'read' | 'write', suffix: string, signal?: AbortSignal, body?: unknown) {
    return (await this.request(repository, access, `${repoPath(repository)}${suffix}`, signal, body)).value;
  }
  async inspect(repository: string, signal?: AbortSignal) {
    const value = parsed(z.object({ id: z.number().int().positive(), full_name: z.string(), default_branch: z.string(), private: z.boolean() }), await this.json(repository, 'read', '', signal));
    if (value.full_name.toLowerCase() !== repository.toLowerCase()) throw malformed();
    return bridgeResult({ id: value.id, fullName: repositoryName(value.full_name), defaultBranch: refName(value.default_branch), private: value.private });
  }
  private async branchHead(repository: string, branch: string, signal?: AbortSignal): Promise<string | null> {
    refName(branch);
    try {
      const value = parsed(z.object({ ref: z.string(), object: z.object({ type: z.literal('commit'), sha: shaSchema }) }), await this.json(repository, 'read', `/git/ref/heads/${encodePath(branch)}`, signal));
      if (value.ref !== `refs/heads/${branch}`) throw malformed();
      return value.object.sha;
    } catch (error) { if (error instanceof GitHubTransportError && error.httpStatus === 404) return null; throw error; }
  }
  private async resolve(repository: string, ref: string, signal?: AbortSignal) {
    refName(ref);
    const sha = shaSchema.safeParse(ref).success ? ref : await this.branchHead(repository, ref, signal);
    if (!sha) throw new GitHubTransportError('GITHUB_NOT_FOUND', '저장소 브랜치를 찾을 수 없습니다.', 404);
    return this.commit(repository, sha, signal);
  }
  private async commit(repository: string, sha: string, signal?: AbortSignal) {
    const value = parsed(commitSchema, await this.json(repository, 'read', `/git/commits/${parsed(shaSchema, sha)}`, signal));
    if (value.sha !== sha) throw malformed(); return value;
  }
  private async tree(repository: string, sha: string, signal?: AbortSignal) {
    const value = parsed(z.object({ sha: shaSchema, truncated: z.boolean(), tree: z.array(treeEntrySchema).max(limits.tree) }), await this.json(repository, 'read', `/git/trees/${sha}?recursive=1`, signal));
    if (value.sha !== sha) throw malformed();
    if (value.truncated) throw new GitHubTransportError('GITHUB_SIZE', '저장소 목록이 잘려 안전하게 처리할 수 없습니다.', 413);
    if (new Set(value.tree.map(item => item.path)).size !== value.tree.length) throw malformed();
    return value.tree;
  }
  async listFiles(repository: string, ref: string, signal?: AbortSignal) {
    const commit = await this.resolve(repository, ref, signal), tree = await this.tree(repository, commit.tree.sha, signal);
    const files = tree.filter(entry => {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return false;
      try { githubFilePath(entry.path); return true; } catch { return false; }
    }).map(({ path, sha, size }) => ({ path, sha, size: size ?? null }));
    if (files.length > GITHUB_LIST_MAX_FILES) throw new GitHubTransportError('GITHUB_SIZE', 'GitHub 파일 목록이 1000개 한도를 초과했습니다. 잘린 목록은 반환하지 않습니다.', 413);
    return bridgeResult({ ref, headSha: commit.sha, files, truncated: false as const, omittedFiles: tree.filter(item => item.type !== 'tree').length - files.length });
  }
  async readFile(repository: string, path: string, ref: string, signal?: AbortSignal) {
    githubFilePath(path);
    const commit = await this.resolve(repository, ref, signal), tree = await this.tree(repository, commit.tree.sha, signal), file = tree.find(item => item.path === path);
    if (!file) throw new GitHubTransportError('GITHUB_NOT_FOUND', '저장소 파일을 찾을 수 없습니다.', 404);
    if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) throw invalid('일반 파일만 읽을 수 있습니다.');
    if ((file.size ?? Infinity) > limits.file) throw new GitHubTransportError('GITHUB_SIZE', '파일 읽기 크기 제한을 초과했습니다.', 413);
    const blob = parsed(z.object({ sha: shaSchema, encoding: z.literal('base64'), content: z.string(), size: z.number().int().nonnegative().max(limits.file) }), await this.json(repository, 'read', `/git/blobs/${file.sha}`, signal));
    const base64 = blob.content.replace(/[\r\n]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw malformed();
    const bytes = Buffer.from(base64, 'base64');
    if (blob.sha !== file.sha || bytes.length !== blob.size || blob.size !== file.size) throw malformed();
    let content: string; try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw invalid('UTF-8 텍스트 파일만 읽을 수 있습니다.'); }
    if (gitBlob(content) !== file.sha) throw malformed();
    safeText(content, limits.file);
    return bridgeResult({ path, ref, headSha: commit.sha, sha: file.sha, content, encoding: 'utf-8' as const });
  }
  async publish(repository: string, input: GitHubPublishInput, signal?: AbortSignal): Promise<GitHubPublication> {
    return this.commitFiles(repository, input, false, signal);
  }
  async revise(repository: string, input: GitHubReviseInput, signal?: AbortSignal) {
    const branch = publicationBranch(input.branch), base = refName(input.baseBranch);
    const pr = await this.getPullRequest(repository, input.number, signal);
    if (pr.state !== 'open' || pr.merged || pr.head !== branch || pr.base !== base) {
      throw new GitHubTransportError('GITHUB_PR_SCOPE', '열린 원래 PR의 작업 브랜치와 기준 브랜치가 일치해야 합니다.', 409);
    }
    // The service authenticates this branch through its original receipt and
    // frozen scope. Never recreate a deleted branch during a revision.
    const result = await this.commitFiles(repository, input, true, signal);
    return { ...result, number: pr.number, url: pr.url };
  }
  private async commitFiles(repository: string, input: GitHubPublishInput, existingOnly: boolean, signal?: AbortSignal): Promise<GitHubPublication> {
    repositoryName(repository);
    const branch = publicationBranch(input.branch), baseBranch = refName(input.baseBranch), expected = input.expectedHeadSha;
    if (!shaSchema.safeParse(expected).success || branch === baseBranch || !Array.isArray(input.files) || !input.files.length || input.files.length > limits.files) throw invalid();
    const files = input.files.map(file => ({ path: githubFilePath(file.path), content: safeText(file.content, limits.file) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // Same variable payload as the shared 128 KiB request schema. The service
    // adds fixed run-owned branch metadata, never another file body.
    if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length || repositoryJsonBytes({ files, message: input.message }) > GITHUB_REQUEST_JSON_MAX_BYTES
      || files.some(file => files.some(other => other !== file && other.path.startsWith(`${file.path}/`)))) throw invalid('파일 중복 또는 전체 전송 크기를 확인해야 합니다.');
    const rawMessage = safeText(input.message, 4000).trim().replace(/\r\n?/g, '\n');
    const messageLines = rawMessage.split('\n'), headline = messageLines.shift() ?? '', messageBody = messageLines.join('\n').trim();
    const message = `${headline}${messageBody ? `\n\n${messageBody}` : ''}`;
    if (!headline || headline.length > 200) throw invalid('커밋 제목은 1~200자여야 합니다.');
    const fingerprint = createHash('sha256').update(JSON.stringify({ repository: repository.toLowerCase(), branch, baseBranch, expected, files, message })).digest('hex');
    const marker = `Agent-Company-Publication: ${fingerprint}`;
    const fullMessage = `${message}\n\n${marker}`;
    const result = (sha: string, unchanged: boolean, replayed: boolean): GitHubPublication => ({ branch, headSha: sha, commitUrl: `https://github.com/${repository}/commit/${sha}`, unchanged, replayed });
    const info = await this.inspect(repository, signal);
    if (branch === info.defaultBranch) throw invalid('기본 브랜치는 직접 변경할 수 없습니다.');
    const original = await this.commit(repository, expected, signal), originalTree = await this.tree(repository, original.tree.sha, signal);
    const entries = new Map(originalTree.map(entry => [entry.path, entry]));
    for (const file of files) {
      const current = entries.get(file.path);
      if (current && (current.type !== 'blob' || current.mode !== '100644')) throw invalid('기존 디렉터리·실행 파일·심볼릭 링크·서브모듈은 덮어쓸 수 없습니다.');
      const parts = file.path.split('/');
      for (let end = 1; end < parts.length; end++) { const parent = entries.get(parts.slice(0, end).join('/')); if (parent && parent.type !== 'tree') throw invalid('일반 디렉터리 아래에만 작성할 수 있습니다.'); }
    }
    const expectedLeaves = new Map(originalTree.filter(entry => entry.type !== 'tree').map(entry => [entry.path, `${entry.type}:${entry.mode}:${entry.sha}`]));
    for (const file of files) expectedLeaves.set(file.path, `blob:100644:${gitBlob(file.content)}`);
    const isReplay = async (head: string) => {
      const current = await this.commit(repository, head, signal);
      if (current.parents.length !== 1 || current.parents[0].sha !== expected || current.message.trimEnd() !== fullMessage) return false;
      const leaves = (await this.tree(repository, current.tree.sha, signal)).filter(entry => entry.type !== 'tree');
      return leaves.length === expectedLeaves.size && leaves.every(entry => expectedLeaves.get(entry.path) === `${entry.type}:${entry.mode}:${entry.sha}`);
    };
    let head = await this.branchHead(repository, branch, signal);
    if (head && head !== expected) { if (await isReplay(head)) return result(head, false, true); throw conflict(); }
    if (!head) {
      if (existingOnly) throw conflict();
      if (await this.branchHead(repository, baseBranch, signal) !== expected) throw conflict();
      try {
        const created = parsed(z.object({ ref: z.string(), object: z.object({ sha: shaSchema, type: z.literal('commit') }) }), await this.json(repository, 'write', '/git/refs', signal, { ref: `refs/heads/${branch}`, sha: expected }));
        if (created.ref !== `refs/heads/${branch}` || created.object.sha !== expected) throw malformed();
        head = expected;
      } catch (error) {
        if (signal?.aborted || !recoverable(error)) throw error;
        head = await this.branchHead(repository, branch, signal);
        if (!head) throw error;
        if (head !== expected) { if (await isReplay(head)) return result(head, false, true); throw conflict(); }
      }
    }
    const changed = files.filter(file => entries.get(file.path)?.sha !== gitBlob(file.content));
    if (!changed.length) return result(expected, true, false);
    // Mutation is one atomic commit+ref transaction, with a server-side CAS.
    // clientMutationId is a correlation key, not a GitHub idempotency guarantee.
    const body = `${messageBody ? `${messageBody}\n\n` : ''}${marker}`;
    try {
      const response = await this.request(repository, 'write', '/graphql', signal, {
        query: 'mutation Publish($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
        variables: { input: { branch: { repositoryNameWithOwner: repository, branchName: branch }, expectedHeadOid: expected, clientMutationId: fingerprint,
          message: { headline, body }, fileChanges: { additions: changed.map(file => ({ path: file.path, contents: Buffer.from(file.content).toString('base64') })) } } },
      });
      const envelope = parsed(z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }), response.value);
      if (envelope.errors?.length) throw new GitHubTransportError('GITHUB_MUTATION', 'GitHub 커밋 생성이 거절됐습니다. HEAD와 연결 권한을 확인해야 합니다.', 409);
      const data = parsed(z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: shaSchema }) }) }), envelope.data);
      const written = data.createCommitOnBranch.commit.oid;
      if (!(await isReplay(written))) throw malformed();
      return result(written, false, false);
    } catch (error) {
      if (signal?.aborted || !recoverable(error)) throw error;
      const current = await this.branchHead(repository, branch, signal);
      if (current && current !== expected && await isReplay(current)) return result(current, false, true);
      if (current !== expected) throw conflict();
      throw error;
    }
  }
  private pullResult(repository: string, value: unknown, existing: boolean): GitHubPullRequest {
    const pr = parsed(prSchema, value);
    if (pr.head.repo?.full_name.toLowerCase() !== repository.toLowerCase() || pr.base.repo?.full_name.toLowerCase() !== repository.toLowerCase()) throw malformed();
    return bridgeResult({ number: pr.number, url: `https://github.com/${repository}/pull/${pr.number}`, head: pr.head.ref, base: pr.base.ref, headSha: pr.head.sha, baseSha: pr.base.sha,
      state: pr.state, existing, title: pr.title, body: pr.body ?? '', ...(pr.merged === undefined ? {} : { merged: pr.merged }) });
  }
  async getPullRequest(repository: string, number: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(number) || number < 1) throw invalid();
    const result = this.pullResult(repository, await this.json(repository, 'read', `/pulls/${number}`, signal), true);
    if (result.number !== number) throw malformed();
    return result;
  }
  async pullRequest(repository: string, input: { head: string; base: string; title: string; body: string }, signal?: AbortSignal): Promise<GitHubPullRequest> {
    const head = publicationBranch(input.head), base = refName(input.base), title = safeText(input.title, 500).trim(), body = safeText(input.body, 30_000);
    if (!title || title.includes('\n') || head === base || repositoryJsonBytes({ title, body }) > GITHUB_REQUEST_JSON_MAX_BYTES) throw invalid('PR 요청 크기 또는 형식이 올바르지 않습니다.');
    const info = await this.inspect(repository, signal);
    if (head === info.defaultBranch) throw invalid('기본 브랜치를 작업 브랜치로 사용할 수 없습니다.');
    const findExisting = async () => {
      const query = new URLSearchParams({ state: 'all', head: `${repository.split('/')[0]}:${head}`, base, per_page: '100' });
      const response = await this.request(repository, 'read', `${repoPath(repository)}/pulls?${query}`, signal);
      const values = parsed(z.array(prSchema).max(100), response.value);
      const found = values.find(pr => pr.head.ref === head && pr.base.ref === base && pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase() && pr.base.repo?.full_name.toLowerCase() === repository.toLowerCase());
      if (found) return this.pullResult(repository, found, true);
      if (response.hasNext) throw new GitHubTransportError('GITHUB_SIZE', 'PR 목록이 완전하지 않아 중복 생성을 중단했습니다.', 413);
      return null;
    };
    const existing = await findExisting(); if (existing) return existing;
    try {
      const created = this.pullResult(repository, await this.json(repository, 'write', '/pulls', signal, { head, base, title, body, maintainer_can_modify: false }), false);
      if (created.head !== head || created.base !== base) throw malformed();
      return created;
    } catch (error) {
      if (signal?.aborted || !recoverable(error)) throw error;
      const recovered = await findExisting(); if (recovered) return recovered;
      throw error;
    }
  }
}
