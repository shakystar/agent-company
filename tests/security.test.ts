import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface SeccompArg {
  index: number;
  value: number;
  valueTwo?: number;
  op: string;
}
interface SeccompRule {
  names: string[];
  action: string;
  args?: SeccompArg[];
  errnoRet?: number;
  includes?: { arches?: string[]; caps?: string[] };
  excludes?: { arches?: string[]; caps?: string[] };
}
interface SeccompProfile {
  defaultAction: string;
  defaultErrnoRet: number;
  syscalls: SeccompRule[];
}

const baselineBytes = readFileSync(new URL('../worker/security/docker-29.1.3-default.json', import.meta.url));
const baseline: SeccompProfile = JSON.parse(baselineBytes.toString('utf8'));
const profile: SeccompProfile = JSON.parse(readFileSync(new URL('../worker/security/codex-userns.json', import.meta.url), 'utf8'));
const additions = profile.syscalls.slice(baseline.syscalls.length);
const additionsFor = (name: string) => additions.filter(rule => rule.names.includes(name));

// Static checks model only this worker's amd64, --cap-drop=ALL configuration.
// They do not establish kernel behavior or replace live isolation checks.
function appliesToWorker(rule: SeccompRule): boolean {
  return (!rule.includes?.arches || rule.includes.arches.includes('amd64'))
    && !rule.includes?.caps?.length
    && !rule.excludes?.arches?.includes('amd64');
}

function allows(name: string, args: number[] = []): boolean {
  return profile.syscalls.some(rule => rule.action === 'SCMP_ACT_ALLOW'
    && rule.names.includes(name)
    && appliesToWorker(rule)
    && (rule.args ?? []).every(arg => {
      const actual = args[arg.index] ?? 0;
      if (arg.op === 'SCMP_CMP_EQ') return actual === arg.value;
      if (arg.op === 'SCMP_CMP_MASKED_EQ') return (BigInt(actual) & BigInt(arg.value)) === BigInt(arg.valueTwo ?? 0);
      throw new Error(`Unexpected comparison for ${name}: ${arg.op}`);
    }));
}

function assertExactArgument(rule: SeccompRule, index: number, value: number): void {
  assert.deepEqual(rule.args, [{ index, value, op: 'SCMP_CMP_EQ' }]);
}

test('worker seccomp retains the pinned Docker 29.1.3 baseline without editing any existing rules', () => {
  assert.equal(createHash('sha256').update(baselineBytes).digest('hex'), 'f17cb7cf3c40ab6a42d978a3eea027062f18ee72d2ba5edc3a5cbdf58c67ab58');
  assert.deepEqual(profile.syscalls.slice(0, baseline.syscalls.length), baseline.syscalls);
  const { syscalls: _baselineRules, ...baselineMetadata } = baseline;
  const { syscalls: _profileRules, ...profileMetadata } = profile;
  assert.deepEqual(profileMetadata, baselineMetadata);
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(profile.defaultErrnoRet, 1);
});

test('worker seccomp expands exactly five syscall names and only on amd64', () => {
  assert.deepEqual([...new Set(additions.flatMap(rule => rule.names))].sort(), ['clone', 'mount', 'pivot_root', 'umount2', 'unshare']);
  for (const rule of additions) {
    assert.equal(rule.action, 'SCMP_ACT_ALLOW');
    assert.deepEqual(rule.includes, { arches: ['amd64'] });
    assert.equal(rule.excludes, undefined);
    assert.equal(rule.errnoRet, undefined);
    assert.equal(rule.names.length, 1, 'Each added syscall must have its own argument restrictions');
  }
});

test('namespace creation is limited to the observed clone and unshare flags', () => {
  assert.equal(additionsFor('clone').length, 1);
  assertExactArgument(additionsFor('clone')[0], 0, 2013397009);
  assert.equal(additionsFor('unshare').length, 1);
  assertExactArgument(additionsFor('unshare')[0], 0, 268435456);
  assert.equal(allows('clone', [2013397009]), true);
  assert.equal(allows('unshare', [268435456]), true);
  assert.equal(allows('clone', [2013397009 - 268435456]), false, 'Namespace clone without NEWUSER must stay denied');
  assert.equal(allows('clone', [2013397009 + 67108864]), false, 'Adding NEWUTS must stay denied');
  assert.equal(allows('unshare', [131072]), false, 'Standalone mount namespace creation must stay denied');
  assert.equal(allows('unshare', [268435456 + 131072]), false, 'Unobserved combined flags must stay denied');
});

test('mount setup uses exact numeric flags and unmount only permits MNT_DETACH', () => {
  assert.ok(additionsFor('mount').length > 0);
  const mountFlags: number[] = [];
  for (const rule of additionsFor('mount')) {
    assert.equal(rule.args?.length, 1);
    const arg = rule.args![0];
    assert.equal(arg.index, 3);
    assert.equal(arg.op, 'SCMP_CMP_EQ');
    assert.equal(arg.valueTwo, undefined);
    assert.ok(Number.isSafeInteger(arg.value) && arg.value >= 0);
    mountFlags.push(arg.value);
    assert.equal(allows('mount', [0, 0, 0, arg.value]), true);
  }
  assert.equal(new Set(mountFlags).size, mountFlags.length);
  assert.deepEqual(mountFlags.toSorted((a, b) => a - b), [573440, 6, 3236810752, 53248, 2134055, 2134063, 36903, 36911, 10, 14, 311296, 2134054, 37927].toSorted((a, b) => a - b));
  assert.equal(allows('mount', [0, 0, 0, 0xffffffff]), false);
  assert.equal(additionsFor('umount2').length, 1);
  assertExactArgument(additionsFor('umount2')[0], 1, 2);
  assert.equal(allows('umount2', [0, 2]), true);
  assert.equal(allows('umount2', [0, 0]), false);
  assert.equal(allows('umount2', [0, 1]), false);
  assert.equal(additionsFor('pivot_root').length, 1);
});

test('Windows drvfs file compatibility permits only the exact readonly noatime remount combination', () => {
  const readOnly = 1, noSuid = 2, noDev = 4, remount = 32, noAtime = 1024, bind = 4096, silent = 32768;
  const required = readOnly | noSuid | noDev | remount | noAtime | bind | silent;
  assert.equal(required, 37927);
  const matching = additionsFor('mount').filter(rule => rule.args?.[0].value === required);
  assert.equal(matching.length, 1); assertExactArgument(matching[0], 3, required);
  assert.equal(allows('mount', [0, 0, 0, required]), true);
  for (const flag of [readOnly, noSuid, noDev, remount, bind, silent]) {
    assert.equal(allows('mount', [0, 0, 0, required & ~flag]), false, `Missing restriction ${flag} must remain denied`);
  }
  for (const flag of [8, 2048, 16384, 131072]) {
    assert.equal(allows('mount', [0, 0, 0, required | flag]), false, `Unapproved extra flag ${flag} must remain denied`);
  }
  assert.equal(allows('mount', [0, 0, 0, required & ~noAtime]), true, 'Original exact readonly remount remains unchanged');
});

test('worker seccomp keeps clone3 ENOSYS and unrelated privileged syscalls blocked', () => {
  const clone3Rules = profile.syscalls.filter(rule => rule.names.includes('clone3') && appliesToWorker(rule));
  assert.equal(clone3Rules.length, 1);
  assert.equal(clone3Rules[0].action, 'SCMP_ACT_ERRNO');
  assert.equal(clone3Rules[0].errnoRet, 38);
  for (const syscall of ['clone3', 'setns', 'chroot', 'bpf', 'keyctl', 'add_key', 'request_key', 'open_by_handle_at', 'io_uring_setup']) {
    assert.equal(allows(syscall), false, `${syscall} must remain blocked without capabilities`);
  }
});
