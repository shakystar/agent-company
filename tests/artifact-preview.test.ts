import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { SharedArtifact } from '../shared/collaboration.ts';
import { safeArtifactPreviewPath } from '../shared/artifact-preview.ts';
import {
  ArtifactPreviewError, PreviewServerManager, artifactPreviewArchive, pinArtifactPreview,
  resolveArtifactPreview, type ArtifactPreviewSource,
} from '../server/artifact-preview.ts';

const now = '2026-09-11T00:00:00.000Z';
function fixture() {
  const scope = { type: 'project' as const, id: randomUUID() };
  const source: ArtifactPreviewSource = { teams: [], projects: [{ id: scope.id }], sharedArtifacts: [] };
  function add(name: string, content: string, mediaType = 'text/plain'): SharedArtifact {
    const artifact: SharedArtifact = { id: randomUUID(), scope, name, content, mediaType,
      version: 1, history: [], authorAgentId: null, createdAt: now, updatedAt: now };
    source.sharedArtifacts.push(artifact); return artifact;
  }
  const home = add('site/index.html', '<!doctype html><script>localStorage.setItem("demo", "ready")</script><a href="demo/index.html">Demo</a>', 'text/html');
  const demo = add('site/demo/index.html', '<script src="app.js"></script><form><button>Save</button></form>', 'text/html');
  const script = add('site/demo/app.js', 'document.querySelector("form").onsubmit = e => { e.preventDefault(); localStorage.setItem("booking", "one"); };', 'text/javascript');
  const readme = add('site/README.md', '한글 전달 문서\n');
  add('site/tests/core.test.cjs', 'throw new Error("Never execute this server-side");', 'text/javascript');
  add('site/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', 'image/svg+xml');
  add('outside.txt', 'Excluded');
  add('site-other/index.html', 'Not this folder');
  return { source, scope, add, home, demo, script, readme,
    pin: () => pinArtifactPreview(source, { scope, prefix: 'site' }) };
}
function status(code: number) {
  return (error: unknown) => error instanceof ArtifactPreviewError && error.statusCode === code;
}
function get(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const call = request(url, { headers, method }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on('error', reject); call.end();
  });
}

test('manifest pins every prefix file and historical version without copying content', () => {
  const f = fixture();
  const manifest = f.pin();
  assert.equal(manifest.entries.length, 6);
  assert.deepEqual(manifest.entrypoints, ['index.html', 'demo/index.html']);
  assert.equal('content' in manifest.entries[0], false);
  assert.equal(manifest.totalBytes, f.source.sharedArtifacts.filter(a => a.name.startsWith('site/')).reduce((sum, a) => sum + Buffer.byteLength(a.content), 0));
  assert.equal(manifest.entries.find(e => e.path === 'tests/core.test.cjs')?.mediaType, 'text/plain; charset=utf-8');
  assert.equal(resolveArtifactPreview(f.source, manifest).files.get('index.html')!.bytes.toString(), f.home.content);
  const before = f.home.content;
  f.home.history.push({ version: 1, content: before, authorAgentId: null, createdAt: now });
  f.home.version = 2; f.home.content = 'Changed latest source';
  assert.equal(resolveArtifactPreview(f.source, manifest).files.get('index.html')!.bytes.toString(), before);
  assert.notEqual(f.pin().sourceHash, manifest.sourceHash);
  const historical = pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site',
    versions: manifest.entries.map(e => ({ artifactId: e.artifactId, version: e.version })) }, [manifest]);
  assert.deepEqual(historical, manifest);
  assert.notEqual(historical, manifest, 'Do not leak mutable persisted object references');
});

test('bundle identity is independent of JSONB property order and root prefix is explicit', () => {
  const f = fixture();
  const pinned = f.pin();
  const reordered = JSON.parse(JSON.stringify(pinned, function (_key, value) {
    return value && !Array.isArray(value) && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse()) : value;
  }));
  assert.equal(resolveArtifactPreview(f.source, reordered).files.size, 6);
  assert.equal(pinArtifactPreview(f.source, { scope: f.scope, prefix: '' }).entries.length, 8);
  f.home.name = 'index.html';
  const all = pinArtifactPreview(f.source, { scope: f.scope, prefix: '' });
  assert.ok(all.entrypoints.includes('index.html'));
});

test('pinning fails closed for stale file selection, cross-scope references, missing versions and invalid scope', () => {
  const f = fixture();
  const refs = f.pin().entries.map(e => ({ artifactId: e.artifactId, version: e.version }));
  assert.throws(() => pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site', versions: refs.slice(1) }), status(409));
  assert.throws(() => pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site', versions: [...refs, refs[0]] }), status(409));
  assert.throws(() => pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site', versions: refs.map(r => ({ ...r, version: 999 })) }), status(409));
  assert.throws(() => pinArtifactPreview(f.source, { scope: { ...f.scope, id: randomUUID() }, prefix: 'site' }), status(404));
  const foreign = f.add('site/foreign.html', 'Private other scope');
  foreign.scope = { type: 'team', id: randomUUID() };
  assert.equal(f.pin().entries.some(e => e.artifactId === foreign.id), false);
  refs[0].artifactId = foreign.id;
  assert.throws(() => pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site', versions: refs }), status(409));
  assert.throws(() => pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site/demo/app.js' }), status(404));
  assert.throws(() => pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site/tests' }), status(400));
});

test('source tampering, reference removal, manifest digest and metadata changes cannot silently substitute content', () => {
  const f = fixture();
  const manifest = f.pin();
  for (const mutate of [
    (copy: typeof manifest) => { copy.sourceHash = '0'.repeat(64); },
    (copy: typeof manifest) => { copy.entries[0].mediaType = 'text/html'; },
    (copy: typeof manifest) => { copy.entrypoints.reverse(); },
    (copy: typeof manifest) => { copy.entries.push(copy.entries[0]); },
    (copy: typeof manifest) => { copy.totalBytes++; },
  ]) {
    const copy = structuredClone(manifest); mutate(copy);
    assert.throws(() => resolveArtifactPreview(f.source, copy), status(409));
  }
  f.script.content += '//changed';
  assert.throws(() => resolveArtifactPreview(f.source, manifest), status(409));
  f.source.sharedArtifacts = f.source.sharedArtifacts.filter(a => a.id !== f.script.id);
  assert.throws(() => resolveArtifactPreview(f.source, manifest), status(409));
});

test('archive paths reject traversal, URL ambiguity, Windows devices and case collisions', () => {
  for (const path of ['../secret', '/index.html', 'a//b', 'a\\b', 'a:b', 'x%2fsecret', 'NUL.txt', 'foo/COM1.js', 'file. ', 'a?b', '.']) {
    assert.equal(safeArtifactPreviewPath(path), false, path);
  }
  for (const path of ['index.html', 'demo/app.js', '문서/사용법.md']) assert.equal(safeArtifactPreviewPath(path), true, path);
  const f = fixture();
  f.add('site/INDEX.html', 'case duplicate');
  assert.throws(f.pin, status(409));
  f.source.sharedArtifacts.pop();
  f.add('site/__agent_company_preview_manifest__.json', '{}');
  assert.throws(f.pin, status(400));
});

test('bundle boundaries limit aggregate bytes and number of files before archive or serving', () => {
  const f = fixture();
  for (let i = 0; i < 195; i++) f.add(`site/file-${i}.txt`, '');
  assert.throws(f.pin, status(413));
  const g = fixture();
  g.home.content = 'x'.repeat(16 * 1024 * 1024);
  assert.throws(g.pin, status(413));
});

test('download is a deterministic complete ZIP with exact source bytes, UTF-8 filenames and manifest', () => {
  const f = fixture();
  f.add('site/한글.txt', '123456789');
  const manifest = f.pin(), first = artifactPreviewArchive(f.source, manifest), second = artifactPreviewArchive(f.source, manifest);
  assert.deepEqual(first, second);
  assert.equal(first.path, `artifacts-${manifest.sourceHash.slice(0, 16)}.zip`);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (first.bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(first.bytes.readUInt16LE(offset + 6), 0x800);
    assert.equal(first.bytes.readUInt16LE(offset + 8), 0);
    const size = first.bytes.readUInt32LE(offset + 18), length = first.bytes.readUInt16LE(offset + 26);
    const name = first.bytes.subarray(offset + 30, offset + 30 + length).toString();
    const bytes = first.bytes.subarray(offset + 30 + length, offset + 30 + length + size);
    if (name === '한글.txt') assert.equal(first.bytes.readUInt32LE(offset + 14), 0xcbf43926, 'CRC32 standard check vector');
    entries.set(name, bytes); offset += 30 + length + size;
  }
  assert.equal(first.bytes.readUInt32LE(offset), 0x02014b50);
  const end = first.bytes.length - 22;
  assert.equal(first.bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(first.bytes.readUInt32LE(end + 16), offset);
  assert.equal(first.bytes.readUInt16LE(end + 10), manifest.entries.length + 1);
  for (const entry of manifest.entries) {
    const content = entries.get(entry.path)!;
    assert.equal(content.length, entry.bytes);
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
  }
  assert.deepEqual(JSON.parse(entries.get('__agent_company_preview_manifest__.json')!.toString()), manifest);
});

test('deferred desktop preview origin must bind before opening and is fixed for the listener lifetime', async t => {
  const f = fixture(); let origins: string[] = [];
  const manager = new PreviewServerManager({ controllerOrigins: () => origins,
    resolve: async pinned => resolveArtifactPreview(f.source, pinned) });
  t.after(() => manager.close());
  await assert.rejects(manager.open(f.pin()), /로컬 제어 서버 출처/);
  origins = ['http://127.0.0.1:23456'];
  const session = await manager.open(f.pin());
  origins = ['https://evil.example'];
  const allowed = await get(session.url, { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe',
    'sec-fetch-mode': 'navigate', referer: 'http://127.0.0.1:23456/' });
  assert.equal(allowed.status, 200);
  assert.match(String(allowed.headers['content-security-policy']), /frame-ancestors http:\/\/127\.0\.0\.1:23456/);
  assert.equal((await get(session.url, { origin: 'http://127.0.0.1:4310' })).status, 403);
  assert.equal((await get(session.url, { origin: 'https://evil.example' })).status, 403);
});

test('real static HTTP serves a fixed bundle at a cookie-isolated origin with no executable backend', async t => {
  const f = fixture(), manifest = f.pin();
  const manager = new PreviewServerManager({ controllerOrigins: ['http://127.0.0.1:4310'],
    resolve: async pinned => resolveArtifactPreview(f.source, pinned) });
  t.after(() => manager.close());
  const session = await manager.open(manifest);
  assert.equal(new URL(session.origin).hostname, '127.0.0.2');
  assert.notEqual(session.origin, 'http://127.0.0.1:4310');
  const response = await get(session.url);
  assert.equal(response.status, 200); assert.equal(response.body.toString(), f.home.content);
  const csp = String(response.headers['content-security-policy']);
  for (const directive of ["default-src 'none'", "connect-src 'self'", "form-action 'none'", "worker-src 'none'", "frame-src 'none'",
    'sandbox allow-scripts allow-same-origin allow-forms', 'frame-ancestors http://127.0.0.1:4310']) assert.ok(csp.includes(directive), directive);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const folder = session.url.slice(0, -'index.html'.length);
  const js = await get(folder + 'demo/app.js', { 'sec-fetch-site': 'same-origin' });
  assert.equal(js.status, 200); assert.equal(js.body.toString(), f.script.content);
  assert.match(String(js.headers['content-type']), /^text\/javascript/);
  const cjs = await get(folder + 'tests/core.test.cjs');
  assert.equal(cjs.status, 200); assert.match(String(cjs.headers['content-type']), /^text\/plain/);
  const head = await get(session.url, {}, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(f.home.content));
  const reopened = await manager.open(manifest, 'demo/index.html');
  assert.equal(reopened.origin, session.origin); assert.equal(reopened.expiresAt, session.expiresAt);
  assert.ok(reopened.url.endsWith('/demo/index.html'));
  assert.equal((await get(reopened.url)).body.toString(), f.demo.content);
});

test('preview HTTP rejects host rebinding, cross-site readers, null origin, writes, workers and escaped paths', async t => {
  const f = fixture(), manager = new PreviewServerManager({ controllerOrigins: ['http://127.0.0.1:4310'],
    resolve: async pinned => resolveArtifactPreview(f.source, pinned) });
  t.after(() => manager.close());
  const session = await manager.open(f.pin());
  for (const headers of [
    { host: 'example.com' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'service-worker': 'script' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', referer: 'http://127.0.0.1:4311/' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', referer: 'http://127.0.0.1:4310/' },
  ] as Record<string, string>[]) assert.equal((await get(session.url, headers)).status, 403, JSON.stringify(headers));
  assert.equal((await get(session.url, {}, 'POST')).status, 403);
  assert.equal((await get(session.url, {}, 'OPTIONS')).status, 403);
  const iframe = await get(session.url, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'iframe', referer: 'http://127.0.0.1:4310/' });
  assert.equal(iframe.status, 200);
  assert.equal((await get(session.origin + '/api/workspace')).status, 404);
  const folder = session.url.slice(0, -'index.html'.length);
  for (const suffix of ['%2e%2e%2fsecrets.txt', '%252e%252e/secret.txt', '%zz', '%2fetc/passwd']) {
    assert.equal((await get(folder + suffix)).status, 400, suffix);
  }
  assert.equal((await get(folder + 'not-in-manifest.html')).status, 404);
});

test('local form event capability keeps every form target and HTTP mutation blocked', async t => {
  const f = fixture(), manager = new PreviewServerManager({ controllerOrigins: ['http://127.0.0.1:4310'],
    resolve: async pinned => resolveArtifactPreview(f.source, pinned) });
  t.after(() => manager.close());
  const manifest = f.pin(), session = await manager.open(manifest, 'demo/index.html');
  const page = await get(session.url);
  const directives = new Map(String(page.headers['content-security-policy']).split(';').map(raw => {
    const [name, ...tokens] = raw.trim().split(/\s+/); return [name, tokens];
  }));
  assert.deepEqual(directives.get('sandbox'), ['allow-scripts', 'allow-same-origin', 'allow-forms']);
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  assert.deepEqual(directives.get('frame-src'), ["'none'"]);
  assert.deepEqual(directives.get('worker-src'), ["'none'"]);
  assert.match(page.body.toString(), /<form>/);
  const script = await get(session.url.replace(/index\.html$/, 'app.js'));
  assert.match(script.body.toString(), /onsubmit.*preventDefault\(\)/);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const denied = await get(session.url, { origin: session.origin, 'sec-fetch-site': 'same-origin' }, method);
    assert.equal(denied.status, 403, method);
  }
  assert.equal(resolveArtifactPreview(f.source, manifest).manifest.sourceHash, manifest.sourceHash);
  // These are policy/HTTP checks. Actual submit-event dispatch and localStorage
  // persistence require the separate browser interaction verification.
});

test('bundles have distinct origins; concurrent reopen reuses only its own session and caps are explicit', async t => {
  const f = fixture(), manager = new PreviewServerManager({ controllerOrigins: ['http://127.0.0.1:4310'], maxSessions: 2,
    resolve: async pinned => resolveArtifactPreview(f.source, pinned) });
  t.after(() => manager.close());
  const first = f.pin(), [one, same] = await Promise.all([manager.open(first), manager.open(first)]);
  assert.equal(one.origin, same.origin);
  const twoManifest = pinArtifactPreview(f.source, { scope: f.scope, prefix: 'site/demo' });
  const two = await manager.open(twoManifest);
  assert.notEqual(one.origin, two.origin);
  const third = pinArtifactPreview(f.source, { scope: f.scope, prefix: '' });
  await assert.rejects(manager.open(third), status(429));
  await assert.rejects(manager.open(first, 'demo/app.js'), status(400));
  await manager.close(first.id);
  await assert.rejects(get(one.url));
  assert.equal((await get(two.url)).status, 200);
  const thirdSession = await manager.open(third);
  assert.equal((await get(thirdSession.url)).status, 200);
});

test('expiry closes the listener and explicit reopening creates a fresh session', async t => {
  const f = fixture(), manager = new PreviewServerManager({ controllerOrigins: ['http://127.0.0.1:4310'], ttlMs: 100,
    resolve: async pinned => resolveArtifactPreview(f.source, pinned) });
  t.after(() => manager.close());
  const manifest = f.pin(), before = await manager.open(manifest);
  await delay(150);
  await assert.rejects(get(before.url));
  const after = await manager.open(manifest);
  assert.notEqual(after.url, before.url); assert.notEqual(after.expiresAt, before.expiresAt);
});

test('every HTTP read revalidates pinned references; resolver errors never leak internal messages', async t => {
  const f = fixture(); let error = false;
  const manager = new PreviewServerManager({ controllerOrigins: ['http://127.0.0.1:4310'],
    resolve: async pinned => { if (error) throw new Error('private-key.pem must never appear'); return resolveArtifactPreview(f.source, pinned); } });
  t.after(() => manager.close());
  const manifest = f.pin(), session = await manager.open(manifest);
  f.home.content += '<script>new latest source</script>';
  assert.equal((await get(session.url)).status, 409);
  error = true;
  const denied = await get(session.url);
  assert.equal(denied.status, 409); assert.equal(denied.body.length, 0);
});

test('controller origin config accepts only exact trusted loopback origins', () => {
  for (const origin of ['https://evil.example', 'http://127.0.0.2:4310', 'http://localhost:4310/path', 'http://user@localhost:4310']) {
    assert.throws(() => new PreviewServerManager({ controllerOrigins: [origin], resolve: async () => { throw new Error(); } }));
  }
});
