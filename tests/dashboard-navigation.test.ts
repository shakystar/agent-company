import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from '../server/app.ts';
import type { RuntimeDriver } from '../shared/types.ts';

const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const html = '<!doctype html><title>Dashboard navigation fixture</title>';

test('only exact top-level dashboard GET navigation is exempt from cross-site rejection', async t => {
  let executions = 0;
  const runtime: RuntimeDriver = {
    async inspect() { return { mode: 'docker', available: false, authenticated: false, image: 'fixture', model: 'fixture', version: null, message: '' }; },
    async execute() { executions++; throw new Error('Navigation must never execute a model'); },
  };
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-navigation-'));
  const app = await createApp({ runtime });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'index.html'), html);
  await app.register(fastifyStatic, { root: directory });
  // Route-level Vary values must survive the root security hook.
  app.get('/index.html', async (_request, reply) => reply.header('Vary', 'Accept-Encoding, sec-fetch-site').sendFile('index.html'));
  app.head('/', async (_request, reply) => reply.header('Vary', '*').send());
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  const before = (await app.inject('/api/workspace')).json();
  const vary = (value: unknown) => String(value).split(',').map(item => item.trim().toLowerCase());
  const required = ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

  await t.test('HTML 200 and conditional 304 retain metadata Vary and frame protection', async () => {
    for (const url of ['/', '/index.html']) {
      const opened = await app.inject({ url, headers: navigation });
      assert.equal(opened.statusCode, 200, opened.body);
      assert.equal(opened.body, html);
      assert.match(String(opened.headers['content-type']), /^text\/html/);
      const cached = await app.inject({ url, headers: { ...navigation, 'if-none-match': String(opened.headers.etag) } });
      assert.equal(cached.statusCode, 304);
      assert.equal(cached.body, '');
      for (const response of [opened, cached]) {
        assert.equal(response.headers['x-frame-options'], 'DENY');
        assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
        const values = vary(response.headers.vary);
        assert.ok(required.every(header => values.includes(header)));
        assert.equal(values.length, new Set(values).size);
        if (url === '/index.html') assert.ok(values.includes('accept-encoding'));
      }
    }
  });

  await t.test('missing or non-navigation metadata and embedded documents stay blocked', async () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { ...navigation, 'sec-fetch-mode': '' },
      { ...navigation, 'sec-fetch-mode': 'cors' },
      { ...navigation, 'sec-fetch-mode': 'Navigate' },
      { ...navigation, 'sec-fetch-dest': '' },
      { ...navigation, 'sec-fetch-dest': 'iframe' },
      { ...navigation, 'sec-fetch-dest': 'image' },
      { ...navigation, 'sec-fetch-dest': 'document, iframe' },
      { 'sec-fetch-site': 'cross-site', 'x-browser-agent': 'anything', 'user-agent': 'Chrome' },
    ]) {
      const response = await app.inject({ url: '/', headers });
      assert.equal(response.statusCode, 403);
      assert.ok(required.every(header => vary(response.headers.vary).includes(header)));
    }
  });

  await t.test('APIs, methods, query strings, and alternate paths cannot borrow the exception', async () => {
    for (const url of ['/api/workspace', '/api/health', '/api/agents', '/assets/app.js', '/other', '/?a=1',
      '/index.html?a=1', '//', '/%69ndex.html', '/index%2ehtml', '/INDEX.HTML', '/index.html/']) {
      const response = await app.inject({ url, headers: navigation });
      assert.equal(response.statusCode, 403, url);
    }
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS', 'HEAD'] as const) {
      for (const url of ['/', '/index.html', '/api/agents']) {
        assert.equal((await app.inject({ method, url, headers: navigation })).statusCode, 403, `${method} ${url}`);
      }
    }
  });

  await t.test('Host and Origin checks run before the navigation exception', async () => {
    for (const host of ['attacker.test', '127.0.0.1.attacker.test', '0.0.0.0']) {
      assert.equal((await app.inject({ url: '/', headers: { ...navigation, host } })).statusCode, 403);
    }
    for (const origin of ['https://attacker.test', 'null']) {
      assert.equal((await app.inject({ url: '/', headers: { ...navigation, origin } })).statusCode, 403);
    }
    for (const headers of [{}, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-origin' },
      { ...navigation, host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' }]) {
      assert.equal((await app.inject({ url: '/', headers })).statusCode, 200);
    }
    assert.equal((await app.inject({ method: 'HEAD', url: '/' })).headers.vary, '*');
  });

  const after = (await app.inject('/api/workspace')).json();
  for (const field of ['agents', 'runs', 'snapshots', 'sharedArtifacts', 'artifactPreviews', 'conversations', 'approvals']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal(executions, 0);
});
