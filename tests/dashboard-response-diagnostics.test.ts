import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  registerDashboardResponseDiagnostics,
  type DashboardResponseDiagnosticRecord,
} from '../server/dashboard-response-diagnostics.ts';

const html = '<!doctype html><title>Dashboard test</title><p>Private body marker</p>';

async function staticFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-dashboard-diagnostic-'));
  await writeFile(join(directory, 'index.html'), html);
  await utimes(join(directory, 'index.html'), new Date('2026-09-10T00:00:00Z'), new Date('2026-09-10T00:00:00Z'));
  const app = Fastify({ requestIdHeader: 'x-request-id' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const registerStatic = () => app.register(fastifyStatic, { root: directory });
  return { app, registerStatic };
}

function withoutDate(headers: Record<string, unknown>) {
  const { date: _date, ...stable } = headers;
  return stable;
}

test('records actual static 200 and conditional 304 without changing their responses', async t => {
  const baseline = await staticFixture(t);
  await baseline.registerStatic();
  const original = await baseline.app.inject('/');
  const originalConditional = await baseline.app.inject({ url: '/', headers: { 'if-none-match': original.headers.etag! } });

  const fixture = await staticFixture(t);
  const records: DashboardResponseDiagnosticRecord[] = [];
  registerDashboardResponseDiagnostics(fixture.app, { write: record => { records.push(record); } });
  await fixture.registerStatic();
  const response = await fixture.app.inject('/');
  const conditional = await fixture.app.inject({ url: '/', headers: { 'if-none-match': response.headers.etag! } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, original.body);
  assert.deepEqual(withoutDate(response.headers), withoutDate(original.headers));
  assert.equal(conditional.statusCode, originalConditional.statusCode);
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.body, originalConditional.body);
  assert.deepEqual(withoutDate(conditional.headers), withoutDate(originalConditional.headers));
  assert.equal(records.length, 4);
  assert.deepEqual(records.map(record => record.event), ['request', 'response', 'request', 'response']);
  assert.equal(records[0].requestId, records[1].requestId);
  assert.equal(records[2].requestId, records[3].requestId);
  assert.notEqual(records[0].requestId, records[2].requestId);
  assert.ok(records.every(record => Number.isFinite(Date.parse(record.timestamp))));
  assert.deepEqual(records.filter(record => record.event === 'response').map(record => ({
    statusCode: record.statusCode, contentType: record.contentType, outcome: record.outcome,
  })), [
    { statusCode: 200, contentType: response.headers['content-type'], outcome: 'finished' },
    { statusCode: 304, contentType: null, outcome: 'finished' },
  ]);
  assert.deepEqual(records.filter(record => record.event === 'request').map(record => record.hasIfNoneMatch), [false, true]);
  assert.deepEqual(records.filter(record => record.event === 'request').map(record => ({
    secFetchMode: record.secFetchMode, secFetchDest: record.secFetchDest,
  })), [{ secFetchMode: null, secFetchDest: null }, { secFetchMode: null, secFetchDest: null }]);
});

test('logs exact dashboard GET paths only and excludes all sensitive header values and payloads', async t => {
  const fixture = await staticFixture(t);
  const records: DashboardResponseDiagnosticRecord[] = [];
  registerDashboardResponseDiagnostics(fixture.app, { write: record => { records.push(record); } });
  await fixture.registerStatic();
  for (const url of ['/?token=query-secret', '/index.html?token=query-secret', '/api/state', '/other']) {
    await fixture.app.inject(url);
  }
  await fixture.app.inject({ method: 'HEAD', url: '/' });
  await fixture.app.inject({ method: 'POST', url: '/', payload: 'body-secret' });
  assert.equal(records.length, 0);
  await fixture.app.inject({
    url: '/index.html',
    headers: {
      'if-none-match': 'etag-secret', 'if-modified-since': 'date-secret', 'x-browser-agent': 'browser-secret',
      cookie: 'cookie-secret', authorization: 'Bearer auth-secret', 'x-request-id': 'request-id-secret',
      'sec-fetch-site': 'fetch-site-secret',
      'sec-fetch-mode': 'fetch-mode-secret', 'sec-fetch-dest': 'fetch-dest-secret',
    },
  });
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    timestamp: records[0].timestamp, event: 'request', requestId: 'dashboard-1', method: 'GET', path: '/index.html',
    hasIfNoneMatch: true, hasIfModifiedSince: true, hasBrowserAgent: true, secFetchSite: 'other',
    secFetchMode: 'other', secFetchDest: 'other',
  });
  const serialized = JSON.stringify(records);
  for (const secret of ['etag-secret', 'date-secret', 'browser-secret', 'cookie-secret', 'auth-secret', 'request-id-secret', 'fetch-site-secret', 'fetch-mode-secret', 'fetch-dest-secret', 'Private body marker', 'body-secret', 'query-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('a later onRequest guard rejecting cross-site requests still records the actual 403 JSON response', async t => {
  const fixture = await staticFixture(t);
  const records: DashboardResponseDiagnosticRecord[] = [];
  registerDashboardResponseDiagnostics(fixture.app, { write: record => { records.push(record); } });
  fixture.app.addHook('onRequest', async request => {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw Object.assign(new Error('Request rejected'), { statusCode: 403 });
    }
  });
  await fixture.registerStatic();
  const response = await fixture.app.inject({
    url: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(records.length, 2);
  assert.equal(records[0].event === 'request' && records[0].secFetchSite, 'cross-site');
  assert.equal(records[0].event === 'request' && records[0].secFetchMode, 'navigate');
  assert.equal(records[0].event === 'request' && records[0].secFetchDest, 'document');
  assert.equal(records[1].event === 'response' && records[1].statusCode, 403);
  assert.equal(records[1].event === 'response' && records[1].contentType, response.headers['content-type']);
  assert.equal(records[1].event === 'response' && records[1].outcome, 'finished');
});

test('real HTTP 200, 403, and 304 content types match the observed response headers', { timeout: 5000 }, async t => {
  const fixture = await staticFixture(t);
  const records: DashboardResponseDiagnosticRecord[] = [];
  registerDashboardResponseDiagnostics(fixture.app, { write: record => { records.push(record); } });
  fixture.app.addHook('onRequest', async request => {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw Object.assign(new Error('Request rejected'), { statusCode: 403 });
    }
  });
  fixture.app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: 'Request rejected' });
  });
  await fixture.registerStatic();
  const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const normal = await fetch(address);
  await normal.text();
  const rejected = await fetch(address, { headers: { 'sec-fetch-site': 'cross-site' } });
  await rejected.text();
  // node:http sends precisely this conditional header; fetch may add no-cache
  // request directives for conditional requests and thereby force a 200.
  const conditional = await new Promise<{ statusCode: number | undefined; contentType: string | null }>((resolve, reject) => {
    const request = httpRequest(address, { headers: { 'if-none-match': normal.headers.get('etag')! } }, response => {
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        contentType: response.headers['content-type'] ?? null,
      }));
      response.once('error', reject);
      response.resume();
    });
    request.once('error', reject);
    request.end();
  });
  assert.deepEqual([normal.status, rejected.status, conditional.statusCode], [200, 403, 304]);
  assert.deepEqual(records.filter(record => record.event === 'response').map(record => ({
    statusCode: record.statusCode, contentType: record.contentType,
  })), [...[normal, rejected].map(response => ({
    statusCode: response.status, contentType: response.headers.get('content-type'),
  })), conditional]);
});

test('request count, elapsed deadline, and explicit disposal bound collection without changing responses', async t => {
  const capped = await staticFixture(t);
  const cappedRecords: DashboardResponseDiagnosticRecord[] = [];
  registerDashboardResponseDiagnostics(capped.app, { maxRequests: 1, write: record => { cappedRecords.push(record); } });
  await capped.registerStatic();
  assert.equal((await capped.app.inject('/')).statusCode, 200);
  assert.equal((await capped.app.inject('/')).statusCode, 200);
  assert.equal(cappedRecords.length, 2);

  const timed = await staticFixture(t);
  const timedRecords: DashboardResponseDiagnosticRecord[] = [];
  let clock = Date.UTC(2026, 8, 11);
  const control = registerDashboardResponseDiagnostics(timed.app, {
    durationMs: 100, now: () => clock, write: record => { timedRecords.push(record); },
  });
  await timed.registerStatic();
  assert.equal((await timed.app.inject('/')).statusCode, 200);
  clock += 100;
  assert.equal((await timed.app.inject('/')).statusCode, 200);
  assert.equal(timedRecords.length, 2);
  control.dispose();
  control.dispose();
  assert.equal((await timed.app.inject('/')).body, html);

  const disposed = await staticFixture(t);
  const disposedRecords: DashboardResponseDiagnosticRecord[] = [];
  registerDashboardResponseDiagnostics(disposed.app, { write: record => { disposedRecords.push(record); } }).dispose();
  await disposed.registerStatic();
  assert.equal((await disposed.app.inject('/')).statusCode, 200);
  assert.equal(disposedRecords.length, 0);
});

test('synchronous and asynchronous sink failures stop collection and leave static responses intact', async t => {
  for (const asynchronous of [false, true]) {
    const fixture = await staticFixture(t);
    let writes = 0;
    registerDashboardResponseDiagnostics(fixture.app, {
      write: () => {
        writes++;
        if (asynchronous) return Promise.reject(new Error('diagnostic sink unavailable'));
        throw new Error('diagnostic sink unavailable');
      },
    });
    await fixture.registerStatic();
    for (let i = 0; i < 2; i++) {
      const response = await fixture.app.inject('/');
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, html);
    }
    assert.equal(writes, 1);
  }
});

test('records response connection closure separately without retaining response bodies', { timeout: 5000 }, async t => {
  const app = Fastify();
  t.after(() => app.close());
  const records: DashboardResponseDiagnosticRecord[] = [];
  let closed!: () => void;
  const closedRecord = new Promise<void>(resolve => { closed = resolve; });
  registerDashboardResponseDiagnostics(app, {
    write: record => {
      records.push(record);
      if (record.event === 'response' && record.outcome === 'closed') closed();
    },
  });
  app.get('/', (_request, reply) => {
    reply.hijack();
    reply.raw.setHeader('content-type', 'text/html');
    reply.raw.writeHead(200);
    reply.raw.write('partial-private-body');
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(address, response => {
      response.once('data', () => { response.destroy(); resolve(); });
    });
    request.once('error', reject);
    request.end();
  });
  await closedRecord;
  assert.equal(records.length, 2);
  assert.deepEqual(records[1], {
    timestamp: records[1].timestamp, requestId: 'dashboard-1', method: 'GET', path: '/',
    event: 'response', outcome: 'closed', statusCode: 200, contentType: 'text/html',
  });
  assert.equal(JSON.stringify(records).includes('partial-private-body'), false);
});
