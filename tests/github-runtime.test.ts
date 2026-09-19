import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createGitHubRuntime, GitHubRuntimeError, type GitHubRuntimeOptions } from '../server/github-runtime.ts';
import type { GitHubOperationInput } from '../server/github-journal.ts';

const repository = 'formnest-studio/studio-site';
const time = Date.parse('2026-09-09T09:00:00Z');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { AGENT_GITHUB_APP_ID: '123', AGENT_GITHUB_INSTALLATION_ID: '456',
  AGENT_GITHUB_PRIVATE_KEY_FILE: join(tmpdir(), 'unit-test-never-read-key.pem'), AGENT_GITHUB_REPOSITORIES: repository };
const operation = (): GitHubOperationInput => ({ key: 'fixture-publish', runId: randomUUID(), agentId: randomUUID(), connectionId: randomUUID(),
  repository, operation: 'publish', fingerprint: 'a'.repeat(64) });
type Request = { url: string; method: string };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-github-runtime-test-'));
  t.after(async () => {
    const target = resolve(directory), part = relative(resolve(tmpdir()), target);
    assert.ok(part && !isAbsolute(part) && !part.startsWith('..') && part.startsWith('ac-github-runtime-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const rootDir = join(directory, 'data'), ownerKey = randomUUID(), calls: Request[] = [];
  let keyReads = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).endsWith('/installation')) return Response.json({ id: 456, app_id: 123, account: { login: 'formnest-studio' }, suspended_at: null });
    if (String(url).endsWith('/access_tokens')) {
      const permissions = JSON.parse(String(init!.body)).permissions;
      return Response.json({ token: 'ghs_RUNTIME_FIXTURE_TOKEN_ONLY', expires_at: new Date(time + 3_600_000).toISOString(),
        repository_selection: 'selected', repositories: [{ full_name: repository, id: 789 }], permissions });
    }
    return Response.json({ id: 789, full_name: repository, default_branch: 'main', private: true });
  };
  const options: GitHubRuntimeOptions = { rootDir, ownerKey, env, authOptions: { fetch, now: () => time,
    readFile: async () => { keyReads++; return Buffer.from(key); } } };
  return { directory, rootDir, ownerKey, options, calls, keyReads: () => keyReads };
}
const anchorPath = (root: string) => join(root, 'github-runtime.json');
const journalPath = (root: string) => join(root, 'github-operations');

test('unconfigured runtime exposes sanitized status without filesystem, key, journal or network activity', async t => {
  const f = await fixture(t);
  const runtime = await createGitHubRuntime({ ...f.options, env: {} });
  const initial = runtime.status();
  assert.equal(initial.configured, false); assert.equal(initial.writable, false); assert.equal(initial.missing.length, 4);
  initial.missing.length = 0; initial.repositories.push('other/injected');
  assert.equal(runtime.status().missing.length, 4); assert.deepEqual(runtime.status().repositories, []);
  await assert.rejects(lstat(f.rootDir), { code: 'ENOENT' });
  await assert.rejects(runtime.transport.inspect(repository));
  await assert.rejects(runtime.journal.execute(operation(), async () => assert.fail('must not execute')), GitHubRuntimeError);
  assert.equal(f.keyReads(), 0); assert.equal(f.calls.length, 0);
});

test('first configured startup initializes installation-owned anchor and journal without opening the private key', async t => {
  const f = await fixture(t), runtime = await createGitHubRuntime(f.options);
  assert.deepEqual(runtime.status(), { configured: true, missing: [], repositories: [repository], writable: true });
  const anchor = JSON.parse(await readFile(anchorPath(f.rootDir), 'utf8'));
  const identity = JSON.parse(await readFile(join(journalPath(f.rootDir), 'identity.json'), 'utf8'));
  assert.deepEqual(anchor, { version: 1, ownerKey: f.ownerKey, journalIdentity: identity.identity, appId: '123', installationId: '456' });
  assert.equal(identity.ownerKey, f.ownerKey);
  assert.deepEqual((await readdir(f.rootDir)).sort(), ['github-operations', 'github-runtime.json']);
  assert.equal(f.keyReads(), 0); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(await readFile(anchorPath(f.rootDir), 'utf8'), /PRIVATE|TOKEN|pem|privateKey/);
});

test('journal receipts survive runtime reopen and simulated workspace-generation changes', async t => {
  const f = await fixture(t), first = await createGitHubRuntime(f.options), input = operation();
  let executions = 0;
  assert.deepEqual(await first.journal.execute(input, async () => { executions++; return { commit: 'b'.repeat(40) }; }), { commit: 'b'.repeat(40) });
  const original = await readFile(anchorPath(f.rootDir), 'utf8');
  await mkdir(join(f.rootDir, 'generations', randomUUID()), { recursive: true });
  const next = await createGitHubRuntime(f.options);
  assert.deepEqual(await next.journal.execute(input, async () => { executions++; return {}; }), { commit: 'b'.repeat(40) });
  assert.equal(executions, 1); assert.equal(await readFile(anchorPath(f.rootDir), 'utf8'), original);
  const { fingerprint: _fingerprint, ...lookup } = input;
  assert.deepEqual(await next.journal.completed(lookup), { commit: 'b'.repeat(40) });
  assert.equal(f.calls.length, 0); assert.equal(f.keyReads(), 0);
});

test('concurrent first setup converges on one journal identity without replacing either anchor', async t => {
  const f = await fixture(t);
  const results = await Promise.all([createGitHubRuntime(f.options), createGitHubRuntime(f.options)]);
  assert.ok(results.every(runtime => runtime.status().writable));
  const input = operation(); let executes = 0;
  await Promise.all(results.map(runtime => runtime.journal.execute(input, async () => { executes++; return { number: 8 }; })));
  assert.equal(executes, 1);
});

test('missing journal or runtime anchor never becomes a fresh initialized connection', async t => {
  for (const absent of ['journal', 'anchor'] as const) {
    const f = await fixture(t); await createGitHubRuntime(f.options);
    const target = absent === 'journal' ? journalPath(f.rootDir) : anchorPath(f.rootDir);
    assert.ok(relative(f.rootDir, target) && !relative(f.rootDir, target).startsWith('..'));
    await rm(target, { recursive: absent === 'journal' });
    await assert.rejects(createGitHubRuntime(f.options), GitHubRuntimeError);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.equal(f.calls.length, 0); assert.equal(f.keyReads(), 0);
  }
});

test('owner, app and installation substitutions fail closed and leave the anchor unchanged', async t => {
  const f = await fixture(t); await createGitHubRuntime(f.options);
  const bytes = await readFile(anchorPath(f.rootDir), 'utf8');
  for (const change of [{ ownerKey: randomUUID() }, { env: { ...env, AGENT_GITHUB_APP_ID: '124' } },
    { env: { ...env, AGENT_GITHUB_INSTALLATION_ID: '457' } }]) {
    await assert.rejects(createGitHubRuntime({ ...f.options, ...change }), GitHubRuntimeError);
    assert.equal(await readFile(anchorPath(f.rootDir), 'utf8'), bytes);
  }
});

test('corrupt or oversized identity documents and symlinked journal directories do not initialize replacements', async t => {
  for (const content of ['PRIVATE_INVALID_JSON', 'null', '{}', 'x'.repeat(4097)]) {
    const f = await fixture(t); await createGitHubRuntime(f.options);
    await writeFile(anchorPath(f.rootDir), content);
    await assert.rejects(createGitHubRuntime(f.options), error => error instanceof GitHubRuntimeError && !String(error).includes(content));
    assert.equal(await readFile(anchorPath(f.rootDir), 'utf8'), content);
  }
  const f = await fixture(t); await mkdir(f.rootDir);
  const target = join(f.directory, 'elsewhere'); await mkdir(target);
  await symlink(target, journalPath(f.rootDir), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createGitHubRuntime(f.options), GitHubRuntimeError);
  assert.deepEqual(await readdir(target), []);
});

test('runtime transport and guarded transport share real auth construction but status never triggers authentication', async t => {
  const f = await fixture(t), runtime = await createGitHubRuntime(f.options);
  for (let i = 0; i < 10; i++) runtime.status();
  assert.equal(f.keyReads(), 0); assert.equal(f.calls.length, 0);
  let guards = 0;
  const inspected = await runtime.transportFor(async () => { guards++; }).inspect(repository);
  assert.deepEqual(inspected, { id: 789, fullName: repository, defaultBranch: 'main', private: true });
  assert.equal(guards, 3); assert.equal(f.calls.length, 3); assert.equal(f.keyReads(), 1);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  assert.doesNotMatch(JSON.stringify(runtime.status()), /TOKEN|PRIVATE|pem/);
  assert.doesNotMatch(JSON.stringify(runtime), /TOKEN|PRIVATE|pem/);
});

test('revocation is rechecked immediately before installation lookup, token issuance and content requests', async t => {
  for (const denyAt of [1, 2, 3]) {
    const f = await fixture(t), runtime = await createGitHubRuntime(f.options);
    let guards = 0;
    const transport = runtime.transportFor(async () => { if (++guards === denyAt) throw new Error('PRIVATE_SCOPE_DENIED'); });
    await assert.rejects(transport.inspect(repository), error => error instanceof Error && !String(error).includes('PRIVATE_SCOPE_DENIED'));
    assert.equal(guards, denyAt); assert.equal(f.calls.length, denyAt - 1);
    assert.equal(runtime.status().writable, true); // One run's grant does not disable other authorized runs.
  }
});

test('per-run transport pins the approved repository ID into token issuance and cannot be redirected by caller mutation', async t => {
  const f = await fixture(t), fetcher = f.options.authOptions!.fetch!;
  const tokenBodies: unknown[] = [];
  f.options.authOptions!.fetch = async (url, init) => {
    if (String(url).endsWith('/access_tokens')) tokenBodies.push(JSON.parse(String(init!.body)));
    return fetcher(url, init);
  };
  const runtime = await createGitHubRuntime(f.options), expected = { repository, id: 789 };
  const transport = runtime.transportFor(async () => undefined, expected);
  expected.repository = 'formnest-studio/other'; expected.id = 790;
  assert.equal((await transport.inspect(repository)).id, 789);
  assert.deepEqual(tokenBodies, [{ repository_ids: [789], permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' } }]);
  const count = f.calls.length;
  await assert.rejects(transport.inspect('formnest-studio/other')); assert.equal(f.calls.length, count);
  assert.throws(() => runtime.transportFor(async () => undefined, { repository, id: -1 }), GitHubRuntimeError);
});

test('a repository recreated under the same name cannot receive a token or content request for the old connection', async t => {
  const f = await fixture(t), fetcher = f.options.authOptions!.fetch!;
  f.options.authOptions!.fetch = async (url, init) => {
    const response = await fetcher(url, init);
    if (!String(url).endsWith('/access_tokens')) return response;
    const body = await response.json(); body.repositories[0].id = 790;
    return Response.json(body);
  };
  const runtime = await createGitHubRuntime(f.options);
  await assert.rejects(runtime.transportFor(async () => undefined, { repository, id: 789 }).inspect(repository));
  assert.equal(f.calls.length, 2);
});

test('cancellation while a dispatch guard waits prevents the network call after the guard completes', async t => {
  const f = await fixture(t), runtime = await createGitHubRuntime(f.options), controller = new AbortController();
  const transport = runtime.transportFor(async () => { controller.abort('PRIVATE_CANCEL'); });
  await assert.rejects(transport.inspect(repository, controller.signal));
  assert.equal(f.calls.length, 0);
});

test('cancellation bounds a stalled content-dispatch guard after successful token issuance', async t => {
  const f = await fixture(t), runtime = await createGitHubRuntime(f.options), controller = new AbortController();
  let guards = 0;
  const transport = runtime.transportFor(async () => {
    if (++guards === 3) {
      setTimeout(() => controller.abort('PRIVATE_CANCEL'), 10);
      await new Promise<void>(() => undefined);
    }
  });
  await assert.rejects(transport.inspect(repository, controller.signal));
  assert.equal(f.calls.length, 2);
});

test('runtime identity damage blocks cached journal results and all dispatch, then readiness remains false', async t => {
  const f = await fixture(t), runtime = await createGitHubRuntime(f.options), input = operation();
  await runtime.journal.execute(input, async () => ({ number: 5 }));
  const saved = await readFile(anchorPath(f.rootDir), 'utf8');
  await writeFile(anchorPath(f.rootDir), saved.replace(f.ownerKey, randomUUID()));
  await assert.rejects(runtime.journal.execute(input, async () => assert.fail('cached result must not execute')), GitHubRuntimeError);
  const { fingerprint: _fingerprint, ...lookup } = input;
  await assert.rejects(runtime.journal.completed(lookup), GitHubRuntimeError);
  assert.equal(runtime.status().writable, false);
  await assert.rejects(runtime.transport.inspect(repository)); assert.equal(f.calls.length, 0);
  await writeFile(anchorPath(f.rootDir), saved);
  assert.equal(runtime.status().writable, false);
  assert.equal((await createGitHubRuntime(f.options)).status().writable, true);
});

test('journal identity loss between auth steps prevents token issuance', async t => {
  const f = await fixture(t);
  const fetcher = f.options.authOptions!.fetch!;
  f.options.authOptions!.fetch = async (url, init) => {
    const response = await fetcher(url, init);
    if (String(url).endsWith('/installation')) await rm(join(journalPath(f.rootDir), 'identity.json'));
    return response;
  };
  const runtime = await createGitHubRuntime(f.options);
  await assert.rejects(runtime.transport.inspect(repository));
  assert.equal(f.calls.length, 1); assert.equal(runtime.status().writable, false);
});
