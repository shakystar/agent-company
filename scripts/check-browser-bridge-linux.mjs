// Run only inside a disposable worker verification container. This script never
// starts Codex or a model and never mounts an existing workspace or credentials.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, readdir, access, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { collectWorkspacePreview } from '/app/browser-source.mjs';
import { createTeamBridge } from '/app/team-mcp.mjs';

const checks = [];
async function check(name, operation) {
  await operation();
  checks.push({ name, passed: true });
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2E8AAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const expected = { content: [{ type: 'text', text: 'Verified fixture image' }, image] };
const capture = path => collectWorkspacePreview({ kind: 'workspace', path });

await check('linux non-root isolated fixture without authentication', async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 1000);
  const status = await readFile('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  for (const path of ['/home/node/.codex/auth.json', '/workspace/.codex/auth.json', '/credentials', '/var/run/docker.sock']) {
    await assert.rejects(access(path), { code: 'ENOENT' });
  }
  assert.deepEqual(await readdir('/workspace'), []);
  assert.ok(!process.env.OPENAI_API_KEY && !process.env.AGENT_SECRET_DIR);
  await assert.rejects(writeFile('/app/verification-must-not-write', 'not allowed'), /EROFS|EACCES/);
  const interfaces = await readdir('/sys/class/net');
  assert.deepEqual(interfaces, ['lo']);
});

await mkdir('/workspace/site/demo', { recursive: true });
await writeFile('/workspace/site/index.html', '<h1>\uD55C\uAE00</h1>');
await writeFile('/workspace/site/demo/pixel.png', Buffer.from(png, 'base64'));

await check('actual Linux descriptor-anchored nested traversal and binary capture', async () => {
  const before = await readdir('/proc/self/fd');
  const result = await capture('site');
  assert.deepEqual(result.source, { kind: 'workspace', path: 'site' });
  assert.deepEqual(result.files.map(file => file.path), ['demo/pixel.png', 'index.html']);
  assert.equal(result.files[0].contentBase64, png);
  assert.equal(Buffer.from(result.files[1].contentBase64, 'base64').toString(), '<h1>\uD55C\uAE00</h1>');
  assert.equal((await readdir('/proc/self/fd')).length, before.length);
});

await check('canonical paths, reserved names and Unicode collisions fail closed', async () => {
  for (const path of ['../site', '/site', 'site/..', 'site/.private', 'site\\file', 'site//demo', 'site/auth.json',
    'site/CREDENTIALS.JSON', 'site/AGENTS.md', 'site/file:stream', 'site/%2e%2e', 'site/name.', 'site/name ',
    'site/id_rsa', 'site/cert.pem', 'site/node_modules', 'x'.repeat(513)]) await assert.rejects(capture(path), /path|permitted/);
  for (const [index, name] of ['.env', 'AGENTS.md', 'auth.json', 'credentials.json', 'id_rsa', 'private.key'].entries()) {
    const directory = `sensitive-${index}`;
    await mkdir(`/workspace/${directory}`);
    await writeFile(`/workspace/${directory}/${name}`, 'fixture secret, must not be captured');
    await assert.rejects(capture(directory), /path|reserved/);
  }
  await mkdir('/workspace/duplicates');
  await writeFile('/workspace/duplicates/\u00e9.html', 'one');
  await writeFile('/workspace/duplicates/e\u0301.html', 'two');
  await assert.rejects(capture('duplicates'), /duplicate normalized/);
});

await check('inner and outer symlinks, hard links and FIFO special files are rejected', async () => {
  const outside = await mkdtemp('/tmp/ac-browser-outside-');
  await writeFile(join(outside, 'fixture.txt'), 'outside selected workspace');
  await symlink('/workspace/site', '/workspace/inner-link');
  await symlink(outside, '/workspace/outer-link');
  await assert.rejects(capture('inner-link'), /links/);
  await assert.rejects(capture('outer-link'), /links/);
  await mkdir('/workspace/linked-file');
  await symlink(join(outside, 'fixture.txt'), '/workspace/linked-file/fixture.txt');
  await assert.rejects(capture('linked-file'), /links/);
  await mkdir('/workspace/hardlinked');
  await link('/workspace/site/index.html', '/workspace/hardlinked/fixture.txt');
  await assert.rejects(capture('hardlinked'), /single-link/);
  await mkdir('/workspace/fifo');
  const made = spawnSync('mkfifo', ['/workspace/fifo/pipe']);
  assert.equal(made.status, 0, made.stderr.toString());
  await assert.rejects(capture('fifo'), /regular files/);
});

await check('individual 2 MiB, aggregate 8 MiB and 1000-file bounds are enforced', async () => {
  await mkdir('/workspace/oversized');
  await writeFile('/workspace/oversized/large.bin', Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(capture('oversized'), /limit/);
  await mkdir('/workspace/aggregate');
  for (let index = 0; index < 4; index++) await writeFile(`/workspace/aggregate/${index}.bin`, Buffer.alloc(2 * 1024 * 1024));
  assert.equal((await capture('aggregate')).files.length, 4);
  await writeFile('/workspace/aggregate/extra.txt', 'x');
  await assert.rejects(capture('aggregate'), /limit/);
  await mkdir('/workspace/many');
  for (let index = 0; index < 1001; index++) await writeFile(`/workspace/many/${index}.txt`, '');
  await assert.rejects(capture('many'), /limit/);
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(collectWorkspacePreview({ kind: 'workspace', path: 'aggregate' }, { signal: controller.signal }), /fixture cancelled/);
});

await mkdir('/workspace/ipc');
await writeFile('/workspace/ipc/index.html', 'x'.repeat(300 * 1024));
const socketPath = `/tmp/ac-browser-bridge-${randomUUID()}.sock`;
const tools = ['browser_open', 'browser_action', 'environment_call'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
let bridge;
let forwarded = 0;
bridge = await createTeamBridge({ socketPath, tools, emit: request => {
  forwarded++;
  if (request.name === 'browser_open') {
    assert.equal(request.arguments.files.length, 1);
    assert.equal(Buffer.from(request.arguments.files[0].contentBase64, 'base64').length, 300 * 1024);
    queueMicrotask(() => bridge.acceptResponse({ type: 'tool_response', id: request.id, result: { opened: true } }));
  } else {
    queueMicrotask(() => bridge.acceptResponse({ type: 'tool_response', id: request.id, result: { __browserMcpContent: expected } }));
  }
} });
const child = spawn(process.execPath, ['/app/team-mcp.mjs', '--socket', socketPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const next = async () => {
  const line = await iterator.next(); assert.equal(line.done, false, stderr);
  assert.ok(Buffer.byteLength(line.value) < 1024 * 1024);
  return JSON.parse(line.value);
};
const send = (id, method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
try {
  await check('real stdio MCP process initializes without a model or TCP listener', async () => {
    send(0, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal((await next()).result.serverInfo.name, 'agent-company-team');
  });
  await check('workspace file capture crosses IPC above 256 KiB without echoing source into model output', async () => {
    send(1, 'tools/call', { name: 'browser_open', arguments: { source: { kind: 'workspace', path: 'ipc' } } });
    const response = await next();
    assert.deepEqual(JSON.parse(response.result.content[0].text), { opened: true });
    assert.doesNotMatch(JSON.stringify(response), /contentBase64|xxxx/);
  });
  await check('screenshot envelope becomes actual MCP PNG image while environment and snapshot stay text', async () => {
    for (const [id, name, action] of [[2, 'browser_action', 'screenshot'], [3, 'environment_call', 'screenshot'], [4, 'browser_action', 'snapshot']]) {
      send(id, 'tools/call', { name, arguments: { action } });
      const response = await next();
      assert.equal(response.id, id);
      if (id === 2) assert.deepEqual(response.result, expected);
      else {
        assert.equal(response.result.content[0].type, 'text');
        assert.deepEqual(JSON.parse(response.result.content[0].text), { __browserMcpContent: expected });
      }
    }
    assert.equal(forwarded, 4);
  });
  const exited = once(child, 'close'); child.stdin.end();
  assert.equal((await exited)[0], 0); assert.equal(stderr, '');
} finally {
  child.kill(); lines.close(); await bridge.close();
}

const sourceHashes = {};
for (const path of ['entry.mjs', 'principles.mjs', 'team-mcp.mjs', 'browser-source.mjs', 'workspace.mjs', 'storage.mjs', 'growth.mjs', 'environment.mjs', 'npm-empty.npmrc']) {
  sourceHashes[path] = createHash('sha256').update(await readFile(`/app/${path}`)).digest('hex');
}
process.stdout.write(`${JSON.stringify({ status: 'passed', checks, modelStarts: 0, platform: process.platform,
  uid: process.getuid(), sourceHashes, note: 'Real Linux file collection and stdio MCP transport; no Chromium or model execution.' }, null, 2)}\n`);
