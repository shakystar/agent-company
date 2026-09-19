import { createServer as createHttpServer } from 'node:http';
import { createServer as createSocketServer, createConnection } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ files: 1000, bytes: 8 * 1024 * 1024, request: 13 * 1024 * 1024,
  response: 1024 * 1024, screenshot: 600 * 1024, elements: 300, diagnostics: 40 });
export const SOCKET_PATH = '/tmp/ac-browser.sock';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, maximum = 1000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum);
const safeUrl = value => {
  try { const url = new URL(value); return text(`${url.protocol}//${url.host}${url.pathname}`, 500); }
  catch { return '[invalid URL]'; }
};
const safeDiagnostic = value => text(value).replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/\b(api[_-]?key|access_token|refresh_token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
const fields = (value, allowed) => assert(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'Unexpected browser request fields');

/** Files are data, never host paths. Reject ambiguous spelling rather than normalizing traversal. */
export function filePath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 512, 'Invalid preview file path');
  const normalized = value.normalize('NFC');
  assert(!/[\\%?#:\u0000-\u001f\u007f]/.test(normalized), 'Unsafe preview file path');
  const parts = normalized.split('/');
  assert(parts.every(part => part && part !== '..' && !part.startsWith('.') && part.trim() === part), 'Hidden or traversing preview path');
  assert(!parts.some(part => /^(?:agents\.md|credentials?(?:\.json)?|secrets?|auth\.json|cookies?\.json|sessions?\.json|id_rsa|id_ed25519|node_modules)$/i.test(part)), 'Sensitive preview path');
  assert(!/\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(normalized), 'Sensitive preview file type');
  return normalized;
}

export function fileBundle(files, entry) {
  assert(Array.isArray(files) && files.length > 0 && files.length <= LIMITS.files, 'Preview requires 1 to 1000 files');
  const map = new Map(), names = new Set(); let bytes = 0;
  for (const item of files) {
    fields(item, ['path', 'contentBase64']);
    const path = filePath(item.path);
    assert(!names.has(path.toLowerCase()), 'Duplicate normalized preview path'); names.add(path.toLowerCase());
    assert(typeof item.contentBase64 === 'string' && item.contentBase64.length <= Math.ceil(LIMITS.bytes / 3) * 4
      && item.contentBase64.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(item.contentBase64), 'Invalid preview base64');
    const padding = item.contentBase64.indexOf('=');
    assert(padding === -1 || ['=', '=='].includes(item.contentBase64.slice(padding)), 'Invalid preview base64 padding');
    const content = Buffer.from(item.contentBase64, 'base64');
    assert(content.toString('base64') === item.contentBase64, 'Noncanonical preview base64');
    bytes += content.length;
    assert(bytes <= LIMITS.bytes, 'Preview exceeds the 8 MiB source limit');
    map.set(path, content);
  }
  entry = filePath(entry);
  assert(/\.html?$/i.test(entry) && map.has(entry), 'Preview entry must be an included HTML file');
  return { files: map, entry, bytes };
}

export function viewport(value = { width: 1440, height: 900 }) {
  fields(value, ['width', 'height']);
  assert(Number.isSafeInteger(value.width) && value.width >= 240 && value.width <= 2560
    && Number.isSafeInteger(value.height) && value.height >= 200 && value.height <= 2160, 'Viewport must be 240-2560 by 200-2160 pixels');
  return { width: value.width, height: value.height };
}

const keys = new Set(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'ControlOrMeta+A']);
export function validateRequest(value) {
  assert(object(value) && typeof value.action === 'string', 'Invalid browser request');
  const allowed = { open: ['files', 'entry', 'viewport'], snapshot: [], click: ['ref'], fill: ['ref', 'value'],
    press: ['key', 'ref'], resize: ['width', 'height'], screenshot: [], close: [], status: [] };
  assert(own(allowed, value.action), 'Unsupported browser action');
  fields(value, ['action', ...allowed[value.action]]);
  if (value.action === 'open') return { action: 'open', bundle: fileBundle(value.files, value.entry), viewport: viewport(value.viewport) };
  if (value.action === 'resize') return { action: 'resize', viewport: viewport({ width: value.width, height: value.height }) };
  if (value.action === 'click' || value.action === 'fill' || own(value, 'ref')) {
    assert(typeof value.ref === 'string' && /^r-[a-f0-9]{16}-\d{1,3}$/.test(value.ref), 'A current snapshot reference is required');
  }
  if (value.action === 'fill') assert(typeof value.value === 'string' && value.value.length <= 10_000 && !value.value.includes('\0'), 'Invalid fill value');
  if (value.action === 'press') assert(keys.has(value.key), 'Unsupported browser key');
  return { ...value };
}

const mediaTypes = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm' };

export function resolveFileRequest(bundle, rawUrl, method = 'GET') {
  if (!bundle || !['GET', 'HEAD'].includes(method)) return { status: 405 };
  try {
    assert(typeof rawUrl === 'string' && rawUrl.length <= 2048 && rawUrl.startsWith('/') && !rawUrl.startsWith('//'), 'Invalid static URL');
    const rawPath = rawUrl.split('?')[0];
    assert(!/%(?:2f|5c|00)/i.test(rawPath), 'Encoded separator');
    const decoded = decodeURIComponent(rawPath);
    const path = decoded === '/' ? bundle.entry : filePath(decoded.slice(1));
    const content = bundle.files.get(path);
    return content ? { status: 200, content, mediaType: mediaTypes[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream' } : { status: 404 };
  } catch { return { status: 400 }; }
}

const csp = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'";
export async function staticServer(currentBundle) {
  const server = createHttpServer((request, response) => {
    const result = resolveFileRequest(currentBundle(), request.url, request.method);
    response.writeHead(result.status, { 'Content-Type': result.mediaType ?? 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp,
      'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' });
    response.end(request.method === 'HEAD' ? undefined : result.content ?? `Preview request rejected (${result.status})`);
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert(address && typeof address === 'object', 'Preview loopback server did not start');
  return { origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}

export class References {
  constructor() { this.handles = new Map(); }
  async clear() {
    const handles = [...this.handles.values()]; this.handles.clear();
    await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
  }
  async replace(entries) {
    await this.clear();
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
    return entries.slice(0, LIMITS.elements).map(({ handle, ...description }, index) => {
      const ref = `r-${nonce}-${index}`; this.handles.set(ref, handle); return { ref, ...description };
    });
  }
  get(ref) { const handle = this.handles.get(ref); assert(handle, 'Snapshot reference expired; request a new snapshot'); return handle; }
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
}

/** One instance belongs to one controller-owned container. No host files, account or URLs are accepted. */
export class BrowserSession {
  constructor({ launch = launchBrowser } = {}) {
    this.launch = launch; this.references = new References(); this.diagnostics = [];
    this.browser = null; this.context = null; this.page = null; this.bundle = null; this.server = null;
  }
  diagnostic(kind, value) {
    this.diagnostics.push({ kind, message: safeDiagnostic(value) });
    if (this.diagnostics.length > LIMITS.diagnostics) this.diagnostics.shift();
  }
  async close() {
    await this.references.clear();
    const context = this.context; this.page = null; this.context = null; this.bundle = null;
    if (context) await context.close();
  }
  async dispose() {
    try { await this.close(); } finally {
      try { await this.browser?.close(); } finally { this.browser = null; await this.server?.close(); this.server = null; }
    }
  }
  async open(request) {
    await this.close(); this.diagnostics = [];
    this.bundle = request.bundle;
    try {
      this.server ??= await staticServer(() => this.bundle);
      this.browser ??= await this.launch();
      this.context = await this.browser.newContext({ viewport: request.viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
        permissions: [], acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false });
      const origin = this.server.origin;
      await this.context.route('**/*', async route => {
        const request = route.request(); let allowed = false;
        try { const url = new URL(request.url()); allowed = url.origin === origin && ['GET', 'HEAD'].includes(request.method()) && !url.username && !url.password; } catch { /* deny */ }
        if (allowed) await route.continue();
        else { this.diagnostic('requestblocked', `${request.method()} ${safeUrl(request.url())}`); await route.abort('blockedbyclient'); }
      });
      await this.context.routeWebSocket('**/*', socket => { this.diagnostic('requestblocked', `WebSocket ${safeUrl(socket.url())}`); socket.close(); });
      this.context.on('page', page => { if (this.page && page !== this.page) { this.diagnostic('popupblocked', 'Additional page blocked'); void page.close().catch(() => {}); } });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(10_000); this.page.setDefaultNavigationTimeout(20_000);
      this.page.on('console', message => { if (['error', 'warning'].includes(message.type())) this.diagnostic(message.type(), message.text()); });
      this.page.on('pageerror', error => this.diagnostic('pageerror', error.message));
      this.page.on('requestfailed', request => this.diagnostic('requestfailed', `${safeUrl(request.url())} ${request.failure()?.errorText ?? ''}`));
      this.page.on('dialog', dialog => { this.diagnostic('dialogdismissed', dialog.type()); void dialog.dismiss().catch(() => {}); });
      this.page.on('download', download => { this.diagnostic('downloadblocked', 'Download blocked'); void download.cancel().catch(() => {}); });
      await this.page.goto(`${origin}/${request.bundle.entry.split('/').map(encodeURIComponent).join('/')}`, { waitUntil: 'domcontentloaded' });
      return await this.snapshot();
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  async snapshot() {
    assert(this.page, 'No preview session is open');
    await this.references.clear();
    const locator = this.page.locator('a,button,input,textarea,select,summary,[role],[tabindex]');
    const elementCount = await locator.count();
    const handles = (await Promise.all(Array.from({ length: Math.min(elementCount, LIMITS.elements) }, (_, index) => locator.nth(index).elementHandle()))).filter(Boolean);
    const entries = [];
    for (const handle of handles) {
      if (entries.length >= LIMITS.elements || !(await handle.isVisible().catch(() => false))) { await handle.dispose(); continue; }
      const description = await handle.evaluate(element => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? '',
        name: (element.getAttribute('aria-label') || [...(element.labels ?? [])].map(label => label.innerText).join(' ')
          || element.innerText || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || '').slice(0, 240) })).catch(() => null);
      if (description) entries.push({ handle, ...description }); else await handle.dispose();
    }
    const elements = await this.references.replace(entries);
    return { title: text(await this.page.title(), 500), url: text(this.page.url(), 2048),
      snapshot: text(await this.page.locator('body').ariaSnapshot({ timeout: 10_000 }), 64_000), elements,
      elementsTruncated: elementCount > LIMITS.elements, diagnostics: [...this.diagnostics] };
  }
  async screenshot() {
    assert(this.page, 'No preview session is open');
    for (const quality of [75, 50, 30, 15]) {
      const bytes = await this.page.screenshot({ type: 'jpeg', quality, fullPage: false, animations: 'disabled', timeout: 8000 });
      assert(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'Browser returned an invalid JPEG');
      if (bytes.length <= LIMITS.screenshot) return { content: [{ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }],
        metadata: { ...this.page.viewportSize(), url: text(this.page.url(), 2048), quality }, diagnostics: [...this.diagnostics] };
    }
    throw new Error('Screenshot exceeds the 600 KiB decoded image limit');
  }
  async dispatch(raw) {
    const request = validateRequest(raw);
    if (request.action === 'status') return { open: Boolean(this.page), files: this.bundle?.files.size ?? 0, bytes: this.bundle?.bytes ?? 0,
      browserVersion: this.browser?.version() ?? null, diagnostics: [...this.diagnostics] };
    if (request.action === 'close') { await this.close(); return { open: false }; }
    if (request.action === 'open') return this.open(request);
    assert(this.page, 'No preview session is open');
    if (request.action === 'snapshot') return this.snapshot();
    if (request.action === 'screenshot') return this.screenshot();
    try {
      if (request.action === 'click') await this.references.get(request.ref).click({ timeout: 10_000 });
      if (request.action === 'fill') await this.references.get(request.ref).fill(request.value, { timeout: 10_000 });
      if (request.action === 'press') { if (request.ref) await this.references.get(request.ref).focus(); await this.page.keyboard.press(request.key); }
      if (request.action === 'resize') await this.page.setViewportSize(request.viewport);
      return await this.snapshot();
    } catch (error) { await this.references.clear(); throw error; }
  }
}

function encoded(value) {
  const content = JSON.stringify(value);
  assert(Buffer.byteLength(content) <= LIMITS.response, 'Browser response exceeds the 1 MiB limit');
  return content;
}

export async function serve({ socketPath = SOCKET_PATH, session = new BrowserSession() } = {}) {
  try { await lstat(socketPath); throw new Error('Browser socket already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let queued = 0, chain = Promise.resolve(), closing = false;
  const clients = new Set();
  const server = createSocketServer({ allowHalfOpen: true }, socket => {
    if (closing || clients.size >= 4) { socket.end(encoded({ error: 'Browser connection limit exceeded' })); return; }
    clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket)); socket.setTimeout(65_000, () => socket.destroy());
    const chunks = []; let count = 0, handled = false;
    const dispatch = data => {
      if (socket.destroyed || handled) return; handled = true;
      let request;
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        assert(queued < 4, 'Browser operation queue limit exceeded'); queued += 1;
      }
      catch (error) { socket.end(encoded({ error: text(error.message) })); return; }
      chain = chain.then(async () => {
        try { assert(!closing, 'Browser is shutting down'); socket.end(`${encoded(await session.dispatch(request))}\n`); }
        catch (error) { socket.end(`${encoded({ error: text(error.message, 2000) })}\n`); }
        finally { queued -= 1; }
      });
    };
    socket.on('data', chunk => {
      count += chunk.length;
      if (handled || count > LIMITS.request) { socket.destroy(); return; }
      chunks.push(chunk);
      if (chunk.includes(10)) dispatch(Buffer.concat(chunks));
    });
    socket.on('end', () => { if (!handled) dispatch(Buffer.concat(chunks)); });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  return { async close() {
    closing = true;
    for (const socket of clients) socket.destroy();
    await new Promise(done => server.close(done)); await chain; await session.dispose();
    if (process.platform !== 'win32') await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

export async function call(request, { socketPath = SOCKET_PATH } = {}) {
  const data = JSON.stringify(request); assert(Buffer.byteLength(data) <= LIMITS.request, 'Browser request exceeds its limit');
  return new Promise((done, reject) => {
    const socket = createConnection({ path: socketPath }); const chunks = []; let bytes = 0;
    socket.setTimeout(65_000, () => socket.destroy(new Error('Browser operation timed out')));
    socket.once('connect', () => socket.write(`${data}\n`));
    socket.on('data', chunk => { bytes += chunk.length; if (bytes > LIMITS.response) socket.destroy(new Error('Browser response exceeds its limit')); else chunks.push(chunk); });
    socket.once('error', reject);
    socket.once('end', () => { try { done(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); } catch { reject(new Error('Invalid browser response')); } });
  });
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--call') {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; assert(bytes <= LIMITS.request, 'Browser request exceeds its limit'); chunks.push(chunk); }
    const result = await call(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    process.stdout.write(`${encoded(result)}\n`); if (result.error) process.exitCode = 1;
  } else {
    assert(process.argv.length === 2, 'Unsupported browser worker arguments');
    const server = await serve();
    let ending = false;
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      if (ending) return; ending = true;
      server.close().then(() => { process.exitCode = 0; }, error => { process.stderr.write(`${text(error.message)}\n`); process.exitCode = 1; });
    });
    process.stderr.write('Agent Company isolated browser ready\n');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stdout.write(`${JSON.stringify({ error: text(error.message, 2000) })}\n`); process.exitCode = 1; });
}
