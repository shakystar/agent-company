import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const bounded = (value, limit = 262_144) => { const text = JSON.stringify(value); assert(typeof text === 'string' && Buffer.byteLength(text) <= limit, 'Environment response exceeds its limit'); return text; };
const inside = (root, target) => { const path = relative(root, target); return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const specHash = value => digest(bounded(canonical(value)));
const require = createRequire(import.meta.url);
const npmPolicies = ['allow-remote', 'allow-git', 'allow-file', 'allow-directory'];
export function assertNpmPolicyDefinitions(definitions) {
  for (const name of npmPolicies) assert(object(definitions?.[name]) && Array.isArray(definitions[name].type) && definitions[name].type.includes('none'), `Installed npm does not support enforced ${name}=none`);
}

// Revalidate at the container boundary; no specification field is executable code.
export function validateSpec(spec) {
  assert(object(spec) && Object.keys(spec).every(key => ['packages', 'servers'].includes(key)), 'Invalid environment specification');
  assert(Array.isArray(spec.packages) && spec.packages.length <= 10 && Array.isArray(spec.servers) && spec.servers.length <= 2, 'Environment size limit exceeded');
  const names = new Set(), servers = new Set();
  for (const item of spec.packages) {
    assert(object(item) && Object.keys(item).every(key => ['name', 'version'].includes(key)) && typeof item.name === 'string' && item.name.length <= 214 && packagePattern.test(item.name)
      && typeof item.version === 'string' && item.version.length <= 80 && versionPattern.test(item.version) && !names.has(item.name), 'Packages must have unique names and exact versions');
    names.add(item.name);
  }
  for (const item of spec.servers) {
    assert(object(item) && Object.keys(item).every(key => ['name', 'package', 'bin', 'args', 'probe'].includes(key))
      && typeof item.name === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(item.name) && !servers.has(item.name) && names.has(item.package)
      && typeof item.bin === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(item.bin), 'Invalid MCP declaration');
    assert(Array.isArray(item.args) && item.args.length <= 20 && item.args.every(arg => typeof arg === 'string' && arg.length <= 1000 && !/[\x00-\x1f\x7f]/.test(arg)), 'Invalid MCP arguments');
    assert(object(item.probe) && Object.keys(item.probe).every(key => ['tool', 'arguments'].includes(key)) && typeof item.probe.tool === 'string' && item.probe.tool.length > 0 && item.probe.tool.length <= 100 && object(item.probe.arguments), 'An explicit MCP probe is required');
    bounded(item.probe.arguments, 32_768); servers.add(item.name);
  }
  return spec;
}

async function plainFile(path, limit = 4 * 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'Expected a bounded regular environment file');
    const content = await handle.readFile();
    assert(content.length === stat.size, 'Environment file changed during reading');
    return content;
  } finally { await handle.close(); }
}

export function validateLockfile(lock, spec) {
  validateSpec(spec);
  assert(object(lock) && lock.lockfileVersion === 3 && object(lock.packages), 'A version 3 npm lockfile is required');
  const entries = Object.entries(lock.packages);
  assert(entries.length <= 20_000 && object(lock.packages['']), 'Invalid npm lockfile entries');
  const expected = Object.fromEntries(spec.packages.map(item => [item.name, item.version]));
  assert(JSON.stringify(Object.entries(lock.packages[''].dependencies ?? {}).sort()) === JSON.stringify(Object.entries(expected).sort()), 'Lockfile root dependencies do not match the specification');
  for (const [path, item] of entries) {
    if (path === '') continue;
    assert(/^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/.test(path)
      && object(item) && !item.link && !item.inBundle && typeof item.version === 'string' && versionPattern.test(item.version), 'Non-registry or linked dependency is unsupported');
    let url; try { url = new URL(item.resolved); } catch { throw new Error('A registry tarball URL is required'); }
    assert(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.includes('/-/') && url.pathname.endsWith('.tgz'), 'Only public npm registry tarballs are permitted');
    assert(typeof item.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity), 'A SHA-512 package integrity hash is required');
  }
  for (const item of spec.packages) assert(lock.packages[`node_modules/${item.name}`]?.version === item.version, 'Direct package version differs from the specification');
  return lock;
}

/** No links, devices or unbounded trees can become an immutable bundle. */
export async function contentHash(root) {
  assert((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'Invalid environment root');
  root = await realpath(root);
  const hash = createHash('sha256'); let files = 0, bytes = 0;
  async function walk(folder, path = '') {
    for (const name of (await readdir(folder)).sort()) {
      if (!path && name === '.complete.json') continue;
      assert(!/[\x00-\x1f\x7f\\]/.test(name), 'Unsupported environment filename');
      const entry = join(folder, name), key = path ? `${path}/${name}` : name, stat = await lstat(entry);
      assert(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Environment links and special files are not permitted');
      assert(++files <= 100_000, 'Environment file count exceeds its limit');
      hash.update(bounded([key, stat.isDirectory() ? 'directory' : 'file', stat.isDirectory() ? 0 : stat.size, stat.mode & 0o111]));
      if (stat.isDirectory()) { await walk(entry, key); continue; }
      assert(stat.nlink === 1 && (bytes += stat.size) <= 2 * 1024 ** 3, 'Environment content exceeds its limit');
      const handle = await open(entry, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const checked = await handle.stat(); assert(checked.isFile() && checked.ino === stat.ino && checked.size === stat.size, 'Environment content changed');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      } finally { await handle.close(); }
    }
  }
  await walk(root); return hash.digest('hex');
}

export async function verifyBundle(root, spec, expected) {
  validateSpec(spec);
  const complete = JSON.parse((await plainFile(join(root, '.complete.json'), 16_384)).toString('utf8'));
  assert(complete.version === 1 && complete.specHash === specHash(spec), 'Completed bundle has a different specification');
  const lockContent = await plainFile(join(root, 'package-lock.json'));
  validateLockfile(JSON.parse(lockContent.toString('utf8')), spec);
  const lockfileHash = digest(lockContent), hash = await contentHash(root);
  assert(complete.lockfileHash === lockfileHash && complete.contentHash === hash, 'Completed environment content was modified');
  if (expected) assert(expected.lockfileHash === lockfileHash && expected.contentHash === hash, 'Selected environment hashes do not match');
  for (const item of spec.packages) {
    const pkg = JSON.parse((await plainFile(join(root, 'node_modules', item.name, 'package.json'))).toString('utf8'));
    assert(pkg.name === item.name && pkg.version === item.version, 'Installed package identity differs from the specification');
  }
  return { contentHash: hash, lockfileHash, packages: spec.packages };
}

export function npmArguments(command) {
  assert(command === 'install' || command === 'ci', 'Unsupported npm operation');
  return ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', command,
    ...(command === 'install' ? ['--package-lock-only'] : []), '--ignore-scripts', '--bin-links=false', '--audit=false', '--fund=false',
    '--update-notifier=false', '--registry=https://registry.npmjs.org/', '--cache=/tmp/npm-cache', '--userconfig=/dev/null', '--globalconfig=/app/npm-empty.npmrc',
    ...npmPolicies.map(name => `--${name}=none`),
    '--git=/bin/false', '--fetch-retries=0', '--fetch-timeout=30000'];
}
async function runNpm(root, command) {
  // Unknown npm options can merely warn. Fail before invoking an older resolver.
  assertNpmPolicyDefinitions(require('/usr/local/lib/node_modules/npm/node_modules/@npmcli/config/lib/definitions/index.js').definitions);
  const args = npmArguments(command);
  await new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', bytes = 0, failure;
    const fail = error => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error('npm installation timed out')), 300_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length; tail = (tail + chunk.toString('utf8')).slice(-2000);
      if (bytes > 4 * 1024 * 1024) fail(new Error('npm output limit exceeded'));
    });
    child.on('close', code => { clearTimeout(timer); failure ? reject(failure) : code === 0 ? resolveDone() : reject(new Error(`npm ${command} failed (${code}): ${tail}`)); });
  });
}

/** Interrupted partial directories are retained, not silently reused or deleted. */
export async function installBundle(workspace, spec, npm = runNpm) {
  validateSpec(spec); const root = join(workspace, 'environment');
  try {
    await lstat(join(root, '.complete.json'));
    return { ...await verifyBundle(root, spec), reused: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const stat = await lstat(root); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Existing environment path is not a directory');
    await rename(root, join(workspace, `environment-partial-${Date.now()}-${randomUUID()}`));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(root, { recursive: false });
  const manifest = { name: 'agent-company-environment', version: '1.0.0', private: true, dependencies: Object.fromEntries(spec.packages.map(item => [item.name, item.version])) };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
  await npm(root, 'install');
  const before = await plainFile(join(root, 'package-lock.json'));
  validateLockfile(JSON.parse(before.toString('utf8')), spec);
  await npm(root, 'ci');
  const after = await plainFile(join(root, 'package-lock.json'));
  assert(before.equals(after), 'npm changed the validated lockfile during installation');
  const lockfileHash = digest(after), hash = await contentHash(root);
  const complete = { version: 1, specHash: specHash(spec), contentHash: hash, lockfileHash };
  await writeFile(join(root, '.complete.json'), `${JSON.stringify(complete)}\n`, { flag: 'wx', mode: 0o444 });
  return { ...await verifyBundle(root, spec), reused: false };
}

async function executable(root, server) {
  const pkgRoot = join(root, 'node_modules', server.package), pkg = JSON.parse((await plainFile(join(pkgRoot, 'package.json'))).toString('utf8'));
  const bin = typeof pkg.bin === 'string' && server.bin === pkg.name.split('/').at(-1) ? pkg.bin : object(pkg.bin) ? pkg.bin[server.bin] : undefined;
  assert(typeof bin === 'string' && bin.length <= 1000 && !isAbsolute(bin) && !/[\x00-\x1f\x7f\\]/.test(bin), 'MCP executable must be declared by its package');
  const target = resolve(pkgRoot, bin); assert(inside(pkgRoot, target), 'MCP executable escapes its package');
  let current = pkgRoot;
  for (const part of relative(pkgRoot, target).split(sep)) { current = join(current, part); assert(!(await lstat(current)).isSymbolicLink(), 'MCP executable contains a link'); }
  assert((await lstat(target)).isFile(), 'MCP executable is not a file');
  // Run as an explicit Node entry, never through .bin, a shell or user arguments as Node options.
  return target;
}

/** One request-scoped legacy stdio session; no state is promised across calls. */
export async function callMcp(root, server, call, options = {}) {
  const target = await executable(root, server);
  const child = (options.spawn ?? spawn)(process.execPath, [target, ...server.args], {
    cwd: options.cwd ?? '/tmp', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let pending = '', total = 0, failure, stopped = false;
  const requests = new Map();
  const fail = error => { failure ??= error; for (const request of requests.values()) request.reject(failure); requests.clear(); child.kill('SIGKILL'); };
  const send = value => { if (failure) throw failure; child.stdin.write(`${bounded(value)}\n`); };
  const abort = () => fail(new Error('MCP operation was cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail(new Error('MCP request timed out')), options.timeoutMs ?? 30_000);
  const closed = new Promise(resolveDone => child.once('close', () => { stopped = true; if (requests.size) fail(new Error('MCP exited before completing its request')); resolveDone(); }));
  child.once('error', error => { fail(error); });
  child.stdin.on('error', error => { if (!stopped) fail(error); });
  child.stderr.on('data', chunk => { total += chunk.length; if (total > 1024 * 1024) fail(new Error('MCP output limit exceeded')); });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  child.stdout.on('data', chunk => {
    try {
      total += chunk.length; assert(total <= 1024 * 1024, 'MCP output limit exceeded'); pending += decoder.decode(chunk, { stream: true });
      assert(Buffer.byteLength(pending) <= 262_144, 'MCP frame limit exceeded');
      for (let index; (index = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1); if (!line.trim()) continue;
        const message = JSON.parse(line); assert(object(message) && message.jsonrpc === '2.0', 'Invalid MCP JSON-RPC message');
        if (typeof message.method === 'string') {
          // No sampling, elicitation, roots, subscriptions or reverse tool execution.
          if ('id' in message) {
            assert(typeof message.id === 'string' && message.id.length <= 100 || Number.isSafeInteger(message.id), 'Invalid reverse request ID');
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capabilities are not available' } });
          }
          continue;
        }
        assert(typeof message.id === 'string' && requests.has(message.id), 'Unmatched MCP response ID');
        const request = requests.get(message.id);
        assert(('error' in message) !== ('result' in message), 'Invalid MCP response shape');
        if ('error' in message) {
          const detail = bounded(message.error, 16_384); requests.delete(message.id);
          request.reject(new Error(`MCP rejected ${request.method}: ${detail}`));
        } else {
          assert(object(message.result), 'Invalid MCP result'); requests.delete(message.id); request.resolve(message.result);
        }
      }
    } catch (error) { fail(error); }
  });
  const request = (method, params = {}) => new Promise((resolveDone, reject) => {
    if (failure) { reject(failure); return; }
    const id = randomUUID(); requests.set(id, { method, resolve: resolveDone, reject });
    try { send({ jsonrpc: '2.0', id, method, params }); } catch (error) { requests.delete(id); reject(error); }
  });
  try {
    options.signal?.throwIfAborted();
    const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-company-environment', version: '1.0.0' } });
    assert(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(initialized.protocolVersion) && object(initialized.capabilities?.tools), 'MCP protocol or tools capability is unsupported');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = [], names = new Set(), cursors = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const listed = await request('tools/list', cursor ? { cursor } : {});
      assert(Array.isArray(listed.tools) && listed.tools.length + tools.length <= 100, 'MCP tool count exceeds its limit');
      for (const tool of listed.tools) {
        assert(object(tool) && typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= 100 && !names.has(tool.name)
          && object(tool.inputSchema) && tool.inputSchema.type === 'object' && (tool.description === undefined || typeof tool.description === 'string' && tool.description.length <= 4000), 'Invalid MCP tool declaration');
        names.add(tool.name); tools.push({ server: server.name, name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema });
      }
      if (listed.nextCursor === undefined) { cursor = undefined; break; }
      assert(typeof listed.nextCursor === 'string' && listed.nextCursor.length <= 1000 && !cursors.has(listed.nextCursor), 'Invalid MCP pagination');
      cursor = listed.nextCursor; cursors.add(cursor);
    }
    assert(!cursor, 'MCP pagination limit exceeded'); bounded(tools);
    assert(names.has(call.tool) && object(call.arguments), 'Requested tool is not declared by this MCP server'); bounded(call.arguments, 32_768);
    const result = await request('tools/call', { name: call.tool, arguments: call.arguments });
    assert(Array.isArray(result.content) && result.isError !== true, 'MCP tool probe/call returned an error'); bounded(result);
    if (failure) throw failure;
    return { tools, result, sessionMode: 'stateless-per-call' };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort); child.stdin.destroy();
    child.kill('SIGKILL'); await closed;
  }
}

async function main() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; assert(Buffer.byteLength(input) <= 512_000, 'Environment input exceeds its limit'); }
  const request = JSON.parse(input); validateSpec(request.spec);
  assert(typeof request.id === 'string' && /^[a-f0-9-]{36}$/i.test(request.id), 'Invalid environment request ID');
  let value;
  if (request.operation === 'install') value = await installBundle('/workspace', request.spec);
  else {
    const root = '/opt/agent-environment/environment';
    value = await verifyBundle(root, request.spec, request.expected);
    if (request.operation === 'call') {
      const server = request.spec.servers.find(item => item.name === request.call?.server); assert(server, 'MCP server is not selected');
      value = { ...value, ...await callMcp(root, server, request.call) };
    } else assert(request.operation === 'verify', 'Unsupported environment operation');
  }
  process.stdout.write(`${bounded({ id: request.id, value }, 512_000)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${String(error.message).slice(0, 3000)}\n`); process.exitCode = 1; });
}
