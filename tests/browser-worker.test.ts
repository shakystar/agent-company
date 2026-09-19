import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

// Importing the shipped worker never imports or launches Playwright.
const { LIMITS, filePath, fileBundle, resolveFileRequest, validateRequest, References, BrowserSession, staticServer, serve, call }
  = await import(new URL('../worker/browser.mjs', import.meta.url).href);
const file = (path: string, content: string | Buffer) => ({ path, contentBase64: Buffer.from(content).toString('base64') });
const opening = (content = '<h1>한국어 화면</h1>') => ({ action: 'open', entry: 'index.html', files: [file('index.html', content)] });

test('browser files reject traversal, sensitive paths, malformed base64 and normalized duplicates', () => {
  for (const path of ['../index.html', '/index.html', 'a/../index.html', 'a\\b.html', 'a//b.html', '.git/config', 'a/.env',
    'credentials/auth.json', 'auth.json', 'a/key.pem', 'a%2fb.html', 'index.html?key=1', 'C:/index.html', ' a.html', 'a\0.html']) {
    assert.throws(() => filePath(path), path);
  }
  for (const contentBase64 of ['x', 'x===', 'dGVzdA', 'dGVzdA==\n', '====', 'AB==']) {
    assert.throws(() => fileBundle([{ path: 'index.html', contentBase64 }], 'index.html'));
  }
  assert.throws(() => fileBundle([file('index.html', ''), file('index.html', '')], 'index.html'), /Duplicate/);
  assert.throws(() => fileBundle([file('index.html', ''), file('INDEX.HTML', '')], 'index.html'), /Duplicate/);
  assert.throws(() => fileBundle([file('index.html', ''), file('caf\u00e9.txt', ''), file('cafe\u0301.txt', '')], 'index.html'), /Duplicate/);
  assert.throws(() => fileBundle([file('index.html', '')], 'missing.html'), /entry/);
  assert.throws(() => fileBundle([file('main.js', '')], 'main.js'), /entry/);
  assert.throws(() => fileBundle([{ ...file('index.html', ''), hostPath: '/etc/passwd' }], 'index.html'), /fields/);
});

test('browser files enforce aggregate bytes and file count and copy caller-owned input', () => {
  assert.throws(() => fileBundle(Array.from({ length: LIMITS.files + 1 }, (_, i) => file(`${i}.html`, '')), '0.html'), /1000/);
  assert.throws(() => fileBundle([file('index.html', Buffer.alloc(LIMITS.bytes)), file('extra.txt', 'x')], 'index.html'), /8 MiB/);
  const input = [file('index.html', 'before'), file('한국어/문서.txt', '한글')];
  const bundle = fileBundle(input, 'index.html'); input[0].contentBase64 = Buffer.from('after').toString('base64');
  assert.equal(bundle.files.get('index.html').toString(), 'before');
  assert.equal(bundle.files.get('한국어/문서.txt').toString(), '한글');
});

test('browser static requests have no filesystem fallback and restrict paths and methods', () => {
  const bundle = fileBundle([file('index.html', 'hello'), file('assets/한글.css', 'body{}')], 'index.html');
  assert.equal(resolveFileRequest(bundle, '/').content.toString(), 'hello');
  assert.equal(resolveFileRequest(bundle, '/assets/%ED%95%9C%EA%B8%80.css?v=2').mediaType, 'text/css; charset=utf-8');
  assert.equal(resolveFileRequest(bundle, '/missing').status, 404);
  assert.equal(resolveFileRequest(bundle, '/', 'POST').status, 405);
  for (const path of ['/../etc/passwd', '/%2e%2e/etc/passwd', '//other.test/path', '/a%2fb', '/%252e%252e/x', '/.env', '/a\\b']) {
    assert.equal(resolveFileRequest(bundle, path).status, 400, path);
  }
});

test('browser request schema accepts only scoped actions, references, sizes and keys', () => {
  for (const request of [{ ...opening(), url: 'https://example.com' }, { action: 'evaluate', script: '1' },
    { action: 'click', selector: 'button' }, { action: 'press', key: 'x'.repeat(100) }, { action: 'resize', width: 9999, height: 900 },
    { action: 'fill', ref: 'r-0123456789abcdef-0', value: 'x'.repeat(10_001) }, { action: 'status', environment: true }]) {
    assert.throws(() => validateRequest(request));
  }
  assert.deepEqual(validateRequest({ action: 'resize', width: 390, height: 844 }).viewport, { width: 390, height: 844 });
  assert.deepEqual(validateRequest({ action: 'press', key: 'Tab' }), { action: 'press', key: 'Tab' });
  assert.equal(validateRequest(opening()).bundle.files.size, 1);
});

test('browser references expire on the next snapshot and dispose old handles', async () => {
  const references = new References(); let disposed = 0;
  const handle = { dispose: async () => { disposed += 1; } };
  const first = await references.replace([{ handle, tag: 'button', role: '', name: '확인' }]);
  assert.equal(references.get(first[0].ref), handle);
  const second = await references.replace([{ handle: { dispose: async () => {} }, tag: 'input', role: '', name: '이름' }]);
  assert.equal(disposed, 1); assert.notEqual(first[0].ref, second[0].ref);
  assert.throws(() => references.get(first[0].ref), /expired/);
  await references.clear(); assert.throws(() => references.get(second[0].ref), /expired/);
});

async function fakeSession(t: TestContext) {
  const events: string[] = []; const contexts: any[] = [];
  let launches = 0;
  const session = new BrowserSession({ launch: async () => {
    launches += 1;
    return { version: () => 'fixture', close: async () => { events.push('browser-close'); }, newContext: async (options: any) => {
      const context: any = { state: '', options, close: async () => { events.push('context-close'); }, on() {},
        route: async (_pattern: string, fn: any) => { context.route = fn; }, routeWebSocket: async () => {}, newPage: async () => page };
      const handle = () => ({ dispose: async () => {}, isVisible: async () => true,
        evaluate: async () => ({ tag: 'input', role: '', name: '이름' }),
        fill: async (value: string) => { context.state = value; }, click: async () => { events.push('click'); }, focus: async () => {} });
      const page: any = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {},
        title: async () => '한글 페이지', url: () => context.url, viewportSize: () => context.options.viewport,
        goto: async (url: string) => { context.url = url; }, setViewportSize: async (size: any) => { context.options.viewport = size; },
        keyboard: { press: async (key: string) => { events.push(`key:${key}`); } },
        screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        locator: (selector: string) => selector === 'body' ? { ariaSnapshot: async () => `textbox 이름: ${context.state}` }
          : { count: async () => 1, nth: () => ({ elementHandle: async () => handle() }) } };
      contexts.push(context); return context;
    } };
  } });
  t.after(() => session.dispose());
  return { session, events, contexts, launches: () => launches };
}

test('browser session retains same-context state and replaces context and sources on open', async t => {
  const h = await fakeSession(t);
  await assert.rejects(h.session.dispatch({ action: 'snapshot' }), /No preview/);
  const first = await h.session.dispatch(opening());
  const filled = await h.session.dispatch({ action: 'fill', ref: first.elements[0].ref, value: '보존된 값' });
  assert.match(filled.snapshot, /보존된 값/);
  await assert.rejects(h.session.dispatch({ action: 'click', ref: first.elements[0].ref }), /expired/);
  const current = await h.session.dispatch({ action: 'snapshot' });
  await h.session.dispatch({ action: 'click', ref: current.elements[0].ref });
  await h.session.dispatch({ action: 'press', key: 'Tab' });
  await h.session.dispatch({ action: 'resize', width: 390, height: 844 });
  const shot = await h.session.dispatch({ action: 'screenshot' });
  assert.equal(shot.content[0].type, 'image'); assert.equal(shot.metadata.width, 390);
  assert.equal(Buffer.from(shot.content[0].data, 'base64').length, 4);
  const replacement = await h.session.dispatch(opening('<h1>새 소스</h1>'));
  assert.doesNotMatch(replacement.snapshot, /보존된 값/); assert.equal(h.launches(), 1); assert.equal(h.contexts.length, 2);
  assert.equal(h.session.bundle.files.get('index.html').toString(), '<h1>새 소스</h1>');
  await h.session.dispatch({ action: 'close' });
  assert.equal((await h.session.dispatch({ action: 'status' })).open, false);
});

test('browser route denies external URLs, writes and WebSockets and bounds diagnostics', async t => {
  const h = await fakeSession(t); const opened = await h.session.dispatch(opening());
  const route = h.contexts[0].route;
  for (const [url, method, expected] of [[opened.url, 'GET', 'continue'], ['https://example.invalid/', 'GET', 'abort'],
    [opened.url, 'POST', 'abort'], ['file:///etc/passwd', 'GET', 'abort'], ['http://user:password@127.0.0.1/', 'GET', 'abort']]) {
    let action = '';
    await route({ request: () => ({ url: () => url, method: () => method }), continue: async () => { action = 'continue'; }, abort: async () => { action = 'abort'; } });
    assert.equal(action, expected);
  }
  for (let i = 0; i < 100; i++) h.session.diagnostic('warning', 'x'.repeat(5000));
  assert.equal(h.session.diagnostics.length, LIMITS.diagnostics); assert.equal(h.session.diagnostics[0].message.length, 1000);
  h.session.diagnostic('error', 'Authorization: Bearer private-value api_key=private-key');
  assert.doesNotMatch(h.session.diagnostics.at(-1).message, /private-value|private-key/);
});

test('browser screenshot fails explicitly when bounded JPEG encoding cannot fit', async t => {
  const h = await fakeSession(t); await h.session.dispatch(opening()); let attempts = 0;
  h.session.page.screenshot = async () => { attempts += 1; const bytes = Buffer.alloc(LIMITS.screenshot + 1); bytes[0] = 255; bytes[1] = 216; bytes[bytes.length - 2] = 255; bytes[bytes.length - 1] = 217; return bytes; };
  await assert.rejects(h.session.dispatch({ action: 'screenshot' }), /600 KiB/); assert.equal(attempts, 4);
});

test('browser memory server reads replacement data without filesystem writes', async t => {
  let bundle = fileBundle([file('index.html', 'first')], 'index.html');
  const server = await staticServer(() => bundle); t.after(() => server.close());
  const first = await fetch(server.origin); assert.equal(await first.text(), 'first');
  assert.match(first.headers.get('content-security-policy')!, /connect-src 'self'/);
  assert.equal((await fetch(`${server.origin}/missing`)).status, 404);
  bundle = fileBundle([file('index.html', 'replacement')], 'index.html');
  assert.equal(await (await fetch(server.origin)).text(), 'replacement');
});

test('browser Unix socket protocol serializes calls and preserves UTF-8 JSON', { timeout: 5000 }, async t => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ac-browser-${randomUUID()}` : join(tmpdir(), `ac-browser-${randomUUID()}.sock`);
  let active = 0, maximum = 0, disposed = false;
  const server = await serve({ socketPath, session: { dispatch: async (request: any) => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(done => setTimeout(done, 10)); active -= 1; return { result: request.value };
  }, dispose: async () => { disposed = true; } } });
  t.after(() => server.close());
  const responses = await Promise.all([call({ value: '한글'.repeat(1000) }, { socketPath }), call({ value: '둘째' }, { socketPath })]);
  assert.equal(responses[0].result, '한글'.repeat(1000)); assert.equal(responses[1].result, '둘째'); assert.equal(maximum, 1); assert.equal(disposed, false);
});

test('browser image recipe enables real Chromium and sandboxed execution without weakening flags', async () => {
  const recipe = await readFile(new URL('../worker/browser.Dockerfile', import.meta.url), 'utf8');
  const source = await readFile(new URL('../worker/browser.mjs', import.meta.url), 'utf8');
  assert.match(recipe, /playwright@1\.63\.0/); assert.match(recipe, /fonts-noto-cjk/); assert.match(recipe, /USER node/);
  assert.match(source, /chromiumSandbox: true/);
  assert.doesNotMatch(source, /--no-sandbox|--disable-setuid-sandbox|--disable-web-security|ignoreDefaultArgs/);
});
