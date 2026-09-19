import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { collectDesktopNpmNotices, inspectDesktopNodeNotices, writeDesktopNotices, type DesktopNoticeComponent } from '../scripts/desktop-notices.ts';
import nodeSource from '../desktop/providers/node/24.11.1/source.json' with { type: 'json' };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-notices-'));
  t.after(async () => { const path = relative(tmpdir(), root); assert.ok(path.startsWith('ac-desktop-notices-') && !isAbsolute(path) && !path.includes(sep));
    await rm(root, { recursive: true }); });
  const app = { name: 'fixture-app', version: '1.0.0', dependencies: { backend: '1.0.0', frontend: '2.0.0' } };
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: app.dependencies },
    'node_modules/backend': { version: '1.0.0', dependencies: { nested: '1.0.0' }, optionalDependencies: { absent: '1.0.0' }, integrity: 'sha512-fixture' },
    'node_modules/backend/node_modules/nested': { version: '1.0.0', integrity: 'sha512-fixture' },
    'node_modules/frontend': { version: '2.0.0', integrity: 'sha512-fixture' },
    'node_modules/unshipped-dev': { version: '1.0.0', dev: true, integrity: 'sha512-fixture' },
  } as Record<string, object> };
  const save = async () => { await writeFile(join(root, 'package.json'), JSON.stringify(app)); await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock)); };
  await save();
  for (const [path, spec] of Object.entries(lock.packages)) {
    if (!path) continue; await mkdir(join(root, path), { recursive: true });
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name, version: (spec as { version: string }).version, license: 'MIT' }));
    await writeFile(join(root, path, 'LICENSE'), `Copyright ${name}\nOriginal fixture license\n`);
  }
  return { root, app, lock, save };
}

test('notice collection follows locked backend and bundled frontend closures and preserves original nested documents', async t => {
  const f = await fixture(t);
  const notice = join(f.root, 'node_modules/frontend/notices/COPYRIGHT'); await mkdir(dirname(notice));
  await writeFile(notice, 'Unicode attribution 원문\n');
  await writeFile(join(dirname(notice), 'third-party.txt'), 'Additional license in attribution directory\n');
  const result = await collectDesktopNpmNotices(f.root);
  assert.deepEqual(result.components.map(component => component.name).sort(), ['backend', 'frontend', 'nested']);
  assert.deepEqual(result.skippedOptionalDependencies, ['absent']);
  assert.ok(result.components.every(component => component.issues.length === 0));
  assert.deepEqual(result.components.find(component => component.name === 'frontend')!.files.find(file => file.path === 'notices/COPYRIGHT')!.data,
    Buffer.from('Unicode attribution 원문\n'));
  assert.ok(result.components.find(component => component.name === 'frontend')!.files.some(file => file.path === 'notices/third-party.txt'));
  assert.ok(result.issues.length > 0, 'Collection must not pretend to verify upstream tarballs or native transitives');
  await result.assertUnchanged();
  assert.equal(JSON.stringify(result.components).includes(f.root), false);
});

test('changed locks, missing required packages, dev-only edges and version/name substitution fail before publishing notices', async t => {
  for (const kind of ['root-lock', 'missing', 'dev', 'version', 'name'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'root-lock') { f.app.dependencies.frontend = '9.0.0'; await writeFile(join(f.root, 'package.json'), JSON.stringify(f.app)); }
    if (kind === 'missing') await rm(join(f.root, 'node_modules/frontend/package.json'));
    if (kind === 'dev') { f.lock.packages['node_modules/frontend'] = { version: '2.0.0', dev: true }; await f.save(); }
    if (kind === 'version' || kind === 'name') await writeFile(join(f.root, 'node_modules/frontend/package.json'), JSON.stringify({
      name: kind === 'name' ? 'imposter' : 'frontend', version: kind === 'version' ? '9.0.0' : '2.0.0', license: 'MIT' }));
    await assert.rejects(collectDesktopNpmNotices(f.root)); assert.equal((await readdir(f.root)).includes('notices'), false);
  });
});

test('missing and empty documents remain explicit incomplete collection issues', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'node_modules/frontend/LICENSE'));
  await writeFile(join(f.root, 'node_modules/backend/LICENSE'), '');
  const result = await collectDesktopNpmNotices(f.root);
  assert.match(result.components.find(component => component.name === 'frontend')!.issues.join(' '), /No license/);
  assert.match(result.components.find(component => component.name === 'backend')!.issues.join(' '), /empty/);
  const out = join(f.root, 'notices'); const written = await writeDesktopNotices(out, result.components, result.issues);
  assert.equal(written.documentsComplete, false);
  assert.equal(JSON.parse(await readFile(join(out, 'inventory.json'), 'utf8')).distributionReady, false);
});

test('document hard links, invalid text and oversized input fail rather than publishing misleading notices', async t => {
  for (const kind of ['hardlink', 'utf8', 'size'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub), file = join(f.root, 'node_modules/frontend/LICENSE');
    if (kind === 'hardlink') await link(file, join(f.root, 'other-reference'));
    if (kind === 'utf8') await writeFile(file, Buffer.from([0xff]));
    if (kind === 'size') await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(collectDesktopNpmNotices(f.root));
  });
});

test('collection receipts detect metadata and notice edits before a later payload write', async t => {
  for (const name of ['package-lock.json', 'node_modules/frontend/package.json', 'node_modules/frontend/LICENSE']) await t.test(name, async sub => {
    const f = await fixture(sub), result = await collectDesktopNpmNotices(f.root);
    await writeFile(join(f.root, name), 'changed'); await assert.rejects(result.assertUnchanged());
  });
});

test('notice writer inventories original bytes, preserves existing output and rejects ambiguous document names', async t => {
  const f = await fixture(t), component: DesktopNoticeComponent = { id: 'fixture', name: 'Fixture', version: '1.0.0', ecosystem: 'fixture',
    license: 'MIT', source: 'public-fixture', files: [{ path: 'LICENSE', data: Buffer.from('\ufeffOriginal license 원문\r\n') }], issues: [] };
  const output = join(f.root, 'notices'), result = await writeDesktopNotices(output, [component], []);
  const inventory = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'));
  assert.equal(inventory.components[0].files[0].sha256, createHash('sha256').update(component.files[0].data).digest('hex'));
  assert.ok((await readFile(join(output, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).includes(component.files[0].data.toString('utf8')));
  assert.equal(result.documentsComplete, true); assert.equal(inventory.distributionReady, false);
  const empty = await writeDesktopNotices(join(f.root, 'empty'), [{ ...component, files: [{ path: 'LICENSE', data: Buffer.alloc(0) }] }], []);
  assert.equal(empty.documentsComplete, false);
  const original = await readFile(join(output, 'inventory.json'));
  await assert.rejects(writeDesktopNotices(output, [component], [])); assert.deepEqual(await readFile(join(output, 'inventory.json')), original);
  for (const path of ['../LICENSE', '/LICENSE', 'C:/LICENSE', 'folder\\LICENSE', 'LICENSE\nother']) {
    await assert.rejects(writeDesktopNotices(join(f.root, 'rejected'), [{ ...component, files: [{ path, data: Buffer.from('fixture') }] }], []));
  }
  await assert.rejects(writeDesktopNotices(join(f.root, 'rejected'), [component, component], []));
  await assert.rejects(writeDesktopNotices(join(f.root, 'rejected'), [{ ...component, files: [...component.files, { path: 'license', data: Buffer.from('duplicate') }] }], []));
  assert.equal((await readdir(f.root)).includes('rejected'), false);
});

test('a different executable cannot borrow the pinned official Node license/source record', async t => {
  const f = await fixture(t), path = join(f.root, 'node.exe'); await writeFile(path, 'not the official executable');
  await assert.rejects(inspectDesktopNodeNotices(path, f.root), { message: 'DESKTOP_NODE_SOURCE_MISMATCH' });
});

test('official Node input publishes only the pinned license snapshot and detects later document changes', async t => {
  if (process.platform !== 'win32' || process.arch !== 'x64'
    || createHash('sha256').update(await readFile(process.execPath)).digest('hex') !== nodeSource.executable.sha256) {
    t.skip('Requires the pinned official Node 24.11.1 Windows x64 input; no binary is downloaded.'); return;
  }
  const f = await fixture(t), directory = join(f.root, 'desktop/providers/node/24.11.1');
  await mkdir(directory, { recursive: true });
  const original = await readFile(new URL('../desktop/providers/node/24.11.1/LICENSE', import.meta.url));
  await writeFile(join(directory, 'LICENSE'), original);
  await writeFile(join(directory, 'SHASUMS256.txt'), await readFile(new URL('../desktop/providers/node/24.11.1/SHASUMS256.txt', import.meta.url)));
  const result = await inspectDesktopNodeNotices(process.execPath, f.root);
  assert.deepEqual(result.component.files[0].data, original);
  await result.assertUnchanged();
  await writeFile(join(directory, 'LICENSE'), 'Replaced source notice');
  await assert.rejects(result.assertUnchanged());
  await assert.rejects(inspectDesktopNodeNotices(process.execPath, f.root), { message: 'DESKTOP_NODE_SOURCE_MISMATCH' });
});
