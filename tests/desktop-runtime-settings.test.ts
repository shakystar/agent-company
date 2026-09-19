import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { desktopRuntimeSettings, type DesktopRuntimeSelection } from '../server/desktop-runtime-settings.ts';

const selection: DesktopRuntimeSelection = { kind: 'wsl-docker', wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu-22.04', model: 'gpt-6-astra' };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-settings-')), owner = randomUUID();
  t.after(async () => { const location = relative(tmpdir(), root);
    assert.ok(location.startsWith('ac-desktop-settings-') && !isAbsolute(location) && !location.includes(sep)); await rm(root, { recursive: true }); });
  await writeFile(join(root, 'desktop-installation.json'), JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: owner }));
  return { root, owner, path: join(root, 'desktop-runtime.json'), marker: join(root, 'desktop-runtime-configured.json'),
    store: desktopRuntimeSettings(root, owner) };
}
const configured = (workspaceKey: string) => ({ version: 1, product: 'agent-company-desktop-runtime-configured', workspaceKey });
const legacy = (workspaceKey: string) => ({ version: 1, product: 'agent-company-desktop-runtime', workspaceKey, revision: 7, selection });
test('fresh settings do not adopt host defaults and explicit selection survives a reopened store', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.read(), { revision: 0, selection: null });
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
  const saved = await f.store.save(selection, 0);
  assert.deepEqual(saved, { revision: 1, selection });
  assert.deepEqual(JSON.parse(await readFile(f.marker, 'utf8')), configured(f.owner));
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).version, 2);
  saved.selection!.model = 'changed-local-copy';
  assert.deepEqual(await desktopRuntimeSettings(f.root, f.owner).read(), { revision: 1, selection });
  await assert.rejects(f.store.save({ ...selection, model: 'another' }, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_STALE' });
  assert.equal((await f.store.read()).selection!.model, selection.model);
});
test('wrong installation ownership and unknown credential fields are never persisted', async t => {
  const f = await fixture(t);
  await assert.rejects(desktopRuntimeSettings(f.root, randomUUID()).read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  await assert.rejects(f.store.save({ ...selection, apiKey: 'PRIVATE_SENTINEL' } as DesktopRuntimeSelection, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  assert.deepEqual(await f.store.read(), { revision: 0, selection: null });
  for (const change of [{ wslExecutable: 'wsl.exe' }, { wslExecutable: 'C:\\x\\..\\wsl.exe' }, { distro: '--exec' }, { model: 'model\nkey' }]) {
    await assert.rejects(f.store.save({ ...selection, ...change }, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  }
});
test('null, oversized, damaged UTF-8, foreign and hard-linked settings fail closed and remain untouched', async t => {
  const f = await fixture(t);
  for (const value of ['null', '{', 'x'.repeat(16_385), Buffer.from([0xff]), JSON.stringify({ version: 1, product: 'agent-company-desktop-runtime',
    workspaceKey: randomUUID(), revision: 1, selection })]) {
    await writeFile(f.path, value);
    await assert.rejects(f.store.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
    await assert.rejects(f.store.save(selection, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
    assert.deepEqual(await readFile(f.path), Buffer.from(value));
  }
  await rm(f.path); await f.store.save(selection, 0);
  const alias = join(f.root, 'alias.json'); await link(f.path, alias);
  await assert.rejects(f.store.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
});
test('concurrent settings writes cannot overwrite one another with the same revision', async t => {
  const f = await fixture(t);
  const first = f.store.save(selection, 0);
  await assert.rejects(f.store.save({ ...selection, distro: 'Other' }, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_BUSY' });
  await first; assert.equal((await f.store.read()).selection!.distro, selection.distro);
});

test('configured installation never becomes fresh after settings loss across store restart', async t => {
  const f = await fixture(t); await f.store.save(selection, 0);
  const marker = await readFile(f.marker); await rm(f.path);
  const reopened = desktopRuntimeSettings(f.root, f.owner);
  await assert.rejects(reopened.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  await assert.rejects(reopened.save(selection, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  assert.deepEqual(await readFile(f.marker), marker);
  assert.ok(!(await readdir(f.root)).includes('desktop-runtime.json'));
});

test('marker loss is rejected for new settings and is never silently repaired', async t => {
  const f = await fixture(t); await f.store.save(selection, 0);
  const contents = await readFile(f.path); await rm(f.marker);
  const reopened = desktopRuntimeSettings(f.root, f.owner);
  await assert.rejects(reopened.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  await assert.rejects(reopened.save(selection, 1), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  assert.deepEqual(await readFile(f.path), contents);
  assert.ok(!(await readdir(f.root)).includes('desktop-runtime-configured.json'));
});

test('marker-only or interrupted marker creation remains blocked without recreating settings', async t => {
  const f = await fixture(t);
  // Durable states left by a stop before settings commit, including a partial marker write.
  for (const content of [JSON.stringify(configured(f.owner)), '', '{"version":1']) {
    await writeFile(f.marker, content);
    const reopened = desktopRuntimeSettings(f.root, f.owner);
    await assert.rejects(reopened.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
    await assert.rejects(reopened.save(selection, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
    assert.equal(await readFile(f.marker, 'utf8'), content);
    assert.ok(!(await readdir(f.root)).includes('desktop-runtime.json'));
  }
});

test('legacy settings migrate only after an owned marker is stored, preserving selection and revision', async t => {
  const f = await fixture(t); await writeFile(f.path, JSON.stringify(legacy(f.owner)));
  assert.deepEqual(await f.store.read(), { revision: 7, selection });
  assert.deepEqual(JSON.parse(await readFile(f.marker, 'utf8')), configured(f.owner));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { ...legacy(f.owner), version: 2 });
  const marker = await lstat(f.marker, { bigint: true }), contents = await readFile(f.marker);
  const reopened = desktopRuntimeSettings(f.root, f.owner);
  assert.deepEqual(await reopened.read(), { revision: 7, selection });
  assert.deepEqual(await reopened.save({ ...selection, model: 'another-model' }, 7), {
    revision: 8, selection: { ...selection, model: 'another-model' },
  });
  const after = await lstat(f.marker, { bigint: true });
  assert.equal(after.ino, marker.ino); assert.equal(after.mtimeNs, marker.mtimeNs);
  assert.deepEqual(await readFile(f.marker), contents);
});

test('interrupted legacy migration with its marker can finish without advancing revision', async t => {
  const f = await fixture(t); await writeFile(f.path, JSON.stringify(legacy(f.owner)));
  await writeFile(f.marker, JSON.stringify(configured(f.owner)));
  const marker = await readFile(f.marker);
  assert.deepEqual(await desktopRuntimeSettings(f.root, f.owner).read(), { revision: 7, selection });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).version, 2);
  assert.deepEqual(await readFile(f.marker), marker);
  await rm(f.path);
  await assert.rejects(desktopRuntimeSettings(f.root, f.owner).read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
});

test('invalid, foreign, unknown and overlong markers never replace or adopt existing settings', async t => {
  const f = await fixture(t); await writeFile(f.path, JSON.stringify(legacy(f.owner)));
  const contents = await readFile(f.path);
  for (const content of ['null', '{', 'x'.repeat(16_385), Buffer.from([0xff]),
    JSON.stringify(configured(randomUUID())), JSON.stringify({ ...configured(f.owner), version: 2 }),
    JSON.stringify({ ...configured(f.owner), redirect: 'PRIVATE_SENTINEL' })]) {
    await writeFile(f.marker, content);
    const reopened = desktopRuntimeSettings(f.root, f.owner);
    await assert.rejects(reopened.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID', message: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
    await assert.rejects(reopened.save(selection, 7), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
    assert.deepEqual(await readFile(f.marker), Buffer.from(content));
    assert.deepEqual(await readFile(f.path), contents);
  }
});

test('hard-linked, directory and redirected markers are rejected without following them', async t => {
  const f = await fixture(t); await f.store.save(selection, 0);
  const alias = join(f.root, 'marker-alias.json'); await link(f.marker, alias);
  await assert.rejects(f.store.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  await rm(f.marker); await mkdir(f.marker);
  await assert.rejects(f.store.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  await rm(f.marker, { recursive: true });
  const target = join(f.root, 'marker-target'); await mkdir(target);
  await symlink(target, f.marker, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  assert.deepEqual(await readdir(target), []);
});

test('stale legacy save does not migrate or create a configured marker', async t => {
  const f = await fixture(t); await writeFile(f.path, JSON.stringify(legacy(f.owner)));
  const contents = await readFile(f.path);
  await assert.rejects(f.store.save(selection, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_STALE' });
  assert.deepEqual(await readFile(f.path), contents);
  assert.ok(!(await readdir(f.root)).includes('desktop-runtime-configured.json'));
  assert.deepEqual(await f.store.save(selection, 7), { revision: 8, selection });
  assert.deepEqual(JSON.parse(await readFile(f.marker, 'utf8')), configured(f.owner));
});

test('runtime remnant blocks a fresh installation when both settings and marker are missing', async t => {
  const f = await fixture(t), runtime = join(f.root, 'runtime');
  await mkdir(runtime);
  await assert.rejects(f.store.read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  await assert.rejects(f.store.save(selection, 0), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  assert.deepEqual(await readdir(runtime), []);
  await rm(runtime, { recursive: true }); await writeFile(runtime, 'PRIVATE_SENTINEL');
  await assert.rejects(desktopRuntimeSettings(f.root, f.owner).read(), { code: 'DESKTOP_RUNTIME_SETTINGS_INVALID' });
  assert.equal(await readFile(runtime, 'utf8'), 'PRIVATE_SENTINEL');
  assert.deepEqual((await readdir(f.root)).sort(), ['desktop-installation.json', 'runtime']);
});
