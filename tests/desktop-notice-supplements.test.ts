import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyDesktopNoticeSupplements } from '../scripts/desktop-notice-supplements.ts';
import { writeDesktopNotices, type DesktopNoticeComponent } from '../scripts/desktop-notices.ts';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-notice-supplement-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /ac-notice-supplement-[^\\/]+$/);
    await rm(root, { recursive: true }); });
  const component: DesktopNoticeComponent = { id: 'npm:node_modules/fixture', name: 'fixture', version: '1.0.0', ecosystem: 'npm',
    license: 'MIT', source: 'package-lock.json v3; sha512-fixture', files: [],
    issues: ['No license or attribution document is present in the installed package', 'Package license metadata is missing'] };
  const original = Buffer.from('\ufeffOriginal supplemental notice 원문\r\n');
  const document = { file: 'LICENSE', bytes: original.length, sha256: hash(original), url: 'https://example.org/fixed/LICENSE',
    gitBlob: createHash('sha1').update(Buffer.from(`blob ${original.length}\0`)).update(original).digest('hex') };
  const entry = { ecosystem: component.ecosystem, name: component.name, version: component.version, source: component.source,
    basis: 'Public test fixture only', documents: [document] };
  const index = { version: 1, supplements: [entry] };
  const manifest = join(root, 'supplements.json');
  const save = () => writeFile(manifest, JSON.stringify(index));
  await writeFile(join(root, 'LICENSE'), original); await save();
  return { root, component, original, document, entry, index, manifest, save };
}

test('an exact component supplement preserves original bytes and provenance, clearing only the missing-document issue', async t => {
  const f = await fixture(t), before = structuredClone(f.component);
  const result = await applyDesktopNoticeSupplements([f.component], f.manifest);
  assert.deepEqual(f.component, before); assert.equal(result.applied, 1);
  assert.deepEqual(result.components[0].files[0].data, f.original);
  assert.deepEqual(result.components[0].issues, ['Package license metadata is missing']);
  assert.deepEqual(result.components[0].supplementalSources, [{ basis: f.entry.basis, documents: [f.document] }]);
  await result.assertUnchanged();
  const output = join(f.root, 'published');
  await writeDesktopNotices(output, result.components, ['Provenance audit remains']);
  assert.ok((await readFile(join(output, 'THIRD-PARTY-NOTICES.txt'))).includes(f.original));
  const inventory = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'));
  assert.equal(inventory.distributionReady, false); assert.equal(inventory.documentsComplete, false);
  assert.deepEqual(inventory.components[0].supplementalSources[0].documents[0], f.document);
  assert.ok(!JSON.stringify(inventory).includes(f.root));
});

test('unmatched version, source, ecosystem, duplicate entries and document-name collisions are rejected', async t => {
  for (const kind of ['version', 'source', 'ecosystem', 'duplicate', 'document-case', 'existing-file', 'already-applied']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'version') f.entry.version = '2.0.0';
    if (kind === 'source') f.entry.source = 'different artifact';
    if (kind === 'ecosystem') f.entry.ecosystem = 'cargo';
    if (kind === 'duplicate') f.index.supplements.push(f.entry);
    if (kind === 'document-case') f.entry.documents.push({ ...f.document, file: 'license' });
    if (kind === 'existing-file') f.component.files.push({ path: 'upstream/LICENSE', data: Buffer.from('Existing original') });
    if (kind === 'already-applied') f.component.supplementalSources = [{ basis: 'Existing', documents: [] }];
    await f.save(); await assert.rejects(applyDesktopNoticeSupplements([f.component], f.manifest), /SUPPLEMENT_INVALID/);
  });
});

test('tampered bytes, Git blob mismatch, traversal, Windows aliases, links and invalid text cannot be supplemental originals', async t => {
  for (const kind of ['hash', 'size', 'git-blob', 'path', 'alias', 'hardlink', 'utf8', 'nul']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'hash') f.document.sha256 = '0'.repeat(64);
    if (kind === 'size') f.document.bytes++;
    if (kind === 'git-blob') f.document.gitBlob = '0'.repeat(40);
    if (kind === 'path') f.document.file = '../LICENSE';
    if (kind === 'alias') f.document.file = 'LICENSE:stream';
    if (kind === 'hardlink') await link(join(f.root, 'LICENSE'), join(f.root, 'hardlink'));
    if (kind === 'utf8' || kind === 'nul') {
      const bytes = kind === 'utf8' ? Buffer.from([255]) : Buffer.from('Not a notice\0');
      await writeFile(join(f.root, 'LICENSE'), bytes); f.document.bytes = bytes.length; f.document.sha256 = hash(bytes);
    }
    await f.save(); await assert.rejects(applyDesktopNoticeSupplements([f.component], f.manifest));
    assert.equal((await readdir(f.root)).includes('published'), false);
  });
});

test('receipt detects a changed source document or index before publication', async t => {
  for (const filename of ['LICENSE', 'supplements.json']) await t.test(filename, async sub => {
    const f = await fixture(sub), result = await applyDesktopNoticeSupplements([f.component], f.manifest);
    await writeFile(join(f.root, filename), 'Changed input'); await assert.rejects(result.assertUnchanged());
    assert.deepEqual(result.components[0].files[0].data, f.original);
  });
});

test('one exact source can cover duplicate installed locations without substituting other packages', async t => {
  const f = await fixture(t), duplicate = { ...f.component, id: 'npm:node_modules/nested/node_modules/fixture' };
  const other = { ...f.component, name: 'other', id: 'npm:node_modules/other' };
  const result = await applyDesktopNoticeSupplements([f.component, duplicate, other], f.manifest);
  assert.equal(result.applied, 1); assert.equal(result.components[0].files.length, 1); assert.equal(result.components[1].files.length, 1);
  assert.equal(result.components[2].files.length, 0); assert.deepEqual(result.components[2].issues, other.issues);
});
