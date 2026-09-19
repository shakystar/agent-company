import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { command } from '../server/process.ts';

const helper = resolve('desktop/src-tauri/windows/payload-cleanup.mjs');
const data = Buffer.from('fixture release');
const pin = (path: string) => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
const manifest = (files: unknown[]) => JSON.stringify({ version: 1, protocol: 1, target: 'x86_64-pc-windows-msvc', files });
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'ac-payload-cleanup-'));
  t.after(async () => { assert.equal(dirname(base), resolve(tmpdir())); await rm(base, { recursive: true, force: true }); });
  const root = join(base, 'installed'); await mkdir(join(root, 'resources/dist/assets'), { recursive: true });
  const old = pin('resources/dist/assets/old.js'), next = pin('resources/dist/assets/new.js');
  await writeFile(join(root, old.path), data);
  await writeFile(join(root, 'payload-manifest.json'), manifest([old]));
  const candidate = join(base, 'candidate.json'); await writeFile(candidate, manifest([next]));
  const plan = join(root, 'payload-retirement.json');
  const run = (mode: string) => command(process.execPath, [helper, mode, root, candidate, plan]);
  const install = async () => { await writeFile(join(root, next.path), data); await writeFile(join(root, 'payload-manifest.json'), manifest([next])); };
  return { root, base, old, next, candidate, plan, run, install };
}
test('same-version installer retires obsolete owned files only after verifying new files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'resources/dist/assets/user-file.txt'), 'preserve unknown');
  await mkdir(join(f.root, 'credentials')); await writeFile(join(f.root, 'credentials/auth.json'), 'preserve account');
  assert.equal((await f.run('prepare')).code, 0);
  assert.deepEqual(await readFile(join(f.root, f.old.path)), data);
  await f.install(); assert.equal((await f.run('commit')).code, 0);
  await assert.rejects(lstat(join(f.root, f.old.path)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.root, f.next.path)), data);
  assert.equal(await readFile(join(f.root, 'credentials/auth.json'), 'utf8'), 'preserve account');
  assert.equal(await readFile(join(f.root, 'resources/dist/assets/user-file.txt'), 'utf8'), 'preserve unknown');
  await assert.rejects(lstat(f.plan), { code: 'ENOENT' });
});
for (const failure of ['new-file-missing', 'old-file-changed', 'candidate-changed', 'linked-asset-directory']) {
  test(`installer refuses ${failure} and retains retirement evidence`, async t => {
    const f = await fixture(t); assert.equal((await f.run('prepare')).code, 0); await f.install();
    if (failure === 'new-file-missing') await rm(join(f.root, f.next.path));
    if (failure === 'old-file-changed') await writeFile(join(f.root, f.old.path), 'edited');
    if (failure === 'candidate-changed') await writeFile(f.candidate, manifest([]));
    if (failure === 'linked-asset-directory') {
      const outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'old.js'), data); await writeFile(join(outside, 'new.js'), data);
      await rm(join(f.root, 'resources/dist/assets'), { recursive: true }); await symlink(outside, join(f.root, 'resources/dist/assets'), 'junction');
    }
    assert.equal((await f.run('commit')).code, 2);
    assert.ok(await lstat(join(f.root, f.old.path))); assert.ok(await lstat(f.plan));
  });
}
test('interrupted copy can retry the same candidate without losing old ownership', async t => {
  const f = await fixture(t); assert.equal((await f.run('prepare')).code, 0); await f.install();
  assert.equal((await f.run('prepare')).code, 0); assert.equal((await f.run('commit')).code, 0);
  await assert.rejects(lstat(join(f.root, f.old.path)), { code: 'ENOENT' });
});
test('installer accepts packaged dependency names with spaces, Unicode and punctuation', async t => {
  const f = await fixture(t);
  const names = ['snow \u2603/index.html', 'some thing.txt', '100%.txt', 'a .md', '[...]/a .md', 'dir with spaces/test-package.zip'];
  const old = names.map(name => pin(`resources/node_modules/old/${name}`));
  const next = names.map(name => pin(`resources/node_modules/new/${name}`));
  for (const file of old) { await mkdir(dirname(join(f.root, file.path)), { recursive: true }); await writeFile(join(f.root, file.path), data); }
  await writeFile(join(f.root, 'payload-manifest.json'), manifest(old));
  await writeFile(f.candidate, manifest(next));
  assert.equal((await f.run('prepare')).code, 0);
  for (const file of next) { await mkdir(dirname(join(f.root, file.path)), { recursive: true }); await writeFile(join(f.root, file.path), data); }
  await writeFile(join(f.root, 'payload-manifest.json'), manifest(next));
  assert.equal((await f.run('commit')).code, 0);
  for (const file of old) await assert.rejects(lstat(join(f.root, file.path)), { code: 'ENOENT' });
  for (const file of next) assert.deepEqual(await readFile(join(f.root, file.path)), data);
});

for (const path of ['resources/../outside', 'resources/credentials/auth.json', 'resources/.env', 'resources/dist/assets/OLD.js',
  'resources//empty', 'resources\\..\\outside', 'resources/file:stream', 'resources/CON.txt', 'resources/end./file',
  'resources/end /file', 'resources/wild*.txt', 'resources/control\u0001.txt']) {
  test(`installer rejects unsafe or ambiguous ownership ${path}`, async t => {
    const f = await fixture(t); await writeFile(join(f.root, 'payload-manifest.json'), manifest([f.old, pin(path)]));
    assert.equal((await f.run('prepare')).code, 2); assert.deepEqual(await readFile(join(f.root, f.old.path)), data);
    await assert.rejects(lstat(f.plan), { code: 'ENOENT' });
  });
}
