import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHubTransport, GitHubTransportError, githubFilePath, type GitHubPublishInput } from '../server/github-transport.ts';
import { GITHUB_REQUEST_JSON_MAX_BYTES, GITHUB_RESULT_ENCODED_MAX_BYTES, GITHUB_READ_MAX_BYTES, GITHUB_LIST_MAX_FILES, repositoryJsonBytes, repositoryResultEncodedBytes } from '../shared/repositories.ts';

const repository = 'formnest-studio/studio';
const branch = 'agent-company/run-1/op-1';
const original = 'a'.repeat(40), originalTree = 'b'.repeat(40), published = 'c'.repeat(40), publishedTree = 'd'.repeat(40), other = 'e'.repeat(40);
const blob = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
type Entry = { path: string; type: string; mode: string; sha: string; size?: number };
const entry = (path: string, content: string): Entry => ({ path, type: 'blob', mode: '100644', sha: blob(content), size: Buffer.byteLength(content) });
const defaults: GitHubPublishInput = { branch, baseBranch: 'main', expectedHeadSha: original, files: [{ path: 'index.html', content: '<h1>Formnest</h1>\n' }], message: 'Add site\nDetailed change' };
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
type Call = { url: URL; method: string; body: Record<string, any> | undefined; init: RequestInit };
function harness(intercept?: (call: Call, state: ReturnType<typeof initialState>) => Response | Promise<Response | undefined> | undefined) {
  const state = initialState(), calls: Call[] = [], grants: Array<{ repository: string; access: string }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const call = { url: new URL(String(input)), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) as Record<string, any> : undefined, init };
    calls.push(call);
    const intercepted = await intercept?.(call, state); if (intercepted) return intercepted;
    const path = decodeURIComponent(call.url.pathname).replace(`/repos/${repository}`, '');
    if (path === '' && call.method === 'GET') return json({ id: 1, full_name: repository, default_branch: state.defaultBranch, private: true });
    if (path.startsWith('/git/ref/heads/')) {
      const name = path.slice('/git/ref/heads/'.length), sha = state.heads.get(name);
      return sha ? json({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } }) : json({ message: 'not found' }, 404);
    }
    if (path.startsWith('/git/commits/')) return state.commits.has(path.slice(13)) ? json(state.commits.get(path.slice(13))) : json({}, 404);
    if (path.startsWith('/git/trees/')) return json({ sha: path.slice(11), truncated: state.truncated, tree: state.trees.get(path.slice(11)) });
    if (path.startsWith('/git/blobs/')) { const content = state.contents.get(path.slice(11)); return content === undefined ? json({}, 404) : json({ sha: path.slice(11), size: Buffer.byteLength(content), encoding: 'base64', content: Buffer.from(content).toString('base64') }); }
    if (path === '/git/refs' && call.method === 'POST') {
      const name = call.body!.ref.slice('refs/heads/'.length);
      if (state.heads.has(name)) return json({}, 422);
      state.heads.set(name, call.body!.sha);
      return json({ ref: call.body!.ref, object: { type: 'commit', sha: call.body!.sha } }, 201);
    }
    if (call.url.pathname === '/graphql') {
      const input = call.body!.variables.input;
      if (state.heads.get(input.branch.branchName) !== input.expectedHeadOid) return json({ errors: [{ type: 'STALE_DATA', message: 'sensitive upstream detail' }] });
      const parent = state.commits.get(input.expectedHeadOid)!;
      const entries = new Map(state.trees.get(parent.tree.sha)!.map(item => [item.path, item]));
      for (const file of input.fileChanges.additions) { const content = Buffer.from(file.contents, 'base64').toString(); const item = entry(file.path, content); entries.set(file.path, item); state.contents.set(item.sha, content); }
      const next = state.commits.has(published) ? createHash('sha1').update(JSON.stringify(input)).digest('hex') : published;
      const tree = next === published ? publishedTree : createHash('sha1').update(`tree:${next}`).digest('hex');
      state.trees.set(tree, [...entries.values()]);
      state.commits.set(next, { sha: next, tree: { sha: tree }, parents: [{ sha: input.expectedHeadOid }], message: `${input.message.headline}\n\n${input.message.body}` });
      state.heads.set(input.branch.branchName, next);
      if (state.loseCommitResponse) { state.loseCommitResponse = false; throw new Error('Network lost including TOKEN-PRIVATE'); }
      return json({ data: { createCommitOnBranch: { commit: { oid: next } } } });
    }
    if (path === '/pulls' && call.method === 'GET') return json(state.pulls);
    if (path === '/pulls' && call.method === 'POST') {
      const pr = pull(1); state.pulls.push(pr);
      if (state.losePrResponse) { state.losePrResponse = false; throw new Error('PR written, response lost'); }
      return json(pr, 201);
    }
    if (path === '/pulls/1') { const pr = state.pulls[0] ?? pull(1); return json({ ...pr, head: { ...pr.head, sha: state.heads.get(pr.head.ref) ?? pr.head.sha } }); }
    throw new Error(`Unexpected fixture route: ${call.method} ${path}`);
  };
  const transport = new GitHubTransport({ token: async (repository, access) => { grants.push({ repository, access }); return 'TOKEN-PRIVATE'; }, fetch: fetcher });
  return { transport, state, calls, grants, fetcher };
}
function initialState() {
  const readme = entry('README.md', 'Formnest\n');
  return { defaultBranch: 'main', heads: new Map([['main', original]]),
    commits: new Map([[original, { sha: original, tree: { sha: originalTree }, parents: [] as Array<{ sha: string }>, message: 'Initial' }]]),
    trees: new Map<string, Entry[]>([[originalTree, [readme]]]), contents: new Map([[readme.sha, 'Formnest\n']]),
    pulls: [] as ReturnType<typeof pull>[], truncated: false, loseCommitResponse: false, losePrResponse: false };
}
function pull(number: number, state: 'open' | 'closed' = 'open') {
  return { number, title: 'Site', body: 'Review the site', state, head: { ref: branch, sha: published, repo: { full_name: repository } }, base: { ref: 'main', sha: original, repo: { full_name: repository } } };
}

test('inspect and pinned file reads use only the GitHub API and current scoped credentials', async () => {
  const h = harness();
  assert.deepEqual(await h.transport.inspect(repository), { id: 1, fullName: repository, defaultBranch: 'main', private: true });
  const list = await h.transport.listFiles(repository, 'main');
  assert.equal(list.headSha, original); assert.equal(list.files[0].path, 'README.md'); assert.equal(list.truncated, false);
  const content = await h.transport.readFile(repository, 'README.md', original);
  assert.equal(content.content, 'Formnest\n'); assert.equal(content.headSha, original); assert.equal(content.encoding, 'utf-8');
  for (const call of h.calls) {
    assert.equal(call.url.origin, 'https://api.github.com'); assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal);
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer TOKEN-PRIVATE');
    assert.equal(new Headers(call.init.headers).get('x-github-api-version'), '2026-03-10');
  }
  assert.ok(h.grants.every(grant => grant.repository === repository && grant.access === 'read'));
});

test('rejects unsafe repository, ref, paths, files, and recognizable secrets before publication', async () => {
  for (const path of ['../a', '/a', 'a\\b', 'a//b', 'a/./b', 'a/%2e%2e/b', '.git/config', '.env', 'config/.env.production', '.github/workflows/deploy.yml', '.GitHub/Workflows/test.yml', '.gitmodules', 'credentials.json', 'secrets/key.json', 'a.pem', 'a:stream']) {
    assert.throws(() => githubFilePath(path), GitHubTransportError, path);
    const h = harness(); await assert.rejects(h.transport.publish(repository, { ...defaults, files: [{ path, content: 'x' }] }), GitHubTransportError); assert.equal(h.calls.length, 0);
  }
  for (const repo of ['https://evil.test/repo', '../repo', 'owner/..', 'owner/repo?token=x']) { const h = harness(); await assert.rejects(h.transport.inspect(repo)); assert.equal(h.calls.length, 0); }
  for (const badBranch of ['main', 'feature/a', 'agent-company/../main', 'agent-company/run-1/op.lock']) { const h = harness(); await assert.rejects(h.transport.publish(repository, { ...defaults, branch: badBranch })); assert.equal(h.calls.length, 0); }
  for (const content of ['-----BEGIN PRIVATE KEY-----\nx', `ghp_${'a'.repeat(36)}`, '\0binary', '\ud800', 'x'.repeat(2 * 1024 * 1024 + 1)]) { const h = harness(); await assert.rejects(h.transport.publish(repository, { ...defaults, files: [{ path: 'site.txt', content }] })); assert.equal(h.calls.length, 0); }
  const h = harness(); await assert.rejects(h.transport.publish(repository, { ...defaults, files: [{ path: 'a', content: '1' }, { path: 'a/b', content: '2' }] })); assert.equal(h.calls.length, 0);
});

test('lists omit secret and special entries; reads never follow symlinks or submodules', async () => {
  const h = harness(); h.state.trees.get(originalTree)!.push(entry('.env', 'secret'), { path: 'link', type: 'blob', mode: '120000', sha: other, size: 8 }, { path: 'module', type: 'commit', mode: '160000', sha: other });
  const result = await h.transport.listFiles(repository, original); assert.equal(result.files.length, 1); assert.equal(result.omittedFiles, 3);
  await assert.rejects(h.transport.readFile(repository, 'link', original), /일반 파일/);
  await assert.rejects(h.transport.readFile(repository, 'module', original), /일반 파일/);
  for (const path of ['link', 'module', 'link/file']) await assert.rejects(h.transport.publish(repository, { ...defaults, files: [{ path, content: 'x' }] }));
  assert.equal(h.calls.filter(call => call.method !== 'GET').length, 0);
});

test('publish creates a run branch and atomically commits all additions with expectedHeadOid', async () => {
  const h = harness(); const result = await h.transport.publish(repository, defaults);
  assert.equal(result.headSha, published); assert.equal(result.replayed, false); assert.equal(result.unchanged, false);
  assert.equal(h.state.heads.get('main'), original); assert.equal(h.state.heads.get(branch), published);
  const mutations = h.calls.filter(call => call.method === 'POST'); assert.equal(mutations.length, 2);
  const commit = mutations.find(call => call.url.pathname === '/graphql')!.body!.variables.input;
  assert.equal(commit.expectedHeadOid, original); assert.equal(commit.branch.branchName, branch);
  assert.equal(commit.fileChanges.additions[0].contents, Buffer.from(defaults.files[0].content).toString('base64'));
  assert.equal(commit.fileChanges.deletions, undefined); assert.match(commit.message.body, /Agent-Company-Publication: [a-f0-9]{64}$/);
  assert.ok(h.grants.some(grant => grant.access === 'write'));
  assert.equal(h.calls.some(call => call.method === 'PATCH' || call.method === 'DELETE'), false);
});

test('completed publish retries are recognized without another mutation, including after process recreation', async () => {
  const h = harness(); await h.transport.publish(repository, defaults); const count = h.calls.filter(call => call.method === 'POST').length;
  const restarted = new GitHubTransport({ token: async () => 'TOKEN-PRIVATE', fetch: h.fetcher });
  const result = await restarted.publish(repository, defaults); assert.equal(result.replayed, true); assert.equal(result.headSha, published);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, count);
  await assert.rejects(h.transport.publish(repository, { ...defaults, message: 'Different intent' }), error => error instanceof GitHubTransportError && error.statusCode === 409);
});

test('revision appends on the original PR branch, preserves previous files and never recreates or merges it', async () => {
  const h = harness(); await h.transport.publish(repository, defaults);
  const result = await h.transport.revise(repository, { ...defaults, number: 1, expectedHeadSha: published,
    files: [{ path: 'style.css', content: 'body{color:green}' }], message: 'Improve styles' });
  assert.equal(result.number, 1); assert.equal(result.branch, branch); assert.notEqual(result.headSha, published);
  assert.deepEqual(h.state.commits.get(result.headSha)!.parents, [{ sha: published }]);
  const files = h.state.trees.get(h.state.commits.get(result.headSha)!.tree.sha)!;
  assert.deepEqual(files.map(file => file.path).sort(), ['README.md', 'index.html', 'style.css']);
  assert.equal(h.state.heads.get('main'), original); assert.equal(h.calls.filter(c => c.url.pathname.endsWith('/git/refs')).length, 1);
  assert.equal(h.calls.filter(c => c.method !== 'GET' && c.url.pathname !== '/graphql' && !c.url.pathname.endsWith('/git/refs')).length, 0);
});

test('revision reconciles a lost commit response and retry after transport restart without a duplicate commit', async () => {
  const h = harness(); await h.transport.publish(repository, defaults);
  const args = { ...defaults, number: 1, expectedHeadSha: published, files: [{ path: 'index.html', content: '<h1>Improved</h1>' }], message: 'Improve copy' };
  h.state.loseCommitResponse = true;
  const result = await h.transport.revise(repository, args); assert.equal(result.replayed, true);
  const restarted = new GitHubTransport({ token: async () => 'TOKEN-PRIVATE', fetch: h.fetcher });
  assert.deepEqual(await restarted.revise(repository, args), result);
  assert.equal(h.calls.filter(c => c.url.pathname === '/graphql').length, 2);
});

test('concurrent revisions use branch HEAD CAS so one winner cannot be overwritten by the other', async () => {
  const h = harness(); await h.transport.publish(repository, defaults);
  const changes = ['First', 'Second'].map(content => ({ ...defaults, number: 1, expectedHeadSha: published,
    files: [{ path: 'index.html', content }], message: content }));
  const results = await Promise.allSettled(changes.map(args => h.transport.revise(repository, args)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const success = results.find(result => result.status === 'fulfilled')! as PromiseFulfilledResult<Awaited<ReturnType<GitHubTransport['revise']>>>;
  assert.equal(h.state.heads.get(branch), success.value.headSha); assert.equal(h.state.heads.get('main'), original);
});

test('revision rejects deleted branch, closed or retargeted PR and unsafe files without external mutation', async () => {
  for (const kind of ['deleted', 'closed', 'number', 'base', 'head', 'workflow', 'secret', 'symlink'] as const) {
    const h = harness(); await h.transport.publish(repository, defaults); h.state.pulls.push(pull(1));
    const args = { ...defaults, number: 1, expectedHeadSha: published, message: 'Revise', files: [{ path: 'index.html', content: 'new' }] };
    if (kind === 'deleted') h.state.heads.delete(branch);
    if (kind === 'closed') h.state.pulls[0].state = 'closed';
    if (kind === 'number') h.state.pulls[0].number = 2;
    if (kind === 'base') h.state.pulls[0].base.ref = 'other';
    if (kind === 'head') h.state.pulls[0].head.ref = 'agent-company/other';
    if (kind === 'workflow') args.files[0].path = '.github/workflows/deploy.yml';
    if (kind === 'secret') args.files[0].content = '-----BEGIN PRIVATE KEY-----\nsecret';
    if (kind === 'symlink') h.state.trees.get(publishedTree)!.find(file => file.path === 'index.html')!.mode = '120000';
    const before = h.calls.filter(c => c.method !== 'GET').length;
    await assert.rejects(h.transport.revise(repository, args), GitHubTransportError, kind);
    assert.equal(h.calls.filter(c => c.method !== 'GET').length, before, kind);
  }
});

test('unknown commit response is recovered by exact parent, message and complete leaf tree proof', async () => {
  const h = harness(); h.state.loseCommitResponse = true;
  const result = await h.transport.publish(repository, defaults); assert.equal(result.replayed, true); assert.equal(h.calls.filter(call => call.url.pathname === '/graphql').length, 1);
  h.state.trees.get(publishedTree)!.push(entry('unrequested.txt', 'extra'));
  await assert.rejects(h.transport.publish(repository, defaults), error => error instanceof GitHubTransportError && error.code === 'GITHUB_CONFLICT');
});

test('stale base, existing branch, and race during atomic mutation cannot overwrite another head', async () => {
  const stale = harness(); stale.state.heads.set('main', other);
  await assert.rejects(stale.transport.publish(repository, defaults), /HEAD/); assert.equal(stale.calls.filter(call => call.method === 'POST').length, 0);
  const raced = harness((call, state) => { if (call.url.pathname === '/graphql') { state.heads.set(branch, other); state.commits.set(other, { sha: other, tree: { sha: originalTree }, parents: [{ sha: original }], message: 'Other work' }); } return undefined; });
  await assert.rejects(raced.transport.publish(repository, defaults), /HEAD/); assert.equal(raced.state.heads.get(branch), other);
});

test('branch creation conflict recovers only when the observed ref matches expected head', async () => {
  let intercepted = false;
  const h = harness((call, state) => { if (!intercepted && call.url.pathname.endsWith('/git/refs')) { intercepted = true; state.heads.set(branch, original); return json({}, 422); } });
  assert.equal((await h.transport.publish(repository, defaults)).headSha, published);
});

test('unchanged files do not create empty commits and default branches remain protected', async () => {
  const h = harness(); h.state.heads.set(branch, original);
  assert.equal((await h.transport.publish(repository, { ...defaults, files: [{ path: 'README.md', content: 'Formnest\n' }] })).unchanged, true);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  h.state.defaultBranch = branch;
  await assert.rejects(h.transport.publish(repository, defaults), /기본 브랜치/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});

test('PR creation is idempotent across open, closed, race and response loss', async () => {
  const request = { head: branch, base: 'main', title: 'Site', body: 'Review the site' };
  for (const state of ['open', 'closed'] as const) {
    const h = harness(); h.state.pulls.push(pull(8, state));
    const result = await h.transport.pullRequest(repository, request); assert.equal(result.number, 8); assert.equal(result.existing, true); assert.equal(result.state, state);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  }
  const h = harness(); h.state.losePrResponse = true;
  const result = await h.transport.pullRequest(repository, request); assert.equal(result.existing, true); assert.equal(result.number, 1);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal((await h.transport.getPullRequest(repository, 1)).headSha, published);
});

test('PR duplicate race is recovered and truncated empty lookups cannot create duplicates', async () => {
  const request = { head: branch, base: 'main', title: 'Site', body: '' };
  const h = harness((call, state) => { if (call.url.pathname.endsWith('/pulls') && call.method === 'POST') { state.pulls.push(pull(4)); return json({}, 422); } });
  assert.equal((await h.transport.pullRequest(repository, request)).number, 4);
  const limited = harness(call => call.url.pathname.endsWith('/pulls') ? json([], 200, { link: '<https://api.github.com/ignored>; rel="next"' }) : undefined);
  await assert.rejects(limited.transport.pullRequest(repository, request), /완전하지/); assert.equal(limited.calls.filter(call => call.method === 'POST').length, 0);
});

test('redirects, oversized or malformed responses and upstream token-containing errors are sanitized', async () => {
  for (const response of [() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }), () => json({}, 200, { 'content-length': String(5 * 1024 * 1024) }), () => new Response('not JSON')]) {
    const h = harness(() => response()); await assert.rejects(h.transport.inspect(repository), GitHubTransportError); assert.equal(h.calls.length, 1);
  }
  const rejected = harness(() => json({ token: 'TOKEN-PRIVATE', message: 'TOKEN-PRIVATE' }, 403));
  await assert.rejects(rejected.transport.inspect(repository), error => error instanceof GitHubTransportError && error.httpStatus === 403 && !error.message.includes('TOKEN-PRIVATE'));
  const network = harness(() => { throw new Error('TOKEN-PRIVATE'); });
  await assert.rejects(network.transport.inspect(repository), error => error instanceof GitHubTransportError && !String(error).includes('TOKEN-PRIVATE'));
  const h = harness(); h.state.truncated = true;
  await assert.rejects(h.transport.listFiles(repository, original), /잘려/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.transport.inspect(repository, controller.signal), error => error instanceof GitHubTransportError && error.code === 'GITHUB_ABORTED');
});

test('combined content, file-count, and duplicates remain bounded before any network request', async () => {
  for (const files of [Array.from({ length: 101 }, (_, index) => ({ path: `file-${index}.txt`, content: '' })),
    [{ path: 'one.txt', content: 'x'.repeat(1024 * 1024 + 1) }, { path: 'two.txt', content: 'x'.repeat(1024 * 1024) }],
    [{ path: 'README.md', content: 'one' }, { path: 'readme.md', content: 'two' }]]) {
    const h = harness(); await assert.rejects(h.transport.publish(repository, { ...defaults, files })); assert.equal(h.calls.length, 0);
  }
});

test('blob bytes and hashes are verified, including valid UTF8 BOM preservation', async () => {
  const h = harness(); const content = '\ufeffFormnest\n', file = entry('bom.txt', content);
  h.state.trees.get(originalTree)!.push(file); h.state.contents.set(file.sha, content);
  assert.equal((await h.transport.readFile(repository, file.path, original)).content, content);
  const corrupt = harness(call => call.url.pathname.includes('/git/blobs/') ? json({ sha: blob('Formnest\n'), size: 9, encoding: 'base64', content: Buffer.from('Tampered\n').toString('base64') }) : undefined);
  await assert.rejects(corrupt.transport.readFile(repository, 'README.md', original), /응답 형식/);
});

test('credential-provider failures and GraphQL errors do not surface private details', async () => {
  const provider = new GitHubTransport({ token: async () => { throw new Error('TOKEN-PRIVATE'); }, fetch: async () => { throw new Error('must not execute'); } });
  await assert.rejects(provider.inspect(repository), error => error instanceof GitHubTransportError && !String(error).includes('TOKEN-PRIVATE'));
  const h = harness(call => call.url.pathname === '/graphql' ? json({ errors: [{ message: 'TOKEN-PRIVATE' }], data: null }) : undefined);
  await assert.rejects(h.transport.publish(repository, defaults), error => error instanceof GitHubTransportError && !String(error).includes('TOKEN-PRIVATE'));
  assert.equal(h.state.heads.get(branch), original); assert.equal(h.calls.filter(call => call.url.pathname === '/graphql').length, 1);
});

test('cancellation bounds an unresponsive token provider without issuing an external request', async () => {
  const controller = new AbortController(); let fetched = false;
  const transport = new GitHubTransport({ token: async () => new Promise<string>(() => {}), fetch: async () => { fetched = true; return json({}); } });
  const pending = transport.inspect(repository, controller.signal); controller.abort();
  await assert.rejects(pending, error => error instanceof GitHubTransportError && error.code === 'GITHUB_ABORTED');
  assert.equal(fetched, false);
});

test('publication counts escaped JSON bytes before any mutation rather than only raw text bytes', async () => {
  for (const unit of ['x', '한글🙂', '"\\\n\t\u0001']) {
    const make = (content: string) => ({ files: [{ path: 'site.txt', content }], message: 'Publish site' });
    const available = GITHUB_REQUEST_JSON_MAX_BYTES - repositoryJsonBytes(make(''));
    const perUnit = repositoryJsonBytes(unit) - 2;
    const content = unit.repeat(Math.floor(available / perUnit)) + 'x'.repeat(available % perUnit);
    assert.equal(repositoryJsonBytes(make(content)), GITHUB_REQUEST_JSON_MAX_BYTES);
    const h = harness(); assert.equal((await h.transport.publish(repository, { ...defaults, ...make(content) })).headSha, published);
    const over = harness(); await assert.rejects(over.transport.publish(repository, { ...defaults, ...make(`${content}x`) }), /전체 전송 크기/);
    assert.equal(over.calls.length, 0);
  }
});

test('read results enforce the actual twice-encoded MCP result budget as well as file bytes', async () => {
  const content = '\u0001'.repeat(80_000); assert.ok(Buffer.byteLength(content) < GITHUB_READ_MAX_BYTES);
  const h = harness(); const item = entry('controls.txt', content); h.state.trees.get(originalTree)!.push(item); h.state.contents.set(item.sha, content);
  assert.ok(repositoryResultEncodedBytes({ content }) > GITHUB_RESULT_ENCODED_MAX_BYTES);
  await assert.rejects(h.transport.readFile(repository, item.path, original), /MCP 인코딩/);
  const huge = entry('huge.txt', 'x'.repeat(GITHUB_READ_MAX_BYTES + 1)); h.state.trees.get(originalTree)!.push(huge);
  const before = h.calls.filter(call => call.url.pathname.includes('/git/blobs/')).length;
  await assert.rejects(h.transport.readFile(repository, huge.path, original), /파일 읽기 크기/);
  assert.equal(h.calls.filter(call => call.url.pathname.includes('/git/blobs/')).length, before);
});

test('lists fail closed on either file count or escaped response bytes instead of returning partial success', async () => {
  const h = harness(); h.state.trees.set(originalTree, Array.from({ length: GITHUB_LIST_MAX_FILES }, (_, index) => entry(`file-${index}.txt`, 'x')));
  const listed = await h.transport.listFiles(repository, original); assert.equal(listed.files.length, GITHUB_LIST_MAX_FILES);
  assert.ok(repositoryResultEncodedBytes(listed) < GITHUB_RESULT_ENCODED_MAX_BYTES);
  h.state.trees.get(originalTree)!.push(entry('one-too-many.txt', 'x')); await assert.rejects(h.transport.listFiles(repository, original), /1000개/);
  h.state.trees.set(originalTree, Array.from({ length: 600 }, (_, index) => entry(`${'한"'.repeat(220)}-${index}.txt`, 'x')));
  await assert.rejects(h.transport.listFiles(repository, original), /MCP 인코딩/);
});

test('PR JSON request and full-text response encoding are bounded independently of character count', async () => {
  const h = harness(); await assert.rejects(h.transport.pullRequest(repository, { head: branch, base: 'main', title: 'PR', body: '\u0001'.repeat(30_000) }), /PR 요청 크기/);
  assert.equal(h.calls.length, 0);
  const large = harness(call => call.url.pathname.endsWith('/pulls/1') ? json({ ...pull(1), body: '\u0001'.repeat(80_000) }) : undefined);
  await assert.rejects(large.transport.getPullRequest(repository, 1), /MCP 인코딩/);
});
