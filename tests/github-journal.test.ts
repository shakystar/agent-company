import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitHubOperationJournal, GITHUB_OPERATION_MAX_BYTES, type GitHubOperationInput } from '../server/github-journal.ts';

const input = (): GitHubOperationInput => ({ key: 'site-release-1', runId: randomUUID(), agentId: randomUUID(),
  connectionId: randomUUID(), repository: 'formnest/studio-site', operation: 'publish', fingerprint: 'a'.repeat(64) });
const recordPath = (directory: string, key: string) => join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-company-github-journal-')), ownerKey = randomUUID();
  t.after(async () => {
    const target = resolve(directory), rel = relative(resolve(tmpdir()), target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('agent-company-github-journal-'));
    await rm(target, { recursive: true, force: true });
  });
  return { directory, ownerKey, journal: await GitHubOperationJournal.open({ directory, ownerKey }) };
}

test('completed operation survives reopen and returns persisted result without a second external call', async t => {
  const { directory, ownerKey, journal } = await fixture(t), operation = input();
  let calls = 0;
  const value = { branch: 'agent-company/release-1', commit: 'b'.repeat(40) };
  assert.deepEqual(await journal.execute(operation, async () => { calls++; return value; }), value);
  value.branch = 'mutated-after-return';
  const reopened = await GitHubOperationJournal.open({ directory, ownerKey, allowCreate: false, expectedIdentity: journal.identity });
  assert.equal(reopened.identity, journal.identity);
  assert.deepEqual(await reopened.execute(operation, async () => { calls++; return {}; }), { branch: 'agent-company/release-1', commit: 'b'.repeat(40) });
  assert.equal(calls, 1);
  const stored = JSON.parse(await readFile(recordPath(directory, operation.key), 'utf8'));
  assert.equal(stored.status, 'completed'); assert.equal(stored.attempts, 1);
  assert.equal(stored.key, undefined);
});

test('same-key concurrent calls across separate instances dispatch only one action', async t => {
  const { directory, ownerKey, journal } = await fixture(t), operation = input();
  const other = await GitHubOperationJournal.open({ directory, ownerKey });
  let calls = 0;
  const action = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { number: 7 }; };
  const values = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? journal : other).execute(operation, action)));
  assert.ok(values.every(value => JSON.stringify(value) === '{"number":7}')); assert.equal(calls, 1);
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.lock') && !name.endsWith('.tmp')));
});

test('same key with a changed fingerprint or attribution is rejected without dispatch', async t => {
  const { journal } = await fixture(t), operation = input();
  await journal.execute(operation, async () => ({ number: 1 }));
  const variations = { fingerprint: 'b'.repeat(64), runId: randomUUID(), agentId: randomUUID(), connectionId: randomUUID(), repository: 'other/studio-site', operation: 'pull_request' };
  let calls = 0;
  for (const [field, value] of Object.entries(variations)) {
    await assert.rejects(journal.execute({ ...operation, [field]: value }, async () => { calls++; return {}; }), /본문 또는 귀속/);
  }
  assert.equal(calls, 0);
});

test('completed receipt lookup preserves legacy bytes and fails closed on missing, uncertain and mismatched origins', async t => {
  const { directory, ownerKey, journal } = await fixture(t), operation = input();
  const { fingerprint: _fingerprint, ...lookup } = operation;
  await assert.rejects(journal.completed(lookup), /완료 영수증/);
  await assert.rejects(journal.execute(operation, async () => { throw new Error('lost response'); }));
  await assert.rejects(journal.completed(lookup), /완료 상태 또는 귀속/);
  const result = { branch: 'agent-company/original/site', headSha: 'a'.repeat(40) };
  await journal.execute(operation, async () => result);
  const before = await readFile(recordPath(directory, operation.key), 'utf8');
  const reopened = await GitHubOperationJournal.open({ directory, ownerKey, expectedIdentity: journal.identity, allowCreate: false });
  assert.deepEqual(await reopened.completed(lookup), result);
  for (const mutation of [{ runId: randomUUID() }, { agentId: randomUUID() }, { connectionId: randomUUID() }, { repository: 'other/repo' }, { operation: 'revision' }]) {
    await assert.rejects(reopened.completed({ ...lookup, ...mutation }), /완료 상태 또는 귀속/);
  }
  assert.equal(await readFile(recordPath(directory, operation.key), 'utf8'), before);
});

test('uncertain dispatch retains no raw error and retries through the transport reconciliation action', async t => {
  const { directory, ownerKey, journal } = await fixture(t), operation = input();
  let remoteCreates = 0, reconciliations = 0;
  const remote = new Map<string, { number: number }>();
  const action = async () => {
    reconciliations++;
    const prior = remote.get(operation.key); if (prior) return prior;
    remoteCreates++; remote.set(operation.key, { number: 21 });
    throw new Error('uncertain network response Authorization: Bearer SECRET_SENTINEL');
  };
  await assert.rejects(journal.execute(operation, action), /uncertain network response/);
  const raw = await readFile(recordPath(directory, operation.key), 'utf8');
  assert.equal(JSON.parse(raw).status, 'uncertain'); assert.ok(!raw.includes('SECRET_SENTINEL'));
  const reopened = await GitHubOperationJournal.open({ directory, ownerKey });
  assert.deepEqual(await reopened.execute(operation, action), { number: 21 });
  assert.equal(remoteCreates, 1); assert.equal(reconciliations, 2);
  assert.equal(JSON.parse(await readFile(recordPath(directory, operation.key), 'utf8')).attempts, 2);
});

test('an on-disk pending operation is reconciled after restart, not mistaken for completed or absent', async t => {
  const { directory, ownerKey, journal } = await fixture(t), operation = input();
  await journal.execute(operation, async () => ({ number: 12 }));
  const path = recordPath(directory, operation.key), stored = JSON.parse(await readFile(path, 'utf8'));
  stored.status = 'pending'; stored.result = null;
  await writeFile(path, JSON.stringify(stored));
  const reopened = await GitHubOperationJournal.open({ directory, ownerKey });
  let reconciliations = 0;
  assert.deepEqual(await reopened.execute(operation, async () => { reconciliations++; return { number: 12 }; }), { number: 12 });
  assert.equal(reconciliations, 1);
});

test('owner mismatch, changed anchor and missing identity fail closed', async t => {
  const { directory, ownerKey, journal } = await fixture(t), operation = input();
  await assert.rejects(GitHubOperationJournal.open({ directory, ownerKey: randomUUID() }), /소유권/);
  await assert.rejects(GitHubOperationJournal.open({ directory, ownerKey, expectedIdentity: randomUUID() }), /식별자/);
  const anchorPath = join(directory, 'identity.json'), anchor = await readFile(anchorPath, 'utf8');
  await writeFile(anchorPath, anchor.replace(journal.identity, randomUUID()));
  let calls = 0;
  await assert.rejects(journal.execute(operation, async () => { calls++; return {}; }), /식별자가 변경/);
  await writeFile(anchorPath, anchor);
  await journal.execute(operation, async () => ({ number: 1 }));
  await rm(anchorPath);
  await assert.rejects(journal.execute(operation, async () => { calls++; return {}; }), /식별 기록이 없습니다/);
  await assert.rejects(GitHubOperationJournal.open({ directory, ownerKey }), /식별 기록이 없습니다/);
  assert.equal(calls, 0);
});

test('configured installations never recreate a wholly missing journal', async t => {
  const { directory, ownerKey, journal } = await fixture(t), absent = join(directory, 'missing');
  await assert.rejects(GitHubOperationJournal.open({ directory: absent, ownerKey, allowCreate: false }), /작업 원장이 없습니다/);
  await assert.rejects(GitHubOperationJournal.open({ directory: absent, ownerKey, expectedIdentity: journal.identity }), /작업 원장이 없습니다/);
  await mkdir(absent);
  await assert.rejects(GitHubOperationJournal.open({ directory: absent, ownerKey, allowCreate: false }), /식별 기록이 없습니다/);
});

test('oversized and unserializable results never become successful receipts and release their lock', async t => {
  const { directory, journal } = await fixture(t), operation = input();
  await assert.rejects(journal.execute(operation, async () => ({ data: 'x'.repeat(GITHUB_OPERATION_MAX_BYTES) })), /2MiB/);
  assert.equal(JSON.parse(await readFile(recordPath(directory, operation.key), 'utf8')).status, 'pending');
  await assert.rejects(journal.execute(operation, async () => ({ bad: 1n })), /영속 기록할 수 없습니다/);
  assert.deepEqual(await journal.execute(operation, async () => ({ reconciled: true })), { reconciled: true });
});

test('corrupt or oversized prior records are preserved and block external dispatch', async t => {
  const { directory, journal } = await fixture(t), operation = input(), path = recordPath(directory, operation.key);
  let calls = 0;
  const action = async () => { calls++; return {}; };
  await writeFile(path, '{truncated');
  await assert.rejects(journal.execute(operation, action), /손상/);
  assert.equal(await readFile(path, 'utf8'), '{truncated');
  await writeFile(path, 'null');
  await assert.rejects(journal.execute(operation, action), /손상/);
  assert.equal(await readFile(path, 'utf8'), 'null');
  await writeFile(path, 'x'.repeat(GITHUB_OPERATION_MAX_BYTES + 1));
  await assert.rejects(journal.execute(operation, action), /크기/);
  assert.equal(calls, 0);
});

test('actual receipt publish failure is not returned as external success', async t => {
  const { directory, journal } = await fixture(t), operation = input(), path = recordPath(directory, operation.key);
  let remoteAccepted = false;
  await assert.rejects(journal.execute(operation, async () => {
    const pending = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(pending.status, 'pending', 'the intent must be durable before dispatch');
    remoteAccepted = true;
    // An exact fixture-only obstruction causes the real atomic file writer to fail.
    await rm(path); await mkdir(path);
    return { number: 17 };
  }), /일반 파일/);
  assert.equal(remoteAccepted, true);
  let repeated = false;
  await assert.rejects(journal.execute(operation, async () => { repeated = true; return {}; }), /파일 형식/);
  assert.equal(repeated, false);
});

test('untrusted keys are hashed and request bodies are never accepted or stored', async t => {
  const { directory, journal } = await fixture(t), operation = { ...input(), key: '../../outside' };
  await journal.execute(operation, async () => ({ ok: true }));
  assert.ok((await readdir(directory)).includes(`${createHash('sha256').update(operation.key).digest('hex')}.json`));
  await assert.rejects(journal.execute({ ...operation, key: 'another', body: 'PRIVATE_FILE_SENTINEL' } as GitHubOperationInput, async () => ({})));
  const records = await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')));
  assert.ok(records.every(raw => !raw.includes('PRIVATE_FILE_SENTINEL') && !raw.includes('../../outside')));
});
