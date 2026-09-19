import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { desktopPaths, openDesktopInstallation } from '../server/desktop-paths.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, '설치 자원'), data = join(root, '사용자 데이터');
  await mkdir(join(resources, 'dist'), { recursive: true });
  await writeFile(join(resources, 'dist', 'index.html'), '<title>Desktop fixture</title>');
  return { root, resources, data, paths: desktopPaths(resources, data) };
}

test('desktop paths require explicit disjoint roots, including backup and resource separation', async t => {
  const f = await fixture(t);
  assert.throws(() => desktopPaths('.', f.data));
  assert.throws(() => desktopPaths(f.resources, join(f.resources, 'data')));
  assert.throws(() => desktopPaths(join(f.data, 'resource'), f.data));
  assert.equal(f.paths.backupDir, join(f.data, 'backups'));
  assert.equal(f.paths.dataDir, join(f.data, 'workspace'));
  assert.equal(f.paths.distDir, join(f.resources, 'dist'));
});

test('new installation preserves identity, rejects duplicate app/CLI writers and releases both leases', async t => {
  const f = await fixture(t);
  const first = await openDesktopInstallation(f.paths);
  try {
    await assert.rejects(openDesktopInstallation(f.paths), { code: 'ELOCKED' });
    await assert.rejects(lockfile.lock(f.paths.dataDir, { lockfilePath: join(f.paths.dataDir, 'controller.lock'), retries: 0 }), { code: 'ELOCKED' });
    assert.equal(await readFile(join(f.paths.dataDir, 'workspace-id'), 'utf8'), first.workspaceKey);
  } finally { await first.release(); }
  const second = await openDesktopInstallation(f.paths);
  try { assert.equal(second.workspaceKey, first.workspaceKey); }
  finally { await second.release(); }
  assert.ok(!(await readdir(f.data)).includes('desktop.lock'));
  assert.ok(!(await readdir(f.paths.dataDir)).includes('controller.lock'));
  assert.deepEqual(await readdir(f.resources), ['dist']);
});

test('existing developer data, corrupt identity and missing workspace identity are never adopted', async t => {
  const f = await fixture(t);
  await mkdir(f.data); await writeFile(join(f.data, '.env'), 'DO_NOT_LOAD=fixture');
  await assert.rejects(openDesktopInstallation(f.paths), /자동 선택/);
  assert.deepEqual(await readdir(f.data), ['.env']);
  const clean = desktopPaths(f.resources, join(f.root, 'fresh'));
  const installation = await openDesktopInstallation(clean); await installation.release();
  await writeFile(join(clean.dataDir, 'workspace-id'), '00000000-0000-4000-8000-000000000000');
  await assert.rejects(openDesktopInstallation(clean), /일치하지/);
  await rm(join(clean.dataDir, 'workspace-id'));
  await mkdir(join(clean.dataDir, 'db'));
  await assert.rejects(openDesktopInstallation(clean), /식별 파일이 없습니다/);
});
