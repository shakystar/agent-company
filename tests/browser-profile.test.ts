import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const baselineBytes = await readFile(new URL('../worker/security/docker-29.1.3-default.json', import.meta.url));
const codexBytes = await readFile(new URL('../worker/security/codex-userns.json', import.meta.url));
const baseline = JSON.parse(baselineBytes.toString('utf8'));
const browser = JSON.parse(await readFile(new URL('../worker/security/browser-userns.json', import.meta.url), 'utf8'));
const additions = browser.syscalls.slice(baseline.syscalls.length);

test('browser profile preserves the exact existing Docker and Codex policy files', () => {
  assert.equal(createHash('sha256').update(baselineBytes).digest('hex'), 'f17cb7cf3c40ab6a42d978a3eea027062f18ee72d2ba5edc3a5cbdf58c67ab58');
  assert.equal(createHash('sha256').update(codexBytes).digest('hex'), '36d3a7bf454ce300d839073aef472ea3f71a03bd9245df1639c77436c33cf342');
  assert.deepEqual({ ...browser, syscalls: browser.syscalls.slice(0, baseline.syscalls.length) }, baseline);
  assert.equal(browser.defaultAction, 'SCMP_ACT_ERRNO'); assert.equal(browser.defaultErrnoRet, 1);
});

test('browser profile adds only three exact observed amd64 clone flag combinations', () => {
  const clones = additions.filter((entry: any) => entry.names.includes('clone'));
  assert.equal(clones.length, 3);
  assert.deepEqual(clones.map((entry: any) => entry.args[0].value).sort((a: number, b: number) => a - b), [268435473, 536870929, 1879048209]);
  for (const entry of clones) {
    assert.deepEqual(entry.names, ['clone']); assert.equal(entry.action, 'SCMP_ACT_ALLOW');
    assert.deepEqual(entry.includes, { arches: ['amd64'] }); assert.equal(entry.args.length, 1);
    assert.equal(entry.args[0].index, 0); assert.equal(entry.args[0].op, 'SCMP_CMP_EQ');
  }
});

test('browser profile restricts unshare to a nested user namespace', () => {
  const unshares = additions.filter((entry: any) => entry.names.includes('unshare'));
  assert.equal(unshares.length, 1);
  assert.deepEqual(unshares[0].args, [{ index: 0, value: 268435456, op: 'SCMP_CMP_EQ' }]);
  assert.deepEqual(unshares[0].includes, { arches: ['amd64'] });
});

test('browser profile adds chroot without adding mounts, setns, clone3 or unrelated syscalls', () => {
  assert.equal(additions.length, 5);
  assert.deepEqual([...new Set(additions.flatMap((entry: any) => entry.names))].sort(), ['chroot', 'clone', 'unshare']);
  const chroot = additions.find((entry: any) => entry.names.includes('chroot'));
  assert.equal(chroot.action, 'SCMP_ACT_ALLOW'); assert.deepEqual(chroot.includes, { arches: ['amd64'] });
  assert.match(chroot.comment, /seccomp cannot inspect the pointed-to path/);
  for (const syscall of ['clone3', 'setns', 'mount', 'pivot_root', 'umount2', 'bpf', 'keyctl']) {
    assert.deepEqual(browser.syscalls.filter((entry: any) => entry.names.includes(syscall)), baseline.syscalls.filter((entry: any) => entry.names.includes(syscall)));
  }
});

test('browser chooses installed full Chromium without disabling its sandbox', async () => {
  const source = await readFile(new URL('../worker/browser.mjs', import.meta.url), 'utf8');
  assert.match(source, /channel: 'chromium'/); assert.match(source, /chromiumSandbox: true/);
  assert.doesNotMatch(source, /--no-sandbox|--disable-setuid-sandbox|--disable-namespace-sandbox|ignoreDefaultArgs/);
});
