import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createDesktopImageJournal, DesktopImageJournalError, openDesktopImageJournal } from '../server/desktop-image-journal.ts';

const journalName = 'desktop-image-install.pending.json';
const selection = () => ({ kind: 'wsl-docker' as const, wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu-24.04', model: 'gpt-5.4' });
const images = [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`];
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const error = (suffix: string) => (value: unknown) => {
  assert.ok(value instanceof DesktopImageJournalError);
  assert.equal(value.code, `DESKTOP_IMAGE_JOURNAL_${suffix}`);
  assert.equal(value.message, value.code); assert.equal(value.cause, undefined);
  return true;
};
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'ac-desktop-image-journal-')), root = join(base, 'app-data');
  await mkdir(root); const path = join(root, journalName), ownerKey = randomUUID();
  const document = () => ({ version: 1, ownerKey, selection: selection(), images: [...images] });
  t.after(async () => {
    const location = relative(tmpdir(), base);
    assert.ok(location.startsWith('ac-desktop-image-journal-') && !isAbsolute(location) && !location.includes(sep));
    await rm(base, { recursive: true });
  });
  return { base, root, path, ownerKey, document,
    open: () => openDesktopImageJournal(root, ownerKey),
    create: () => createDesktopImageJournal(root, ownerKey, selection(), images) };
}

test('absent journal is read-only, while missing roots and invalid owners fail closed', async t => {
  const f = await fixture(t);
  assert.equal(await f.open(), null); assert.deepEqual(await readdir(f.root), []);
  await assert.rejects(openDesktopImageJournal(f.root, 'not-an-owner'), error('INVALID'));
  await assert.rejects(openDesktopImageJournal(join(f.base, 'missing'), f.ownerKey), error('INVALID'));
  assert.deepEqual(await readdir(f.root), []);
});

test('legacy v1 one/two-image journals retain full byte fingerprints and frozen snapshots', async t => {
  const f = await fixture(t);
  for (const count of [1, 2]) {
    const document = { ...f.document(), images: images.slice(0, count) };
    const data = ` \r\n${JSON.stringify(document, null, 2)}\n `;
    await writeFile(f.path, data);
    const receipt = await f.open(); assert.ok(receipt);
    assert.equal(receipt.fingerprint, hash(data)); assert.notEqual(receipt.fingerprint, hash(JSON.stringify(document)));
    assert.deepEqual(receipt.selection, document.selection); assert.deepEqual(receipt.images, document.images);
    assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.selection)); assert.ok(Object.isFrozen(receipt.images));
    assert.throws(() => { (receipt.selection as { model: string }).model = 'changed'; }, TypeError);
    assert.throws(() => { (receipt.images as string[]).push(images[0]); }, TypeError);
    await receipt.assertUnchanged(); assert.equal(await readFile(f.path, 'utf8'), data);
    await receipt.clear(); assert.equal(await f.open(), null);
  }
});

test('exclusive creation snapshots caller input and survives reopen before owned clear', async t => {
  const f = await fixture(t), input = selection(), inputImages = [...images];
  const creating = createDesktopImageJournal(f.root, f.ownerKey, input, inputImages);
  input.model = 'mutated'; inputImages[0] = `sha256:${'c'.repeat(64)}`;
  const created = await creating, data = await readFile(f.path);
  assert.deepEqual(JSON.parse(data.toString()), f.document());
  assert.equal(created.fingerprint, hash(data)); assert.equal(created.selection.model, 'gpt-5.4');
  assert.deepEqual(created.images, images); assert.deepEqual(Object.keys(created).sort(), ['assertUnchanged', 'clear', 'fingerprint', 'images', 'selection']);
  const reopened = await f.open(); assert.ok(reopened); assert.equal(reopened.fingerprint, created.fingerprint);
  await reopened.assertUnchanged(); await created.clear();
  assert.equal(await f.open(), null);
  await assert.rejects(created.clear(), error('CHANGED'));
  await assert.rejects(created.assertUnchanged(), error('CHANGED'));
  await assert.rejects(reopened.clear(), error('CHANGED'));
});

test('concurrent creators admit one writer and preserve existing damaged or foreign records', async t => {
  const f = await fixture(t), attempts = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  for (const attempt of attempts) if (attempt.status === 'rejected') error('EXISTS')(attempt.reason);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.document());
  for (const data of ['{', JSON.stringify({ ...f.document(), ownerKey: randomUUID() })]) {
    await writeFile(f.path, data);
    await assert.rejects(f.create(), error('EXISTS'));
    assert.equal(await readFile(f.path, 'utf8'), data);
  }
});

test('invalid create inputs never create a pending record', async t => {
  const f = await fixture(t);
  const cases = [
    { owner: 'invalid', selection: selection(), images },
    { owner: f.ownerKey, selection: { ...selection(), distro: '../Ubuntu' }, images },
    { owner: f.ownerKey, selection: { ...selection(), wslExecutable: 'wsl.exe' }, images },
    { owner: f.ownerKey, selection: { ...selection(), model: '' }, images },
    { owner: f.ownerKey, selection: selection(), images: [] },
    { owner: f.ownerKey, selection: selection(), images: [...images, images[0]] },
    { owner: f.ownerKey, selection: selection(), images: [images[0], images[0]] },
    { owner: f.ownerKey, selection: selection(), images: ['sha256:bad'] },
  ];
  for (const input of cases) {
    await assert.rejects(createDesktopImageJournal(f.root, input.owner, input.selection, input.images), error('INVALID'));
    assert.deepEqual(await readdir(f.root), []);
  }
});

test('malformed UTF-8, duplicate decoded JSON keys and incomplete JSON remain untouched', async t => {
  const f = await fixture(t), valid = JSON.stringify(f.document());
  const cases: Array<string | Buffer> = [
    '', '{', 'null', '[]', `${valid}{}`, `${valid}\0`, '\ufeff' + valid,
    valid.replace('"version":1', '"version":1,"version":1'),
    valid.replace('"ownerKey":', '"owner\\u004bey":"ignored","ownerKey":'),
    valid.replace('"model":"gpt-5.4"', '"model":"other","model":"gpt-5.4"'),
    valid.replace('"images":', '"images":[],"images":'),
    valid.replace('"version":1', '"version":01'),
    valid.replace('"version":1', '"version":1e999'),
    '{"unexpected":' + '['.repeat(20) + '0' + ']'.repeat(20) + '}',
    Buffer.concat([Buffer.from(valid.slice(0, -1)), Buffer.from([0xc3, 0x28]), Buffer.from('}')]),
  ];
  for (const input of cases) {
    const data = Buffer.from(input); await writeFile(f.path, data);
    await assert.rejects(f.open(), error('INVALID'));
    assert.deepEqual(await readFile(f.path), data);
  }
});

test('strict v1 owner, selection and image schema refuses extra fields, wrong owners and duplicate IDs', async t => {
  const f = await fixture(t), valid = f.document();
  const cases = [
    { ...valid, version: 2 }, { ...valid, ownerKey: randomUUID() }, { ...valid, ownerKey: null },
    { ...valid, extra: true }, { version: 1, ownerKey: f.ownerKey, images },
    { ...valid, selection: { ...valid.selection, extra: true } },
    { ...valid, selection: { ...valid.selection, kind: 'docker' } },
    { ...valid, selection: { ...valid.selection, wslExecutable: 'C:\\bad\\..\\wsl.exe' } },
    { ...valid, selection: { ...valid.selection, wslExecutable: '\\\\server\\share\\wsl.exe' } },
    { ...valid, selection: { ...valid.selection, distro: 'Ubuntu\n' } },
    { ...valid, selection: { ...valid.selection, model: 'invalid model' } },
    { ...valid, images: [] }, { ...valid, images: [images[0], images[0]] },
    { ...valid, images: [...images, `sha256:${'c'.repeat(64)}`] },
    { ...valid, images: [images[0].toUpperCase()] }, { ...valid, images: ['a'.repeat(64)] },
    { ...valid, images: [123] },
  ];
  for (const value of cases) {
    const data = JSON.stringify(value); await writeFile(f.path, data);
    await assert.rejects(f.open(), error('INVALID'));
    assert.equal(await readFile(f.path, 'utf8'), data);
  }
});

test('16 KiB is a byte limit and valid boundary whitespace participates in the fingerprint', async t => {
  const f = await fixture(t), valid = JSON.stringify(f.document());
  const data = Buffer.from(valid + ' '.repeat(16 * 1024 - Buffer.byteLength(valid)));
  await writeFile(f.path, data);
  const opened = await f.open(); assert.ok(opened); assert.equal(opened.fingerprint, hash(data));
  const oversized = Buffer.concat([data, Buffer.from(' ')]); await writeFile(f.path, oversized);
  await assert.rejects(f.open(), error('INVALID')); assert.deepEqual(await readFile(f.path), oversized);
  await assert.rejects(opened.clear(), error('CHANGED')); assert.deepEqual(await readFile(f.path), oversized);
});

test('same-path replacement with byte-identical content cannot be cleared by the old receipt', async t => {
  const f = await fixture(t), old = await f.create(), data = await readFile(f.path);
  const oldPath = join(f.root, 'original.pending'); await rename(f.path, oldPath); await writeFile(f.path, data);
  assert.notEqual((await lstat(oldPath, { bigint: true })).ino, (await lstat(f.path, { bigint: true })).ino);
  await assert.rejects(old.assertUnchanged(), error('CHANGED')); await assert.rejects(old.clear(), error('CHANGED'));
  assert.deepEqual(await readFile(f.path), data); assert.deepEqual(await readFile(oldPath), data);
  const current = await f.open(); assert.ok(current); assert.equal(current.fingerprint, old.fingerprint);
  await current.clear(); assert.deepEqual(await readFile(oldPath), data);
});

test('same-inode content changes and missing files invalidate clear without deleting a later replacement', async t => {
  const f = await fixture(t), old = await f.create(), before = await lstat(f.path, { bigint: true });
  const altered = JSON.stringify({ ...f.document(), images: [`sha256:${'c'.repeat(64)}`, images[1]] });
  await writeFile(f.path, altered); assert.equal((await lstat(f.path, { bigint: true })).ino, before.ino);
  await assert.rejects(old.assertUnchanged(), error('CHANGED')); await assert.rejects(old.clear(), error('CHANGED'));
  assert.equal(await readFile(f.path, 'utf8'), altered);
  await unlink(f.path); await assert.rejects(old.clear(), error('CHANGED'));
  const next = await f.create(); await assert.rejects(old.clear(), error('CHANGED'));
  await next.assertUnchanged();
});

test('hard links and non-files are rejected, including links added after a valid receipt', async t => {
  const f = await fixture(t), receipt = await f.create(), linked = join(f.root, 'linked.pending');
  await link(f.path, linked);
  await assert.rejects(f.open(), error('INVALID')); await assert.rejects(receipt.clear(), error('CHANGED'));
  assert.deepEqual(await readFile(f.path), await readFile(linked));
  await unlink(f.path); await mkdir(f.path);
  await assert.rejects(f.open(), error('INVALID')); assert.ok((await lstat(f.path)).isDirectory());
});

test('journal symlinks and canonical parent junctions cannot redirect reads or creation', async t => {
  const f = await fixture(t), target = join(f.base, 'outside.pending');
  await writeFile(target, JSON.stringify(f.document()));
  await t.test('file symlink', async sub => {
    try { await symlink(target, f.path, 'file'); }
    catch (failure) {
      if (['EPERM', 'EACCES'].includes((failure as NodeJS.ErrnoException).code ?? '')) { sub.skip('OS denies unprivileged file symlinks'); return; }
      throw failure;
    }
    await assert.rejects(f.open(), error('INVALID')); await assert.rejects(f.create(), error('EXISTS'));
    assert.equal(await readFile(target, 'utf8'), JSON.stringify(f.document())); await unlink(f.path);
  });
  const alias = join(f.base, 'alias'); await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openDesktopImageJournal(alias, f.ownerKey), error('INVALID'));
  await assert.rejects(createDesktopImageJournal(alias, f.ownerKey, selection(), images), error('INVALID'));
  assert.deepEqual(await readdir(f.root), []);
});

test('parent directory replacement invalidates the old receipt even when its original inode returns beneath it', async t => {
  const f = await fixture(t), receipt = await f.create(), moved = join(f.base, 'original-root');
  await rename(f.root, moved); await mkdir(f.root);
  await rename(join(moved, journalName), f.path);
  await assert.rejects(receipt.assertUnchanged(), error('CHANGED')); await assert.rejects(receipt.clear(), error('CHANGED'));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.document());
});

test('concurrent receipt operations serialize and cannot clear a subsequently created record', async t => {
  const f = await fixture(t), receipt = await f.create();
  await Promise.all([receipt.assertUnchanged(), receipt.clear()]);
  const next = await f.create(); await assert.rejects(receipt.clear(), error('CHANGED'));
  await next.assertUnchanged();
});

test('relative, traversal and invalid canonical roots are refused without writes', async t => {
  const f = await fixture(t);
  for (const path of ['.', `${f.root}${sep}..${sep}app-data`, `${f.root}\0`, join(f.root, 'missing')]) {
    await assert.rejects(openDesktopImageJournal(path, f.ownerKey), error('INVALID'));
    await assert.rejects(createDesktopImageJournal(path, f.ownerKey, selection(), images), error('INVALID'));
  }
  assert.deepEqual(await readdir(f.root), []);
});
