// Root-run, no-model integration check. Mount this file read-only in the worker
// image and execute with --network=none, no workspace/auth mounts and /tmp tmpfs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { npmArguments, assertNpmPolicyDefinitions } from '/app/environment.mjs';

const require = createRequire(import.meta.url);
assertNpmPolicyDefinitions(require('/usr/local/lib/node_modules/npm/node_modules/@npmcli/config/lib/definitions/index.js').definitions);
const npmVersion = require('/usr/local/lib/node_modules/npm/package.json').version;
const root = await mkdtemp('/tmp/agent-company-npm-policy-');
let forbiddenRequests = 0, metadataRequests = 0;
let origin;
const registry = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/policy-parent') {
    metadataRequests++;
    response.end(JSON.stringify({ name: 'policy-parent', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {
      name: 'policy-parent', version: '1.0.0', dependencies: { 'forbidden-child': `${origin}/forbidden.tgz` },
      dist: { tarball: `${origin}/policy-parent/-/policy-parent-1.0.0.tgz`, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
    } } }));
  } else { forbiddenRequests++; response.statusCode = 500; response.end(JSON.stringify({ error: 'This URL must never be fetched' })); }
});
await new Promise((done, reject) => { registry.once('error', reject); registry.listen(0, '127.0.0.1', done); });
origin = `http://127.0.0.1:${registry.address().port}`;
const cases = [
  { name: 'direct-url', dependency: `${origin}/forbidden.tgz`, code: 'EALLOWREMOTE' },
  { name: 'transitive-url', dependency: '1.0.0', package: 'policy-parent', code: 'EALLOWREMOTE' },
  { name: 'git', dependency: `git+${origin}/forbidden.git`, code: 'EALLOWGIT' },
  { name: 'file', dependency: 'file:/tmp/forbidden.tgz', code: 'EALLOWFILE' },
  { name: 'directory', dependency: 'file:/tmp/forbidden-directory', code: 'EALLOWDIRECTORY' },
];
const results = [];
try {
  for (const item of cases) {
    const cwd = join(root, item.name); await mkdir(cwd);
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'owned-policy-check', version: '1.0.0', private: true, dependencies: { [item.package ?? 'forbidden-child']: item.dependency } }));
    const args = npmArguments('install').map(arg => arg.startsWith('--registry=') ? `--registry=${origin}/` : arg.startsWith('--cache=') ? `--cache=${cwd}/cache` : arg);
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; if (output.length > 1_000_000) child.kill('SIGKILL'); });
      child.on('close', code => { clearTimeout(timer); done({ code, output }); });
    });
    assert.notEqual(result.code, 0, `${item.name} unexpectedly installed`);
    assert.match(result.output, new RegExp(item.code), `${item.name} was not rejected at its policy boundary`);
    assert.equal(forbiddenRequests, 0, `${item.name} fetched a forbidden URL before failing`);
    try {
      const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
      assert.ok(!lock.packages?.['node_modules/forbidden-child']);
      assert.ok(Object.values(lock.packages ?? {}).every(pkg => pkg.resolved !== `${origin}/forbidden.tgz`));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    results.push({ name: item.name, passed: true, code: item.code, forbiddenRequests });
  }
  assert.ok(metadataRequests > 0, 'Transitive dependency resolution was not exercised');
  process.stdout.write(`${JSON.stringify({ npmVersion, network: 'none', metadataRequests, forbiddenRequests, cases: results })}\n`);
} finally { await new Promise(done => registry.close(done)); }
