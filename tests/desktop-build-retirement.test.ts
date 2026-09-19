import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { retireDesktopCompilerPayload } from '../scripts/desktop-build-retirement.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-build-retirement-'));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const payload = join(root, 'payload'), compiled = join(root, 'target/x86_64-pc-windows-msvc/release');
  const paths = ['resources/server/desktop-entry.js', 'resources/dist/index.html', 'binaries/node-x86_64-pc-windows-msvc.exe'];
  const data = Buffer.from('verified fixture payload');
  for (const path of paths) { await mkdir(dirname(join(payload, path)), { recursive: true }); await writeFile(join(payload, path), data); }
  const files = paths.map(path => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }));
  await writeFile(join(payload, 'payload-manifest.json'), JSON.stringify({ version: 1, protocol: 1, target: 'x86_64-pc-windows-msvc', entry: paths[0], distributionReady: false, files }));
  await cp(payload, compiled, { recursive: true });
  await writeFile(join(root, 'installer-manifest.json'), 'keep receipt');
  await mkdir(join(compiled, 'bundle/nsis'), { recursive: true }); await writeFile(join(compiled, 'bundle/nsis/setup.exe'), 'keep setup');
  return { root, payload, compiled, paths, data };
}

test('completed build retires only byte-identical compiler resources and supports a no-op retry', async t => {
  const f = await fixture(t), result = await retireDesktopCompilerPayload(f.root);
  assert.equal(result.files, 3); assert.equal(result.bytes, f.data.length * 3);
  for (const path of f.paths) { assert.deepEqual(await readFile(join(f.payload, path)), f.data); await assert.rejects(lstat(join(f.compiled, path)), { code: 'ENOENT' }); }
  assert.equal(await readFile(join(f.compiled, 'bundle/nsis/setup.exe'), 'utf8'), 'keep setup');
  assert.equal(await readFile(join(f.root, 'installer-manifest.json'), 'utf8'), 'keep receipt');
  assert.equal((await retireDesktopCompilerPayload(f.root)).files, 0);
});

for (const failure of ['compiled-change', 'retained-change', 'extra-file', 'missing-retained', 'linked-directory']) {
  test(`compiler retirement refuses ${failure} before deleting any valid member`, async t => {
    const f = await fixture(t), path = f.paths[2];
    if (failure === 'compiled-change') await writeFile(join(f.compiled, path), 'changed');
    if (failure === 'retained-change') await writeFile(join(f.payload, path), 'changed');
    if (failure === 'extra-file') await writeFile(join(f.compiled, 'resources/unknown'), 'preserve');
    if (failure === 'missing-retained') await rm(join(f.payload, path));
    if (failure === 'linked-directory') {
      const directory = join(f.compiled, 'binaries'); await rm(directory, { recursive: true });
      await symlink(join(f.payload, 'binaries'), directory, 'junction');
    }
    await assert.rejects(retireDesktopCompilerPayload(f.root));
    assert.deepEqual(await readFile(join(f.compiled, f.paths[0])), f.data);
    assert.equal(await readFile(join(f.compiled, 'bundle/nsis/setup.exe'), 'utf8'), 'keep setup');
  });
}
