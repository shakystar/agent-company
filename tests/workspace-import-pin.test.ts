import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Command, CommandOptions, CommandResult } from '../server/process.ts';
import { DockerWorkspaces } from '../server/workspaces.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const result = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
async function fixture(t: TestContext, consume?: (options: CommandOptions) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ac-workspace-import-pin-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const archivePath = join(root, 'archive.gz'), original = randomBytes(160 * 1024 + 7);
  await writeFile(archivePath, original);
  const owner = randomUUID(), runId = randomUUID(), calls: string[][] = [], yielded: Buffer[] = [];
  let exists = false, cleanupGate: (() => Promise<void>) | undefined;
  const run: Command = async (_file, args, options = {}) => {
    calls.push([...args]);
    if (args[0] === 'volume' && args[1] === 'inspect') return exists ? result(JSON.stringify({
      app: 'agent-company', 'agent-company.workspace': owner, 'agent-company.run': runId,
    })) : { code: 1, stdout: '', stderr: 'no such volume' };
    if (args[0] === 'volume' && args[1] === 'create') { exists = true; return result(); }
    if (args[0] === 'ps') return result();
    if (args[0] === 'rm') { await cleanupGate?.(); return result(); }
    if (args[0] === 'run') {
      if (consume) await consume(options);
      else {
        let first = true;
        for await (const chunk of options.inputStream!) {
          if (first) { first = false; assert.equal(JSON.parse(String(chunk)).operation, 'import'); }
          else yielded.push(Buffer.from(chunk));
        }
      }
      return result(JSON.stringify({ version: 1, state: 'ready', ready: true, runId, sourceRunId: null, files: 1, bytes: 5, reused: false }));
    }
    throw new Error('Unexpected fixture command');
  };
  const manager = new DockerWorkspaces({ mode: 'docker', image: 'fixture-only', workspaceKey: owner, persistentWorkspaces: true },
    run, () => 'ac-0123456789abcdef-0123456789abcdef01234567');
  return { root, archivePath, original, runId, manager, calls, yielded, pin: { bytes: original.length, sha256: hash(original) },
    get exists() { return exists; }, cleanupGate: (callback: () => Promise<void>) => { cleanupGate = callback; } };
}

test('pinned import hashes binary stdin bytes, excludes request header and completes helper cleanup', async t => {
  const f = await fixture(t);
  const imported = await f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, f.pin);
  assert.equal(imported.ready, true); assert.deepEqual(Buffer.concat(f.yielded), f.original);
  assert.ok(f.yielded.length >= 3); assert.ok(f.yielded.every(bytes => bytes.length <= 64 * 1024));
  assert.equal(f.calls.at(-1)![0], 'rm'); assert.equal(f.exists, true);
});

test('same-sized archive substitution consumed and then restored cannot pass the original pin', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let transferred = 0;
  f = await fixture(t, async options => {
    const changed = Buffer.from(f.original); changed[100] ^= 255;
    await writeFile(f.archivePath, changed);
    try {
      let first = true;
      for await (const bytes of options.inputStream!) {
        if (first) first = false; else transferred += Buffer.byteLength(bytes);
      }
    } finally { await writeFile(f.archivePath, f.original); }
  });
  await assert.rejects(f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, f.pin), /승인된 길이·해시/);
  assert.deepEqual(await readFile(f.archivePath), f.original, 'Path reinspection alone would see the original archive');
  assert.ok(transferred < f.original.length, 'Final chunk is withheld on mismatch');
  assert.equal(f.calls.at(-1)![0], 'rm'); assert.equal(f.exists, true, 'Failed staged volume is retained');
  assert.equal(f.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
});

test('matching byte length with a wrong digest rejects after cleanup and never returns a ready result', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, { ...f.pin, sha256: '0'.repeat(64) }), /승인된 길이·해시/);
  assert.ok(Buffer.concat(f.yielded).length < f.original.length); assert.equal(f.calls.at(-1)![0], 'rm');
});

test('successful process result without full iterator consumption is rejected', async t => {
  const f = await fixture(t, async options => {
    const iterator = options.inputStream![Symbol.asyncIterator]();
    await iterator.next(); await iterator.next(); await iterator.return?.();
  });
  await assert.rejects(f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, f.pin), /승인된 길이·해시/);
  assert.equal(f.calls.at(-1)![0], 'rm');
});

test('rejection waits for owned helper cleanup and malformed pins create no volume', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, { bytes: -1, sha256: f.pin.sha256 }));
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, { ...f.pin, bytes: f.pin.bytes - 1 }));
  assert.equal(f.calls.length, 0);
  let entered!: () => void, finish!: () => void;
  const cleanupEntered = new Promise<void>(done => { entered = done; });
  f.cleanupGate(() => { entered(); return new Promise<void>(done => { finish = done; }); });
  let settled = false;
  const pending = f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined, { ...f.pin, sha256: '0'.repeat(64) });
  const checked = assert.rejects(pending, /승인된 길이·해시/).finally(() => { settled = true; });
  await cleanupEntered; assert.equal(settled, false); finish(); await checked;
});

test('existing four-argument import remains supported without a caller-supplied digest', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.import(f.runId, f.archivePath, 1024 * 1024, undefined)).runId, f.runId);
  assert.deepEqual(Buffer.concat(f.yielded), f.original);
});
