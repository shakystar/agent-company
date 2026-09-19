import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitHubAppAuth, GitHubAuthError, readGitHubConfig, type GitHubAuthOptions, type GitHubConfig } from '../server/github-auth.ts';

const now = Date.parse('2026-09-09T09:00:00Z');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
const repository = 'formnest-studio/studio-site';
const keyPath = join(tmpdir(), 'agent-company-unit-test-only', 'ephemeral.pem');
const env = { AGENT_GITHUB_APP_ID: '123', AGENT_GITHUB_INSTALLATION_ID: '456', AGENT_GITHUB_PRIVATE_KEY_FILE: keyPath,
  AGENT_GITHUB_REPOSITORIES: repository };
const config = () => readGitHubConfig(env);
const installation = () => ({ id: 456, app_id: 123, account: { login: 'formnest-studio' }, suspended_at: null });
const issuance = (access = 'read') => ({ token: 'ghs_TEST_ONLY_VARIABLE_LENGTH_TOKEN', expires_at: new Date(now + 3_600_000).toISOString(),
  repository_selection: 'selected', repositories: [{ full_name: repository, id: 789 }], permissions: { contents: access, pull_requests: access, metadata: 'read' } });
type Request = { url: string; init: RequestInit };
function harness(options: GitHubAuthOptions = {}, response?: (request: Request, index: number) => Response | Promise<Response>, settings: GitHubConfig = config()) {
  const requests: Request[] = [];
  let reads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = { url: String(input), init: init! }; requests.push(request);
    if (response) return response(request, requests.length - 1);
    return Response.json(init?.method === 'POST' ? issuance(JSON.parse(String(init.body)).permissions.contents) : installation());
  };
  const auth = new GitHubAppAuth(settings, { fetch, readFile: async path => { assert.equal(path, keyPath); reads++; return pem; }, now: () => now, ...options });
  return { auth, requests, reads: () => reads };
}
async function expectCode(operation: Promise<unknown>, code: string) {
  await assert.rejects(operation, error => error instanceof GitHubAuthError && error.code === code);
}

test('GitHub config is optional, trims and normalizes exact allowlisted repositories without reading secrets', () => {
  const empty = new GitHubAppAuth(readGitHubConfig({}), { readFile: async () => { throw new Error('must not read'); } });
  assert.deepEqual(empty.status(), { configured: false, missing: Object.keys(env), repositories: [] });
  const c = readGitHubConfig({ ...env, AGENT_GITHUB_REPOSITORIES: ' FORMNEST-STUDIO/Studio-Site ,owner/second ' });
  assert.deepEqual(c.repositories, [repository, 'owner/second']);
  const h = harness({}, undefined, c);
  const status = h.auth.status();
  assert.deepEqual(status, { configured: true, missing: [], repositories: [repository, 'owner/second'] });
  status.repositories.push('owner/injected'); c.repositories.push('owner/injected');
  assert.deepEqual(h.auth.status().repositories, [repository, 'owner/second']);
  assert.equal(h.reads(), 0); assert.equal(h.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(h.auth), /123|456|pem|PRIVATE|TEST_ONLY/);
  assert.doesNotMatch(JSON.stringify(status), /privateKey|pem|PRIVATE|TEST_ONLY/);
});

test('GitHub config rejects malformed IDs, repository URL/path injection, duplicate scope and unsafe key locations', () => {
  for (const id of ['0', '-1', '1.2', '1e3', '9007199254740992', '123/evil'])
    assert.throws(() => readGitHubConfig({ ...env, AGENT_GITHUB_APP_ID: id }), GitHubAuthError);
  for (const repo of ['https://github.com/owner/repo', 'owner/../repo', 'owner/repo?x=1', 'owner/repo#x', 'owner/repo,', 'owner/.',
    'owner/..', 'owner/repo.git', 'owner/repo.GIT', 'owner/repo\\evil', 'owner/repo,OWNER/REPO'])
    assert.throws(() => readGitHubConfig({ ...env, AGENT_GITHUB_REPOSITORIES: repo }), GitHubAuthError);
  for (const path of ['relative.pem', join(process.cwd(), 'key.pem'), join(process.cwd(), '.data', 'key.pem')])
    assert.throws(() => readGitHubConfig({ ...env, AGENT_GITHUB_PRIVATE_KEY_FILE: path }), GitHubAuthError);
  assert.throws(() => readGitHubConfig({ ...env, AGENT_DATA_DIR: tmpdir() }), GitHubAuthError);
  assert.throws(() => readGitHubConfig({ ...env, AGENT_BACKUP_DIR: tmpdir() }), GitHubAuthError);
  assert.throws(() => readGitHubConfig(env, { forbiddenRoots: [tmpdir()] }), GitHubAuthError);
  if (process.platform === 'win32') for (const path of ['\\\\server\\share\\key.pem', 'C:\\keys\\key.pem:stream', '\\\\?\\C:\\key.pem'])
    assert.throws(() => readGitHubConfig({ ...env, AGENT_GITHUB_PRIVATE_KEY_FILE: path }), GitHubAuthError);
});

test('missing configuration, unlisted repositories and invalid access do not read a key or call GitHub', async () => {
  const missing = harness({}, undefined, readGitHubConfig({}));
  await expectCode(missing.auth.token(repository, 'read'), 'GITHUB_NOT_CONFIGURED');
  const h = harness();
  await expectCode(h.auth.token('formnest-studio/another-repo', 'write'), 'GITHUB_SCOPE_INVALID');
  await expectCode(h.auth.token(repository, 'admin' as 'read'), 'GITHUB_SCOPE_INVALID');
  assert.equal(h.reads() + missing.reads(), 0); assert.equal(h.requests.length + missing.requests.length, 0);
});

test('read and write tokens use RS256 JWT and pinned API requests with explicit single-repository narrowed permissions', async () => {
  for (const access of ['read', 'write'] as const) {
    const h = harness();
    assert.equal(await h.auth.token(repository, access), issuance().token);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].url, `https://api.github.com/repos/${repository}/installation`);
    assert.equal(h.requests[1].url, 'https://api.github.com/app/installations/456/access_tokens');
    assert.deepEqual(JSON.parse(String(h.requests[1].init.body)), { repositories: ['studio-site'],
      permissions: { contents: access, pull_requests: access, metadata: 'read' } });
    for (const request of h.requests) {
      assert.equal(request.init.redirect, 'error'); assert.ok(request.init.signal instanceof AbortSignal);
      const headers = new Headers(request.init.headers);
      assert.equal(headers.get('X-GitHub-Api-Version'), '2026-03-10');
      const [header, payload, signature] = headers.get('Authorization')!.slice('Bearer '.length).split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
      assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123' });
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    }
  }
});

test('installation owner, app, ID, suspension and malformed account mismatches never issue a token', async () => {
  for (const bad of [{ ...installation(), id: 457 }, { ...installation(), app_id: 124 }, { ...installation(), account: { login: 'other-owner' } },
    { ...installation(), suspended_at: '2026-09-09' }, { ...installation(), account: null }]) {
    const h = harness({}, () => Response.json(bad));
    await expectCode(h.auth.token(repository, 'read'), 'GITHUB_SCOPE_INVALID');
    assert.equal(h.requests.length, 1);
  }
});

test('known repository IDs replace name scoping and are verified against the issued token', async () => {
  const h = harness();
  assert.equal(await h.auth.token(repository, 'write', undefined, 789), issuance().token);
  assert.deepEqual(JSON.parse(String(h.requests[1].init.body)), { repository_ids: [789],
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
  for (const mismatch of [{ full_name: repository, id: 790 }, { full_name: 'formnest-studio/renamed-site', id: 789 }, { full_name: repository }]) {
    const invalid = harness({}, (_request, index) => Response.json(index === 0 ? installation() : { ...issuance(), repositories: [mismatch] }));
    await expectCode(invalid.auth.token(repository, 'read', undefined, 789), 'GITHUB_SCOPE_INVALID');
  }
  for (const id of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = harness(); await expectCode(invalid.auth.token(repository, 'read', undefined, id), 'GITHUB_SCOPE_INVALID');
    assert.equal(invalid.reads(), 0); assert.equal(invalid.requests.length, 0);
  }
});

test('issued tokens with broader or different permissions, repositories or invalid lifetime are never returned', async () => {
  for (const bad of [
    { ...issuance(), permissions: { ...issuance().permissions, administration: 'write' } },
    { ...issuance(), permissions: { ...issuance().permissions, contents: 'write' } },
    { ...issuance(), permissions: { contents: 'read' } },
    { ...issuance(), repository_selection: 'all' },
    { ...issuance(), repositories: [] }, { ...issuance(), repositories: [{ full_name: 'formnest-studio/wrong' }] },
    { ...issuance(), repositories: [...issuance().repositories, { full_name: 'owner/other' }] },
    { ...issuance(), expires_at: 'invalid' }, { ...issuance(), expires_at: new Date(now - 1).toISOString() },
    { ...issuance(), expires_at: new Date(now + 7_200_000).toISOString() },
    { ...issuance(), token: '' }, { ...issuance(), token: 'secret\r\nheader' }, { ...issuance(), token: 'x'.repeat(32769) },
  ]) {
    const h = harness({}, (_request, index) => Response.json(index === 0 ? installation() : bad));
    await expectCode(h.auth.token(repository, 'read'), 'GITHUB_SCOPE_INVALID');
  }
});

test('authentication failures never leak response bodies, file paths, PEM data, tokens or abort reasons', async () => {
  const privateText = 'VERY_PRIVATE_ERROR_WITH_TOKEN_AND_PATH';
  const cases = [
    harness({ readFile: async () => { throw new Error(privateText); } }),
    harness({ readFile: async () => Buffer.from(privateText) }),
    harness({ fetch: async () => { throw new Error(privateText); } }),
    harness({}, () => new Response(privateText, { status: 401 })),
    harness({}, () => new Response(privateText)),
  ];
  const controller = new AbortController(); controller.abort(new Error(privateText));
  for (const [index, h] of [...cases, harness()].entries()) {
    try { await h.auth.token(repository, 'read', index === cases.length ? controller.signal : undefined); assert.fail('expected error'); }
    catch (error) {
      assert.ok(error instanceof GitHubAuthError); assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /VERY_PRIVATE|ephemeral.pem|BEGIN|ghs_/);
      assert.doesNotMatch(JSON.stringify(error), /VERY_PRIVATE|ephemeral.pem|BEGIN|ghs_/);
    }
  }
});

test('pre-aborted and timed out requests stop without unbounded fetch or body reads', async () => {
  const controller = new AbortController(); controller.abort('PRIVATE_ABORT_REASON');
  const h = harness(); await expectCode(h.auth.token(repository, 'read', controller.signal), 'GITHUB_ABORTED');
  assert.equal(h.reads(), 0); assert.equal(h.requests.length, 0);
  const slow = harness({ timeoutMs: 10, fetch: async () => new Promise(resolveResult => setTimeout(() => resolveResult(Response.json(installation())), 50)) });
  await expectCode(slow.auth.token(repository, 'read'), 'GITHUB_ABORTED');
  const pending = new ReadableStream<Uint8Array>({ start() {}, cancel() {} });
  const body = harness({ timeoutMs: 10 }, () => new Response(pending));
  const keepAlive = setTimeout(() => undefined, 100);
  try { await expectCode(body.auth.token(repository, 'read'), 'GITHUB_ABORTED'); } finally { clearTimeout(keepAlive); }
});

test('redirects, excessive response bodies and invalid JSON are rejected without exposing their content', async () => {
  const redirected = Response.json(installation()); Object.defineProperty(redirected, 'redirected', { value: true });
  const differentOrigin = Response.json(installation()); Object.defineProperty(differentOrigin, 'url', { value: 'https://attacker.invalid/' });
  for (const response of [redirected, differentOrigin, new Response('x'.repeat(262145)),
    new Response('{}', { headers: { 'Content-Length': '262145' } }), new Response('PRIVATE_BAD_JSON')]) {
    await assert.rejects(harness({}, () => response).auth.token(repository, 'read'), GitHubAuthError);
  }
});

test('invalid, oversized and non-RSA private keys never reach GitHub', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const value of [Buffer.alloc(0), Buffer.alloc(65537), Buffer.from('not a key'), Buffer.from(ec)]) {
    const h = harness({ readFile: async () => value });
    await expectCode(h.auth.token(repository, 'read'), 'GITHUB_KEY_INVALID'); assert.equal(h.requests.length, 0);
  }
});

test('the production key reader accepts an owner-only temporary key and rejects directories, oversized files and hardlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-github-auth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'test-key.pem'); await writeFile(file, pem, { mode: 0o600 });
  const reader = (path: string) => {
    const c = readGitHubConfig({ ...env, AGENT_GITHUB_PRIVATE_KEY_FILE: path });
    return harness({ readFile: undefined }, undefined, c);
  };
  assert.equal(await reader(file).auth.token(repository, 'read'), issuance().token);
  await expectCode(reader(directory).auth.token(repository, 'read'), 'GITHUB_KEY_INVALID');
  const oversized = join(directory, 'oversized.pem'); await writeFile(oversized, Buffer.alloc(65537), { mode: 0o600 });
  await expectCode(reader(oversized).auth.token(repository, 'read'), 'GITHUB_KEY_INVALID');
  const hardlink = join(directory, 'hardlink.pem'); await link(file, hardlink);
  await expectCode(reader(hardlink).auth.token(repository, 'read'), 'GITHUB_KEY_INVALID');
  if (process.platform !== 'win32') {
    const shared = join(directory, 'shared.pem'); await writeFile(shared, pem); await chmod(shared, 0o644);
    await expectCode(reader(shared).auth.token(repository, 'read'), 'GITHUB_KEY_INVALID');
  }
});

test('canonical private-key paths cannot cross into configured managed data through a parent symlink', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-github-auth-link-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const protectedRoot = join(directory, 'managed'); await mkdir(protectedRoot);
  const file = join(protectedRoot, 'test-key.pem'); await writeFile(file, pem, { mode: 0o600 });
  const alias = join(directory, 'alias'); await symlink(protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const c = readGitHubConfig({ ...env, AGENT_GITHUB_PRIVATE_KEY_FILE: join(alias, 'test-key.pem'), AGENT_DATA_DIR: protectedRoot });
  const h = harness({ readFile: undefined }, undefined, c);
  await expectCode(h.auth.token(repository, 'read'), 'GITHUB_CONFIG_INVALID'); assert.equal(h.requests.length, 0);
  assert.equal(resolve(protectedRoot), protectedRoot);
});

test('managed data aliases are resolved before checking a real private-key location', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-github-auth-managed-link-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = join(directory, 'managed'); await mkdir(managed);
  const file = join(managed, 'test-key.pem'); await writeFile(file, pem, { mode: 0o600 });
  const alias = join(directory, 'managed-alias'); await symlink(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const c = readGitHubConfig({ ...env, AGENT_GITHUB_PRIVATE_KEY_FILE: file, AGENT_DATA_DIR: alias });
  const h = harness({ readFile: undefined }, undefined, c);
  await expectCode(h.auth.token(repository, 'read'), 'GITHUB_CONFIG_INVALID'); assert.equal(h.requests.length, 0);
});
