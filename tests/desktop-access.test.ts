import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { createApp } from '../server/app.ts';
import { createDesktopAccess } from '../server/desktop-access.ts';
import type { RuntimeDriver } from '../shared/types.ts';

const token = randomBytes(32).toString('base64url');
const cookieName = `ac_desktop_${randomBytes(16).toString('hex')}`;
const origin = 'http://127.0.0.1:46381', host = '127.0.0.1:46381';
const authorization = `Bearer ${token}`, cookie = `${cookieName}=${token}`;
const rejected = (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 403 && !error.message.includes(token);

function request(headers: Record<string, string | string[] | undefined> = {}, extraRaw: string[] = []): FastifyRequest {
  return { headers, raw: { rawHeaders: [...Object.entries(headers).flatMap(([key, value]) =>
    (value === undefined ? [] : Array.isArray(value) ? value : [value]).flatMap(item => [key, item])), ...extraRaw] } } as unknown as FastifyRequest;
}

test('desktop credentials require a canonical 32-byte token and a per-launch cookie name without exposing either', () => {
  const access = createDesktopAccess({ token, cookieName, origin: () => origin });
  assert.deepEqual(Object.keys(access), ['assert']);
  assert.equal(JSON.stringify(access), '{}');
  for (const invalid of ['', 'short', `${token}=`, 'a'.repeat(43), '*'.repeat(43)]) {
    assert.throws(() => createDesktopAccess({ token: invalid, cookieName, origin: () => origin }), TypeError);
  }
  for (const invalid of ['session', 'ac_desktop_', `${cookieName};other=value`, cookieName.toUpperCase()]) {
    assert.throws(() => createDesktopAccess({ token, cookieName: invalid, origin: () => origin }), TypeError);
  }
});

test('desktop access follows the bound origin and accepts one Bearer or cookie credential, including origin-less navigation', () => {
  let currentOrigin: string | undefined;
  const access = createDesktopAccess({ token, cookieName, origin: () => currentOrigin });
  assert.throws(() => access.assert(request({ host, authorization })), rejected);
  currentOrigin = origin;
  for (const headers of [
    { host, authorization }, { host, authorization, origin },
    { host, cookie }, { host, cookie: `other=opaque; ${cookie}; third=value`, origin, 'sec-fetch-site': 'same-origin' },
    { host, cookie, 'sec-fetch-site': 'none' },
  ]) assert.doesNotThrow(() => access.assert(request(headers)));
  currentOrigin = 'http://127.0.0.1:46382';
  assert.throws(() => access.assert(request({ host, authorization })), rejected);
  assert.doesNotThrow(() => access.assert(request({ host: '127.0.0.1:46382', authorization })));
  currentOrigin = undefined;
  assert.throws(() => access.assert(request({ host, cookie })), rejected);
});

test('desktop origin and Host checks reject alternate loopback names, dev origins and cross-site document exceptions', () => {
  const access = createDesktopAccess({ token, cookieName, origin: () => origin });
  for (const invalidHost of ['', 'localhost:46381', '127.0.0.1', '127.0.0.1:46382', '127.0.0.1:046381', '[::1]:46381', '127.0.0.1.attacker.test:46381']) {
    assert.throws(() => access.assert(request({ host: invalidHost, authorization })), rejected);
  }
  for (const invalidOrigin of ['', 'null', 'https://127.0.0.1:46381', 'http://localhost:46381', 'http://127.0.0.1:5173', `${origin}/`, `${origin}, ${origin}`]) {
    assert.throws(() => access.assert(request({ host, authorization, origin: invalidOrigin })), rejected);
  }
  for (const fetchSite of ['cross-site', 'same-site', 'same-origin, cross-site', 'unknown']) {
    assert.throws(() => access.assert(request({ host, cookie, 'sec-fetch-site': fetchSite,
      'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })), rejected);
  }
  for (const invalidOrigin of ['https://127.0.0.1:46381', 'http://localhost:46381', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:046381', `${origin}/`]) {
    const invalid = createDesktopAccess({ token, cookieName, origin: () => invalidOrigin });
    assert.throws(() => invalid.assert(request({ host, authorization })), rejected);
  }
  const unavailable = createDesktopAccess({ token, cookieName, origin: () => { throw new Error(token); } });
  assert.throws(() => unavailable.assert(request({ host, authorization })), rejected);
});

test('desktop authentication rejects wrong, malformed, duplicate and conflicting credentials before normalized header ambiguity', () => {
  const access = createDesktopAccess({ token, cookieName, origin: () => origin });
  for (const headers of [
    { host }, { host, authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
    { host, authorization: `Basic ${token}` }, { host, authorization: `Bearer  ${token}` },
    { host, authorization: `Bearer ${token}, Bearer ${token}` }, { host, authorization: `Bearer ${token} ` },
    { host, cookie: `${cookieName}="${token}"` }, { host, cookie: `${cookieName}=wrong` },
    { host, cookie: `other=${token}` }, { host, cookie: `${cookie}; ${cookie}` },
    { host, cookie: `${cookie}; other=a; other=b` }, { host, cookie: `${cookie}; malformed` },
    { host, authorization, cookie }, { host, authorization, cookie: `${cookieName}=wrong` },
    { host, authorization: [authorization, authorization] }, { host, cookie: [cookie, cookie] },
  ]) assert.throws(() => access.assert(request(headers)), rejected);
  for (const [name, value] of [['Authorization', authorization], ['Cookie', cookie], ['Host', host], ['Origin', origin]]) {
    const headers = { host, authorization, ...(name === 'Cookie' ? { cookie } : {}), ...(name === 'Origin' ? { origin } : {}) };
    assert.throws(() => access.assert(request(headers, [name, value])), rejected);
  }
  const normalizedMismatch = request({ host, authorization });
  normalizedMismatch.raw.rawHeaders[3] = `Bearer ${randomBytes(32).toString('base64url')}`;
  assert.throws(() => access.assert(normalizedMismatch), rejected);
});

test('real HTTP parsing cannot hide duplicate Authorization, Cookie, Host or Origin from the desktop guard', async t => {
  let boundOrigin: string | undefined;
  const access = createDesktopAccess({ token, cookieName, origin: () => boundOrigin });
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async request => { access.assert(request); });
  app.get('/api/health', async () => ({ status: 'ok' }));
  t.after(() => app.close());
  boundOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  const address = new URL(boundOrigin), boundHost = address.host;
  const send = (rawHeaders: string[]) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/api/health', headers: rawHeaders }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body })); response.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.setTimeout(2000, () => outgoing.destroy(new Error('Isolated HTTP fixture timed out'))); outgoing.end();
  });
  for (const credential of [['Authorization', authorization], ['Cookie', cookie]]) {
    assert.equal((await send(['Host', boundHost, ...credential])).status, 200);
  }
  for (const rawHeaders of [
    ['Host', boundHost, 'Authorization', authorization, 'authorization', authorization],
    ['Host', boundHost, 'Authorization', 'Bearer wrong', 'Authorization', authorization],
    ['Host', boundHost, 'Cookie', cookie, 'cookie', cookie],
    ['Host', boundHost, 'Cookie', cookie, 'Cookie', 'unrelated=value'],
    ['Host', boundHost, 'host', boundHost, 'Authorization', authorization],
    ['Host', boundHost, 'Origin', boundOrigin, 'origin', boundOrigin, 'Authorization', authorization],
    ['Host', boundHost, 'Authorization', authorization, 'Cookie', cookie],
  ]) {
    const response = await send(rawHeaders);
    assert.equal(response.status, 403); assert.equal(response.body.includes(token), false);
  }
});

test('desktop guard covers actual static registration, health, file/image/download routes and API mutations', async t => {
  let executions = 0, boundOrigin: string | undefined;
  const diagnostics: unknown[] = [];
  const runtime: RuntimeDriver = {
    async inspect() { return { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: '' }; },
    async execute() { executions++; throw new Error('Desktop access tests must not execute models'); },
  };
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-desktop-access-'));
  const app = await createApp({ runtime, allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
    desktopAccess: createDesktopAccess({ token, cookieName, origin: () => boundOrigin }),
    dashboardResponseDiagnostics: { write: record => { diagnostics.push(record); } } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, 'assets'));
  const html = '<!doctype html><title>Private desktop fixture</title>';
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(join(directory, 'assets', 'app.js'), 'window.desktopFixture = true;');
  await writeFile(join(directory, 'assets', 'image.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await writeFile(join(directory, 'download.txt'), 'private download fixture');
  await app.register(fastifyStatic, { root: directory, maxAge: '1y' });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  const headers = { host, cookie }, id = '09000000-0000-4000-8000-000000000001';
  const privatePaths = ['/', '/index.html', '/assets/app.js', '/assets/image.png', '/download.txt', '/unknown-client-page',
    '/api/health', '/api/workspace', `/api/files/${id}/download`, `/api/browser/captures/${id}/image`,
    `/api/browser/captures/${id}/download`, `/api/artifact-previews/${id}/download`, `/api/agents/${id}/files/download?path=file.txt`];
  for (const url of privatePaths) {
    const unavailable = await app.inject({ url, headers });
    assert.equal(unavailable.statusCode, 403, `unbound ${url}`);
  }
  boundOrigin = origin;
  const before = (await app.inject({ url: '/api/workspace', headers })).json();
  for (const url of privatePaths) {
    for (const method of ['GET', 'HEAD'] as const) {
      const denied = await app.inject({ method, url, headers: { host } });
      assert.equal(denied.statusCode, 403, `${method} ${url}`);
      assert.equal(denied.headers['cache-control'], 'no-store');
      assert.equal(denied.headers['referrer-policy'], 'no-referrer');
      assert.equal(denied.headers['set-cookie'], undefined);
      assert.equal(denied.body.includes(token), false);
    }
  }
  for (const url of ['/', '/assets/app.js', '/api/health', `/api/browser/captures/${id}/image`]) {
    for (const extra of [{ origin: 'http://127.0.0.1:5173' }, { origin: 'http://localhost:5173' },
      { host: 'localhost:46381' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }]) {
      assert.equal((await app.inject({ url, headers: { ...headers, ...extra } })).statusCode, 403);
    }
  }
  for (const url of ['/', '/index.html', '/assets/app.js', '/assets/image.png', '/download.txt', '/api/health', '/unknown-client-page']) {
    const opened = await app.inject({ url, headers });
    assert.equal(opened.statusCode, 200, `${url}: ${opened.body}`);
    assert.equal(opened.headers['cache-control'], 'no-store', 'static caching cannot override desktop policy');
    assert.equal(opened.headers['referrer-policy'], 'no-referrer');
    assert.equal(opened.headers['x-frame-options'], 'DENY');
    assert.match(String(opened.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(opened.headers['set-cookie'], undefined); assert.equal(opened.body.includes(token), false);
  }
  assert.equal((await app.inject({ url: '/api/health', headers: { host, authorization } })).statusCode, 200);
  for (const url of [`/api/health?token=${token}`, `/?token=${token}`, '/api/desktop/exchange']) {
    const denied = await app.inject({ url, headers: { host } });
    assert.equal(denied.statusCode, 403); assert.equal(denied.body.includes(token), false); assert.equal(denied.headers['set-cookie'], undefined);
  }
  for (const attack of [{ host }, { ...headers, origin: 'http://127.0.0.1:5173' }, { ...headers, authorization }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/agents', headers: attack, payload: { name: 'denied', persona: 'no execution' } })).statusCode, 403);
  }
  const after = (await app.inject({ url: '/api/workspace', headers })).json();
  assert.deepEqual(after.agents, before.agents); assert.deepEqual(after.runs, before.runs);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agents', headers: { ...headers, origin }, payload: { name: 'authorized fixture', persona: 'no execution' } })).statusCode, 201);
  assert.equal(JSON.stringify(diagnostics).includes(token), false); assert.equal(JSON.stringify(diagnostics).includes(cookieName), false);
  assert.equal(executions, 0);
});
