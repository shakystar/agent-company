import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { desktopMcpEndpointSchema, publishDesktopMcpEndpoint, readDesktopMcpEndpoint } from '../server/desktop-mcp-endpoint.ts';
import { desktopMcpArguments, desktopMcpRemote } from '../server/desktop-mcp-entry.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-mcp-endpoint-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /ac-mcp-endpoint-[^\\/]+$/); await rm(root, { recursive: true, force: true }); });
  return { root, path: join(root, 'endpoint.json'), endpoint: { version: 1 as const, ownerKey: randomUUID(), epoch: randomUUID(), origin: 'http://127.0.0.1:45678' } };
}

test('endpoint discovery is owner-bound public data and removes only its own published epoch', async t => {
  const f = await fixture(t), release = await publishDesktopMcpEndpoint(f.path, f.endpoint);
  assert.deepEqual(await readDesktopMcpEndpoint(f.path, f.endpoint.ownerKey), f.endpoint);
  await assert.rejects(readDesktopMcpEndpoint(f.path, randomUUID()), /DESKTOP_MCP_ENDPOINT_INVALID/);
  const second = { ...f.endpoint, epoch: randomUUID(), origin: 'http://127.0.0.1:45679' };
  const releaseSecond = await publishDesktopMcpEndpoint(f.path, second);
  await assert.rejects(release(), /DESKTOP_MCP_ENDPOINT_INVALID/);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), second);
  await releaseSecond(); await releaseSecond(); await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('endpoint refuses remote URLs, queries, extra secrets, oversized data, invalid UTF-8, aliases and hard links', async t => {
  const f = await fixture(t);
  for (const origin of ['https://127.0.0.1:4310', 'http://localhost:4310', 'http://127.0.0.1:65536', 'http://127.0.0.1:4310/path', 'http://127.0.0.1:4310?token=x', 'http://example.com:4310']) {
    assert.equal(desktopMcpEndpointSchema.safeParse({ ...f.endpoint, origin }).success, false);
  }
  for (const bytes of [Buffer.from(JSON.stringify({ ...f.endpoint, token: 'PRIVATE' })), Buffer.alloc(4097, 97), Buffer.from([0xc3, 0x28])]) {
    await writeFile(f.path, bytes); await assert.rejects(readDesktopMcpEndpoint(f.path, f.endpoint.ownerKey), /DESKTOP_MCP_ENDPOINT_INVALID/);
    await assert.rejects(publishDesktopMcpEndpoint(f.path, f.endpoint));
  }
  await writeFile(f.path, JSON.stringify(f.endpoint)); await link(f.path, join(f.root, 'alias.json'));
  await assert.rejects(readDesktopMcpEndpoint(f.path, f.endpoint.ownerKey));
  await assert.rejects(readDesktopMcpEndpoint(join(f.root, 'child') + '/../endpoint.json', f.endpoint.ownerKey));
});

test('stdio arguments take the secret only from the environment and never permit arbitrary origins', async t => {
  const f = await fixture(t), token = randomBytes(32).toString('base64url');
  const args = ['--endpoint-file', f.path, '--owner-key', f.endpoint.ownerKey, '--grant-id', randomUUID()];
  assert.equal(desktopMcpArguments(args, token).endpointFile, f.path);
  for (const invalid of [undefined, '', 'x'.repeat(42), 'x'.repeat(43), token + '=']) assert.throws(() => desktopMcpArguments(args, invalid));
  for (const invalid of [[...args, '--token', token], ['--origin', f.endpoint.origin, ...args.slice(2)], args.slice(0, 4)]) assert.throws(() => desktopMcpArguments(invalid, token));
  const remote = desktopMcpRemote(desktopMcpArguments(args, token));
  await assert.rejects(remote('tools/list', {}, new AbortController().signal), /DESKTOP_MCP_ENDPOINT_INVALID/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(remote('tools/list', {}, abort.signal), { name: 'AbortError' });
});
