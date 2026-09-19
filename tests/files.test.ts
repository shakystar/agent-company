import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BlobFiles, decodeFileImport, attachmentDisposition } from '../server/files.ts';
import { MAX_IMPORTED_FILE_BYTES, filePathKey, validFilePath } from '../shared/storage.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-company-files-'));
  t.after(async () => {
    const target = resolve(root);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}agent-company-files-`));
    await rm(target, { recursive: true, force: true });
  });
  return { root, files: new BlobFiles(root) };
}

test('file names preserve portable paths and exclude traversal and injected runtime paths', () => {
  for (const path of ['inputs/자료.pdf', 'project/AGENTS.md', 'result.bin', 'README', 'é.txt']) assert.equal(validFilePath(path), true, path);
  for (const path of ['', '/', '/etc/passwd', '../a', 'a/../b', 'a//b', './a', 'a\\b', 'C:/file', 'a:', 'a\n', 'a\0',
    '.codex/auth.json', '.agent-runtime/session', 'AGENTS.md', 'a/NUL.txt', 'COM1', 'a/foo.', 'a/foo ', 'a/*', 'a/?']) assert.equal(validFilePath(path), false, path);
  assert.equal(filePathKey('Reports/É.txt'), filePathKey('reports/e\u0301.txt'));
});

test('file imports validate canonical base64, strict scope, MIME and per-file bound', () => {
  const input = { scope: { type: 'team', id: randomUUID() }, path: 'binary.bin', mediaType: 'application/octet-stream', base64: Buffer.from([0, 1, 2, 254, 255]).toString('base64') };
  assert.deepEqual([...decodeFileImport(input).bytes], [0, 1, 2, 254, 255]);
  assert.equal(decodeFileImport({ ...input, base64: '' }).bytes.length, 0);
  for (const base64 of ['a', 'Zg', 'Zg=\n', 'Zg====', 'Zh==', 'Zm9=', '====', 'AA=A']) assert.throws(() => decodeFileImport({ ...input, base64 }));
  assert.throws(() => decodeFileImport({ ...input, scope: { type: 'host', id: input.scope.id } }));
  assert.throws(() => decodeFileImport({ ...input, scope: { type: 'agent', id: '../host' } }));
  assert.throws(() => decodeFileImport({ ...input, mediaType: 'text/html\r\nX: leak' }));
  assert.throws(() => decodeFileImport({ ...input, hostPath: 'C:/secret' }));
  const maximum = Buffer.alloc(MAX_IMPORTED_FILE_BYTES, 255).toString('base64');
  assert.equal(decodeFileImport({ ...input, base64: maximum }).bytes.length, MAX_IMPORTED_FILE_BYTES);
  assert.throws(() => decodeFileImport({ ...input, base64: `${maximum}AAAA` }));
});

test('immutable byte objects round-trip binary and empty files without replacing existing objects', async t => {
  const { files } = await fixture(t);
  const content = Buffer.from([0, 255, 42, 128, 0]);
  const first = await files.put(content), second = await files.put(content), empty = await files.put(Buffer.alloc(0));
  assert.notEqual(first.id, second.id);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await files.read(first), content);
  assert.deepEqual(await files.read(empty), Buffer.alloc(0));
  assert.equal((await readdir(files.directory)).length, 3);
  await files.remove(second.id);
  await files.remove(second.id);
  assert.deepEqual(await files.read(first), content);
  await assert.rejects(files.read(second), /없습니다/);
});

test('download disposition always uses an encoded attachment name without raw header punctuation', () => {
  assert.equal(attachmentDisposition('folder/자료(1).svg'), 'attachment; filename="download"; filename*=UTF-8\'\'%EC%9E%90%EB%A3%8C%281%29.svg');
  const value = attachmentDisposition('folder/evil\r\nX-Test: yes.html');
  assert.ok(value.startsWith('attachment;'));
  assert.equal(value.includes('\r'), false);
  assert.equal(value.includes('\n'), false);
});

test('byte store rejects corrupt, oversized or arbitrary-path records', async t => {
  const { files } = await fixture(t);
  const record = await files.put(Buffer.from('original'));
  await assert.rejects(files.read({ ...record, id: '../outside' }), /ID/);
  await assert.rejects(files.remove('../outside'), /ID/);
  await assert.rejects(files.read({ ...record, bytes: MAX_IMPORTED_FILE_BYTES + 1 }), /기록/);
  await assert.rejects(files.put(Buffer.alloc(MAX_IMPORTED_FILE_BYTES + 1)), /16MiB/);
  await writeFile(join(files.directory, `${record.id}.blob`), 'tampered');
  await assert.rejects(files.read(record), /무결성/);
  await writeFile(join(files.directory, `${record.id}.blob`), 'truncated');
  await assert.rejects(files.read(record), /크기/);
});

test('directory junctions cannot redirect the owned byte store', async t => {
  const { root, files } = await fixture(t);
  const outside = join(root, 'elsewhere'); await mkdir(outside);
  await writeFile(join(outside, 'retained.txt'), 'unchanged');
  await symlink(outside, files.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.put(Buffer.from('data')), /디렉터리|우회/);
  assert.deepEqual(await readdir(outside), ['retained.txt']);
  assert.equal(await readFile(join(outside, 'retained.txt'), 'utf8'), 'unchanged');
});

test('a linked ancestor cannot create a files directory outside the selected data root', async t => {
  const { root } = await fixture(t);
  const outside = join(root, 'retained'); await mkdir(outside);
  const link = join(root, 'link');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new BlobFiles(link).put(Buffer.from('data')), /디렉터리|우회/);
  assert.deepEqual(await readdir(outside), []);
});
