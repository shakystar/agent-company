import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { PGlite } from '@electric-sql/pglite';
import { command } from '../server/process.ts';

// Offline operator recovery. Never constructs AgentService or starts a model.
// Preserve a complete stopped physical image before allowing PostgreSQL to open.
const root = resolve('.data');
const evidence = resolve('.verification/db-repair-20260909');
const backupRoot = resolve('C:/dev/backups/agent-company/65c7a6bb-8fd6-4f31-807b-72b624f45a02');
const archive = join(backupRoot, 'offline-repair-20260909.tar');
const archiveArgument = relative(process.cwd(), archive).replaceAll('\\', '/');
const mode = process.argv[2];
assert.ok(['preserve', 'inspect', 'compact'].includes(mode), 'Expected preserve, inspect, or compact.');
const databaseWorker = process.argv[3] === '--database-worker';
assert.ok(!databaseWorker || process.send, 'Database maintenance requires a lock-owning parent.');
const GiB = 1024 ** 3;
const hash = async (path: string) => {
  const digest = createHash('sha256');
  for await (const part of createReadStream(path)) digest.update(part);
  return digest.digest('hex');
};
async function save(name: string, value: unknown) {
  await writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
async function inventory(directory: string, prefix = ''): Promise<Array<{ path: string; bytes: number; modified: number }>> {
  const result: Array<{ path: string; bytes: number; modified: number }> = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!prefix && name === 'controller.lock') continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(directory, name));
    assert.ok(!info.isSymbolicLink(), `Unexpected link: ${path}`);
    if (info.isDirectory()) result.push(...await inventory(join(directory, name), path));
    else { assert.ok(info.isFile(), `Unexpected special file: ${path}`); result.push({ path, bytes: info.size, modified: info.mtimeMs }); }
  }
  return result;
}
async function freeSpace() {
  const fs = await statfs(root); return fs.bavail * fs.bsize;
}
assert.equal((await readFile(join(root, 'workspace-id'), 'utf8')).trim(), '65c7a6bb-8fd6-4f31-807b-72b624f45a02');
try { await lstat(join(root, 'storage-layout.json')); throw new Error('Active generation changed; inspect before recovery.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
// PostgreSQL's synchronous WASM work must not starve the controller lock heartbeat.
// The parent retains the lock while a separate child performs database maintenance.
const unlock = databaseWorker ? async () => {} : await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
try {
  await mkdir(evidence, { recursive: true });
  if (mode === 'preserve') {
    const before = await inventory(root);
    const sourceBytes = before.reduce((sum, file) => sum + file.bytes, 0);
    const otherBackupBytes = (await inventory(backupRoot)).reduce((sum, file) => sum + file.bytes, 0);
    assert.ok(sourceBytes + otherBackupBytes + GiB < 30 * GiB, 'Physical archive must fit the approved 30 GiB backup budget.');
    assert.ok(await freeSpace() > sourceBytes + 21 * GiB, 'Preserve requires source size plus 20 GiB free and a 1 GiB margin.');
    try { assert.deepEqual(before, JSON.parse(await readFile(join(evidence, 'physical-before.json'), 'utf8')), 'Source changed after the interrupted compression attempt.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await save('physical-before.json', before); }
    await writeFile(archive, '', { flag: 'wx' });
    const abort = new AbortController();
    const watcher = setInterval(() => {
      void Promise.all([stat(archive), freeSpace()]).then(([info, free]) => {
        console.log(JSON.stringify({ phase: 'archive', archiveBytes: info.size, freeBytes: free }));
        if (info.size + otherBackupBytes > 30 * GiB || free < 20 * GiB) abort.abort();
      }).catch(() => abort.abort());
    }, 5000);
    try {
      const result = await command('C:/Program Files/Git/usr/bin/tar.exe', ['-cf', archiveArgument, '--exclude=.data/controller.lock', '.data'], { timeoutMs: 30 * 60_000, signal: abort.signal });
      assert.equal(result.code, 0, result.stderr);
      console.log('Comparing physical archive against the stopped source.');
      const compare = await command('C:/Program Files/Git/usr/bin/tar.exe', ['-df', archiveArgument], { timeoutMs: 30 * 60_000, signal: abort.signal });
      assert.equal(compare.code, 0, `${compare.stdout}\n${compare.stderr}`);
      assert.deepEqual(await inventory(root), before, 'Source changed during preservation.');
      assert.ok((await stat(archive)).size + otherBackupBytes <= 30 * GiB && await freeSpace() >= 20 * GiB, 'Preservation storage limits exceeded.');
      const report = { createdAt: new Date().toISOString(), archive, bytes: (await stat(archive)).size, sha256: await hash(archive), files: before.length,
        sourceBytes: before.reduce((sum, file) => sum + file.bytes, 0), verifiedBy: 'GNU tar --compare + unchanged source inventory',
        envSha256: await hash('.env'), ledgerSha256: await hash(join(root, 'operational-budget/ledger.json')), releaseSha256: await hash(join(root, 'runtime-release.json')) };
      await save('preservation.json', report); console.log(JSON.stringify(report));
    } finally { clearInterval(watcher); }
  } else {
    const preserved = JSON.parse(await readFile(join(evidence, 'preservation.json'), 'utf8'));
    if (!databaseWorker) {
      assert.equal(await hash(archive), preserved.sha256, 'Physical backup hash changed.');
      assert.ok((await stat(archive)).size <= 30 * GiB);
      assert.equal(await hash('.env'), preserved.envSha256);
      assert.equal(await hash(join(root, 'operational-budget/ledger.json')), preserved.ledgerSha256);
      assert.equal(await hash(join(root, 'runtime-release.json')), preserved.releaseSha256);
      assert.ok(await freeSpace() > 20 * GiB);
      if (mode === 'inspect') assert.deepEqual(await inventory(root), JSON.parse(await readFile(join(evidence, 'physical-before.json'), 'utf8')), 'Source changed after preservation.');
      for (const name of mode === 'inspect' ? ['logical-before.json', 'logical-before.raw.json', 'database-before.json', 'inspect-physical-after.json'] : ['physical-after-checkpoint.json', 'database-after.json', 'database-reopened.json', 'compact-physical-after.json']) {
        try { await lstat(join(evidence, name)); throw new Error(`Recovery evidence already exists: ${name}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await new Promise<void>((done, fail) => {
        const child = fork(resolve(process.argv[1]), [mode, '--database-worker'], { execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.once('error', fail);
        child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`Database child stopped: ${code ?? signal}`)));
      });
      assert.equal(await hash('.env'), preserved.envSha256);
      assert.equal(await hash(join(root, 'operational-budget/ledger.json')), preserved.ledgerSha256);
      assert.equal(await hash(join(root, 'runtime-release.json')), preserved.releaseSha256);
      const physical = await inventory(root);
      await save(`${mode}-physical-after.json`, physical);
      console.log(JSON.stringify({ phase: `${mode}-closed`, bytes: physical.reduce((sum, file) => sum + file.bytes, 0), freeBytes: await freeSpace() }));
    } else {
    // NodeFS opens PostgreSQL files on demand; no full-data-dir Blob is built.
    const db = await PGlite.create(join(root, 'db'));
    try {
      const before = await db.query<{ revision: number; singleton: boolean; value: Record<string, unknown>; json: string }>('SELECT singleton, revision, value, value::text AS json FROM public.workspace_state');
      assert.equal(before.rows.length, 1);
      const row = before.rows[0];
      assert.equal(row.singleton, true); assert.ok(Number.isSafeInteger(row.revision));
      const logicalHash = createHash('sha256').update(row.json).digest('hex');
      const relations = await db.query(`SELECT c.oid, n.nspname, c.relname, c.relkind, pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','t','m') ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`);
      const settings = await db.query(`SELECT name, setting FROM pg_settings WHERE name IN ('server_version','autovacuum','wal_level','max_wal_size','min_wal_size','checkpoint_timeout')`);
      const report = { at: new Date().toISOString(), revision: row.revision, logicalHash, logicalBytes: Buffer.byteLength(row.json), relations: relations.rows, settings: settings.rows };
      if (mode === 'inspect') {
        await save('logical-before.json', { revision: row.revision, value: row.value, jsonSha256: logicalHash });
        await writeFile(join(evidence, 'logical-before.raw.json'), row.json, { flag: 'wx' });
        await save('database-before.json', report); console.log(JSON.stringify(report));
      } else {
        const original = JSON.parse(await readFile(join(evidence, 'logical-before.json'), 'utf8'));
        assert.equal(logicalHash, original.jsonSha256); assert.equal(row.revision, original.revision);
        // Use PostgreSQL maintenance, never delete pg_wal or relation files manually.
        console.log('Running CHECKPOINT, VACUUM FULL workspace_state, then CHECKPOINT.');
        await db.exec('CHECKPOINT');
        const checkpointFiles = await inventory(join(root, 'db'));
        await save('physical-after-checkpoint.json', { at: new Date().toISOString(), bytes: checkpointFiles.reduce((sum, file) => sum + file.bytes, 0), walBytes: checkpointFiles.filter(file => file.path.startsWith('pg_wal/')).reduce((sum, file) => sum + file.bytes, 0), freeBytes: await freeSpace() });
        assert.ok(await freeSpace() >= 20 * GiB, 'Checkpoint did not leave enough recovery space.');
        await db.exec('VACUUM (FULL, ANALYZE) public.workspace_state');
        await db.exec('CHECKPOINT');
        const after = (await db.query<{ revision: number; json: string }>('SELECT revision, value::text AS json FROM workspace_state WHERE singleton = true')).rows[0];
        assert.equal(after.revision, original.revision); assert.equal(createHash('sha256').update(after.json).digest('hex'), logicalHash);
        const sizes = await db.query(`SELECT pg_total_relation_size('workspace_state')::text AS table_bytes, pg_database_size(current_database())::text AS database_bytes`);
        await save('database-after.json', { at: new Date().toISOString(), logicalHash, revision: after.revision, sizes: sizes.rows });
        console.log(JSON.stringify({ logicalHash, revision: after.revision, sizes: sizes.rows }));
      }
    } finally { await db.close(); }
    if (mode === 'compact') {
      const original = JSON.parse(await readFile(join(evidence, 'logical-before.json'), 'utf8'));
      const reopened = await PGlite.create(join(root, 'db'));
      try {
        const rows = (await reopened.query<{ singleton: boolean; revision: number; json: string }>('SELECT singleton, revision, value::text AS json FROM public.workspace_state')).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].singleton, true); assert.equal(rows[0].revision, original.revision);
        const logicalHash = createHash('sha256').update(rows[0].json).digest('hex');
        assert.equal(logicalHash, original.jsonSha256);
        assert.equal(await hash(join(evidence, 'logical-before.raw.json')), logicalHash);
        await save('database-reopened.json', { at: new Date().toISOString(), rows: rows.length, revision: rows[0].revision, logicalHash });
        console.log('Clean close and reopen: original logical row and revision verified.');
      } finally { await reopened.close(); }
    }
    }
  }
} finally { await unlock(); }
