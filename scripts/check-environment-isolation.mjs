// Root-run, no-model check. Run the existing image with --network=none,
// --read-only, --cap-drop=ALL, --security-opt=no-new-privileges:true,
// --user=1000:1000, /tmp tmpfs, this script mounted read-only, and only the
// selected bundle mounted read-only at /opt/agent-environment.
// Stdin: { spec, expected: EnvironmentBuildReport }. No credentials are read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { callMcp, validateSpec, verifyBundle } from '/app/environment.mjs';

let serialized = '';
for await (const chunk of process.stdin) {
  serialized += chunk;
  assert.ok(Buffer.byteLength(serialized) <= 512_000, 'Verification input exceeds its limit');
}
const input = JSON.parse(serialized), spec = validateSpec(input.spec);
assert.match(input.expected?.contentHash ?? '', /^[a-f0-9]{64}$/);
assert.match(input.expected?.lockfileHash ?? '', /^[a-f0-9]{64}$/);
const root = '/opt/agent-environment/environment';
const checks = [], childChecks = [];
const passed = (name, detail) => checks.push({ name, passed: true, detail });

assert.equal(process.getuid(), 1000, 'Isolation check must run as the worker user');
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m, 'The helper retains Linux capabilities');
assert.match(status, /^NoNewPrivs:\s+1$/m, 'no-new-privileges is not enabled');
passed('non-root-no-capabilities', 'uid=1000, CapEff=0, NoNewPrivs=1');

const mountText = await readFile('/proc/self/mountinfo', 'utf8');
assert.ok(Buffer.byteLength(mountText) <= 1024 * 1024, 'Mount inventory exceeds its limit');
const decode = path => path.replace(/\\([0-7]{3})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));
const mounts = mountText.trim().split('\n').map(line => {
  const fields = line.split(' - ')[0].split(' ');
  assert.ok(fields.length >= 6, 'Invalid mount record');
  return { path: decode(fields[4]), options: fields[5].split(',') };
});
const bundleMount = mounts.find(mount => mount.path === '/opt/agent-environment');
assert.ok(bundleMount?.options.includes('ro'), 'Bundle mount is not read-only; no write probe was attempted');
assert.ok(mounts.filter(mount => mount.path.startsWith('/opt/agent-environment/')).every(mount => mount.options.includes('ro')), 'A nested bundle mount is writable');
assert.ok(mounts.find(mount => mount.path === '/')?.options.includes('ro'), 'Container root filesystem is writable');
assert.ok(!mounts.some(mount => mount.path === '/workspace' || mount.path.startsWith('/workspace/') || mount.path === '/credentials'
  || mount.path.startsWith('/credentials/') || mount.path === '/home/node/.codex' || mount.path.startsWith('/home/node/.codex/')), 'User workspace or credentials were mounted');
passed('mount-boundaries', 'Bundle and root filesystem are read-only; no workspace or credential mounts');

const verified = await verifyBundle(root, spec, input.expected);
passed('bundle-integrity-before', 'Selected lockfile and content SHA-256 match');
assert.deepEqual(await readdir('/workspace'), [], 'The image workspace contains user files');
for (const path of ['/home/node/.codex/auth.json', '/home/node/.codex/config.toml', '/credentials', '/workspace/.agent', '/workspace/.agent-runtime']) {
  await assert.rejects(lstat(path), error => error.code === 'ENOENT', 'An authentication or user-state path is present');
}
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AGENT_SECRET_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH']) {
  assert.equal(process.env[key], undefined, 'A credential or execution override was injected');
}
passed('no-auth-or-user-files', 'Known credential paths are absent and /workspace is empty');

// mountinfo is checked before opening a unique path, so a wrongly RW-mounted
// real bundle is never modified merely to discover that it was writable.
const probe = join(root, `.isolation-readonly-${randomUUID()}`);
await assert.rejects(async () => { const handle = await open(probe, 'wx', 0o600); await handle.close(); },
  error => ['EROFS', 'EACCES'].includes(error.code), 'Bundle write unexpectedly succeeded');
await assert.rejects(lstat(probe), error => error.code === 'ENOENT', 'Read-only probe left a file in the bundle');
passed('bundle-write-denied', 'Unique create denied with EROFS/EACCES after read-only mount verification');

const networkCode = await new Promise((done, reject) => {
  const socket = connect({ host: '1.1.1.1', port: 443 });
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('Network timeout is not proof of network isolation')); }, 3000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('External network connection unexpectedly succeeded')); });
  socket.once('error', error => {
    clearTimeout(timer); socket.destroy();
    if (['ENETUNREACH', 'EACCES'].includes(error.code)) done(error.code);
    else reject(new Error(`Unexpected network error is not proof of isolation: ${error.code}`));
  });
});
passed('external-network-denied', networkCode);

const expectedEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' };
const observedSpawn = (file, args, options) => {
  assert.equal(file, process.execPath, 'MCP is not launched through the explicit Node executable');
  assert.deepEqual(options.env, expectedEnv, 'MCP launch inherits extra environment variables');
  assert.equal(options.cwd, '/tmp', 'MCP can access a user working directory');
  const child = spawn(file, args, options);
  assert.ok(Number.isSafeInteger(child.pid), 'MCP process did not start');
  // Only this newly launched, credential-free child is inspected. No host or
  // unrelated process environment is read or printed.
  const checked = readFile(`/proc/${child.pid}/environ`).then(buffer => {
    assert.ok(buffer.length <= 16_384, 'MCP environment exceeds its limit');
    const entries = buffer.toString('utf8').split('\0').filter(Boolean).map(entry => {
      const index = entry.indexOf('='); assert.ok(index > 0, 'Invalid child environment entry');
      return [entry.slice(0, index), entry.slice(index + 1)];
    });
    assert.equal(entries.length, 3, 'Actual MCP process inherited extra environment variables');
    assert.deepEqual(Object.fromEntries(entries), expectedEnv, 'Actual MCP environment differs from its clean launch environment');
  });
  // Keep the assertion for the awaited result without an unhandled rejection
  // while the independent MCP protocol exchange is still running.
  checked.catch(() => {}); childChecks.push(checked);
  return child;
};
for (const server of spec.servers) {
  // Use the already validated declaration's probe, not a tool guessed from a
  // description. This exercises the real MCP child and its exact environment.
  const result = await callMcp(root, server, server.probe, { spawn: observedSpawn });
  assert.equal(result.sessionMode, 'stateless-per-call');
  await Promise.all(childChecks);
  passed(`mcp-child:${server.name}`, `initialize, tools/list and ${server.probe.tool} completed; actual child env contains only PATH/HOME/TMPDIR`);
}
if (!spec.servers.length) checks.push({ name: 'mcp-child-environment', passed: null, detail: 'No MCP server is registered in this bundle' });
await verifyBundle(root, spec, input.expected);
passed('bundle-integrity-after', 'Bundle unchanged after write denial and MCP probes');
const report = { modelCalls: 0, contentHash: verified.contentHash, lockfileHash: verified.lockfileHash, checks };
const output = JSON.stringify(report);
assert.ok(Buffer.byteLength(output) <= 32_768, 'Verification report exceeds its limit');
process.stdout.write(`${output}\n`);
