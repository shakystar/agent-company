import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { desktopRuntimeSettings } from '../server/desktop-runtime-settings.ts';
import { DesktopRuntimeSetup, type DesktopRuntimeSetupOptions } from '../server/desktop-runtime-setup.ts';
import type { DesktopRuntimeInstallProgress, DesktopRuntimeRecoveryInfo } from '../shared/desktop-runtime-setup.ts';

const selection = { kind: 'wsl-docker' as const, wslExecutable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu-22.04', model: 'fixture-model' };
const recoveryInfo = (): DesktopRuntimeRecoveryInfo => ({ fingerprint: 'a'.repeat(64), selection: { ...selection },
  images: [{ kind: 'worker', status: 'present' }, { kind: 'browser', status: 'missing' }] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t: test.TestContext, overrides: Partial<DesktopRuntimeSetupOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ac-runtime-setup-')), owner = randomUUID();
  await writeFile(join(root, 'desktop-installation.json'), JSON.stringify({ version: 1, product: 'agent-company-desktop', channel: 'beta', workspaceKey: owner }));
  const settings = desktopRuntimeSettings(root, owner); let admissions = 0, probes = 0;
  const options: DesktopRuntimeSetupOptions = { available: true, recoveryRequired: false, initial: await settings.read(), settings,
    admit: () => { admissions++; return () => { admissions--; }; }, assertAccountIdle() {},
    probe: async () => { probes++; }, ...overrides };
  const setup = new DesktopRuntimeSetup(options);
  t.after(async () => { await setup.close(); const location = relative(tmpdir(), root);
    assert.ok(location.startsWith('ac-runtime-setup-') && !isAbsolute(location) && !location.includes(sep)); await rm(root, { recursive: true }); });
  return { root, setup, settings, options, admissions: () => admissions, probes: () => probes };
}

test('first explicit configuration holds admission through probe and save, then requires restart', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { probe: async value => { assert.deepEqual(value, selection); started.resolve(); await gate.promise; } });
  t.after(() => gate.resolve());
  const changing = f.setup.configure({ revision: 0, selection }); await started.promise;
  assert.equal(f.setup.status().phase, 'checking'); assert.equal(f.admissions(), 1);
  assert.throws(() => f.setup.assertIdle(), { code: 'SETUP_RUNTIME_BUSY' });
  assert.throws(() => f.setup.configure({ revision: 1, selection }), { code: 'SETUP_RUNTIME_BUSY' });
  assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
  gate.resolve(); const saved = await changing;
  assert.equal(saved.phase, 'restartRequired'); assert.deepEqual(saved.selection, selection); assert.equal(f.admissions(), 0);
  assert.deepEqual(await f.settings.read(), { revision: 1, selection });
  saved.selection!.model = 'mutated'; assert.equal(f.setup.status().selection?.model, selection.model);
  assert.throws(() => f.setup.configure({ revision: f.setup.status().revision, selection }), { code: 'SETUP_RUNTIME_UNAVAILABLE' });
});

test('failed probe leaves an initial installation intact and retry can save the same explicit selection', async t => {
  const f = await fixture(t, { probe: async () => { throw new Error('PRIVATE_PATH_AND_DIAGNOSTIC'); } });
  const failed = await f.setup.configure({ revision: 0, selection });
  assert.equal(failed.phase, 'unconfigured'); assert.equal(failed.selection, null); assert.equal(f.admissions(), 0);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
  f.options.probe = async () => {};
  assert.equal((await f.setup.configure({ revision: failed.revision, selection })).phase, 'restartRequired');
});

test('close aborts pending verification but waits for its actual completion before releasing admission', async t => {
  const ended = deferred(), started = deferred(); let aborted = false;
  const f = await fixture(t, { probe: async (_, signal) => { signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await ended.promise; } });
  t.after(() => ended.resolve());
  const configuring = f.setup.configure({ revision: 0, selection }); await started.promise;
  let closed = false; const closing = f.setup.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(aborted, true); assert.equal(closed, false); assert.equal(f.admissions(), 1);
  assert.equal(f.setup.status().phase, 'closing'); ended.resolve(); await Promise.all([configuring, closing]);
  assert.equal(f.admissions(), 0); assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
});

test('a setting changed while checking is preserved and reported as recovery required', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { probe: async () => { started.resolve(); await gate.promise; } });
  const configured = f.setup.configure({ revision: 0, selection }); await started.promise;
  const external = { ...selection, model: 'other-explicit-model' }; await f.settings.save(external, 0);
  gate.resolve(); const result = await configured;
  assert.equal(result.phase, 'recoveryRequired'); assert.equal(result.available, false);
  assert.deepEqual(await f.settings.read(), { revision: 1, selection: external });
});

test('missing providers, damaged configuration and already configured installations cannot be overwritten', async t => {
  for (const overrides of [{ available: false }, { recoveryRequired: true }, { initial: { revision: 1, selection } }]) {
    const f = await fixture(t, overrides);
    assert.throws(() => f.setup.configure({ revision: 0, selection }), { code: 'SETUP_RUNTIME_UNAVAILABLE' });
    assert.equal(f.admissions(), 0); assert.equal(f.probes(), 0);
  }
});

test('stale input, account activity, denied admission and credential fields cannot begin verification', async t => {
  const f = await fixture(t);
  assert.throws(() => f.setup.configure({ revision: 5, selection }), { code: 'SETUP_STALE' });
  assert.throws(() => f.setup.configure({ revision: 0, selection: { ...selection, apiKey: 'PRIVATE' } as typeof selection }));
  f.options.assertAccountIdle = () => { throw new Error('account is active'); };
  assert.throws(() => f.setup.configure({ revision: 0, selection }), /account is active/);
  f.options.assertAccountIdle = () => {}; f.options.admit = () => { throw new Error('deployment is held'); };
  assert.throws(() => f.setup.configure({ revision: 0, selection }), /deployment is held/);
  assert.equal(f.setup.status().phase, 'unconfigured'); assert.equal(f.admissions(), 0); assert.equal(f.probes(), 0);
  await assert.rejects(readFile(join(f.root, 'desktop-runtime.json')), { code: 'ENOENT' });
});

test('explicit installation verifies and installs before probing and saving while progress is isolated', async t => {
  const installed = deferred(), entered = deferred(), order: string[] = []; t.after(() => installed.resolve());
  let report!: (progress: DesktopRuntimeInstallProgress) => void;
  const f = await fixture(t, { install: async (value, signal, onProgress) => {
    assert.deepEqual(value, selection); assert.equal(signal.aborted, false); report = onProgress;
    order.push('install'); onProgress({ stage: 'verifying', completed: 0, total: 2 }); entered.resolve(); await installed.promise;
    onProgress({ stage: 'loading', completed: 2, total: 2 });
  }, probe: async value => { assert.deepEqual(value, selection); order.push('probe'); } });
  assert.equal(f.setup.status().imageInstallAvailable, true);
  const pending = f.setup.install({ revision: 0, selection }); await entered.promise;
  assert.equal(f.setup.status().phase, 'installing'); assert.equal(f.admissions(), 1);
  const snapshot = f.setup.status(); assert.deepEqual(snapshot.progress, { stage: 'verifying', completed: 0, total: 2 });
  snapshot.progress!.completed = 1; assert.equal(f.setup.status().progress!.completed, 0);
  report({ stage: 'loading', completed: 1, total: 2 }); assert.equal(f.setup.status().revision, snapshot.revision);
  report({ stage: 'loading', completed: 10, total: 2 }); assert.equal(f.setup.status().progress!.completed, 1);
  assert.throws(() => f.setup.assertIdle(), { code: 'SETUP_RUNTIME_BUSY' });
  assert.throws(() => f.setup.configure({ revision: snapshot.revision, selection }), { code: 'SETUP_RUNTIME_BUSY' });
  assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
  installed.resolve(); const result = await pending; assert.deepEqual(order, ['install', 'probe']);
  assert.equal(result.phase, 'restartRequired'); assert.equal(result.progress, null); assert.equal(f.admissions(), 0);
  report({ stage: 'loading', completed: 0, total: 10 }); assert.deepEqual(f.setup.status(), result);
  assert.deepEqual(await f.settings.read(), { revision: 1, selection });
});

test('cancelling installation waits actual cleanup, blocks accounts and stores nothing, then permits explicit retry', async t => {
  const ended = deferred(), entered = deferred(); t.after(() => ended.resolve()); let signal!: AbortSignal, report!: (progress: DesktopRuntimeInstallProgress) => void;
  const f = await fixture(t, { install: async (_, active, onProgress) => { signal = active; report = onProgress; entered.resolve(); await ended.promise; } });
  const installing = f.setup.install({ revision: 0, selection }); await entered.promise;
  assert.throws(() => f.setup.cancel({ revision: 0 }), { code: 'SETUP_STALE' }); assert.equal(signal.aborted, false);
  const cancelled = f.setup.cancel({ revision: f.setup.status().revision }); let settled = false; void cancelled.then(() => { settled = true; });
  assert.equal(cancelled, installing); assert.equal(signal.aborted, true); assert.equal(f.setup.status().phase, 'canceling');
  report({ stage: 'loading', completed: 1, total: 2 }); assert.equal(f.setup.status().progress, null);
  await Promise.resolve(); assert.equal(settled, false); assert.equal(f.admissions(), 1);
  assert.throws(() => f.setup.assertIdle(), { code: 'SETUP_RUNTIME_BUSY' });
  assert.throws(() => f.setup.install({ revision: f.setup.status().revision, selection }), { code: 'SETUP_RUNTIME_BUSY' });
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
  ended.resolve(); const result = await cancelled;
  assert.equal(result.phase, 'unconfigured'); assert.equal(result.error?.code, 'SETUP_RUNTIME_CANCELLED');
  assert.equal(result.selection, null); assert.equal(f.admissions(), 0); assert.equal(f.probes(), 0);
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
  f.options.install = async () => {}; assert.equal((await f.setup.install({ revision: result.revision, selection })).phase, 'restartRequired');
});

test('cancel applies to probe-only verification and close waits the same cleanup without late progress updates', async t => {
  const ended = deferred(), entered = deferred(); t.after(() => ended.resolve()); let signal!: AbortSignal;
  const f = await fixture(t, { probe: async (_, active) => { signal = active; entered.resolve(); await ended.promise; } });
  const configuring = f.setup.configure({ revision: 0, selection }); await entered.promise;
  const cancelled = f.setup.cancel({ revision: f.setup.status().revision }); let closed = false;
  const closing = f.setup.close().then(() => { closed = true; });
  assert.equal(signal.aborted, true); assert.equal(f.setup.status().phase, 'closing');
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.admissions(), 1);
  ended.resolve(); await Promise.all([configuring, cancelled, closing]);
  assert.equal(f.setup.status().phase, 'closing'); assert.equal(f.admissions(), 0);
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
});

test('close during installation ignores late progress and cannot resolve before installer termination', async t => {
  const ended = deferred(), entered = deferred(); t.after(() => ended.resolve()); let report!: (progress: DesktopRuntimeInstallProgress) => void;
  const f = await fixture(t, { install: async (_, signal, progress) => {
    report = progress; entered.resolve(); await ended.promise; assert.equal(signal.aborted, true); progress({ stage: 'loading', completed: 2, total: 2 });
  } });
  const installing = f.setup.install({ revision: 0, selection }); await entered.promise;
  let complete = false; const close = f.setup.close().then(() => { complete = true; });
  const status = f.setup.status(); report({ stage: 'checking', completed: 1, total: 2 }); assert.deepEqual(f.setup.status(), status);
  await Promise.resolve(); assert.equal(complete, false); assert.equal(f.admissions(), 1);
  ended.resolve(); await Promise.all([close, installing]);
  assert.equal(f.setup.status().phase, 'closing'); assert.equal(f.setup.status().progress, null); assert.equal(f.probes(), 0);
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
});

test('an installation failure is redacted, does not probe or save and absence of installer blocks install only', async t => {
  const missing = await fixture(t); assert.equal(missing.setup.status().imageInstallAvailable, false);
  assert.throws(() => missing.setup.install({ revision: 0, selection }), { code: 'SETUP_RUNTIME_UNAVAILABLE' });
  assert.equal(missing.admissions(), 0); assert.equal((await missing.setup.configure({ revision: 0, selection })).phase, 'restartRequired');
  const f = await fixture(t, { install: async () => { throw new Error('PRIVATE_PATH_TOKEN_STDERR'); } });
  const failed = await f.setup.install({ revision: 0, selection });
  assert.equal(failed.phase, 'unconfigured'); assert.equal(failed.error?.code, 'SETUP_RUNTIME_INSTALL_FAILED');
  assert.ok(!JSON.stringify(failed).includes('PRIVATE')); assert.equal(f.probes(), 0); assert.equal(f.admissions(), 0);
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
});

test('cancellation after settings commit starts is rejected and close waits for the actual save', async t => {
  const ended = deferred(), saving = deferred(); t.after(() => ended.resolve());
  const f = await fixture(t, { install: async () => {} });
  f.options.settings = { ...f.settings, save: async (value, revision) => { saving.resolve(); await ended.promise; return f.settings.save(value, revision); } };
  const installing = f.setup.install({ revision: 0, selection }); await saving.promise;
  assert.equal(f.setup.status().phase, 'saving');
  assert.throws(() => f.setup.cancel({ revision: f.setup.status().revision }), { code: 'SETUP_RUNTIME_NOT_CANCELABLE' });
  let closed = false; const close = f.setup.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.admissions(), 1);
  ended.resolve(); await Promise.all([installing, close]);
  assert.equal(f.setup.status().phase, 'closing'); assert.deepEqual(f.setup.status().selection, selection);
  assert.equal(f.setup.status().error, null); assert.deepEqual(await f.settings.read(), { revision: 1, selection }); assert.equal(f.admissions(), 0);
});

test('uncertain installer completion wins over cancellation and blocks retries without saving', async t => {
  const ended = deferred(), entered = deferred(); t.after(() => ended.resolve());
  const f = await fixture(t, { install: async () => {
    entered.resolve(); await ended.promise; throw Object.assign(new Error('PRIVATE_LOAD_STDERR'), { code: 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN' });
  } });
  const installing = f.setup.install({ revision: 0, selection }); await entered.promise;
  const cancelled = f.setup.cancel({ revision: f.setup.status().revision }); ended.resolve();
  const result = await cancelled; await installing;
  assert.equal(result.phase, 'recoveryRequired'); assert.equal(result.available, false); assert.equal(result.imageInstallAvailable, false);
  assert.equal(result.error?.code, 'SETUP_RUNTIME_INSTALL_UNCERTAIN'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.throws(() => f.setup.install({ revision: result.revision, selection }), { code: 'SETUP_RUNTIME_UNAVAILABLE' });
  assert.throws(() => f.setup.configure({ revision: result.revision, selection }), { code: 'SETUP_RUNTIME_UNAVAILABLE' });
  assert.equal(f.probes(), 0); assert.equal(f.admissions(), 0); assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
});

test('recovery diagnosis holds admission, returns isolated metadata and never installs, probes or saves', async t => {
  const entered = deferred(), ended = deferred(); t.after(() => ended.resolve()); const info = recoveryInfo();
  const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async () => { entered.resolve(); await ended.promise; return info; },
    recover: async () => assert.fail('diagnosis must not load images'), finish: async () => assert.fail('diagnosis must not clear records') } });
  assert.equal(f.setup.status().recoveryAvailable, true);
  assert.throws(() => f.setup.recover({ revision: 0 }), { code: 'SETUP_RUNTIME_RECOVERY_UNAVAILABLE' });
  assert.throws(() => f.setup.inspectRecovery({ revision: 9 }), { code: 'SETUP_STALE' });
  const pending = f.setup.inspectRecovery({ revision: 0 }); await entered.promise;
  assert.equal(f.setup.status().phase, 'diagnosing'); assert.equal(f.admissions(), 1);
  assert.throws(() => f.setup.assertIdle(), { code: 'SETUP_RUNTIME_BUSY' });
  ended.resolve(); const status = await pending;
  assert.equal(status.phase, 'recoveryRequired'); assert.deepEqual(status.recovery, info); assert.equal(f.admissions(), 0); assert.equal(f.probes(), 0);
  status.recovery!.selection.model = 'MUTATED'; info.images[0].status = 'missing';
  assert.equal(f.setup.status().recovery!.selection.model, selection.model); assert.equal(f.setup.status().recovery!.images[0].status, 'present');
  assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
});

test('explicit recovery replays server-held diagnosis, probes, saves once and waits for record completion', async t => {
  const entered = deferred(), ended = deferred(); t.after(() => ended.resolve()); const order: string[] = [];
  const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async () => recoveryInfo(),
    recover: async (info, signal, progress) => { order.push('recover'); assert.deepEqual(info, recoveryInfo()); assert.equal(signal.aborted, false);
      progress({ stage: 'loading', completed: 1, total: 2 }); info.selection.model = 'MUTATED'; },
    finish: async info => { order.push('finish'); assert.deepEqual(info, recoveryInfo()); entered.resolve(); await ended.promise; } },
    probe: async value => { order.push('probe'); assert.deepEqual(value, selection); } });
  const save = f.settings.save;
  f.options.settings = { ...f.settings, save: async (value, revision) => { order.push('save'); return save(value, revision); } };
  await f.setup.inspectRecovery({ revision: 0 });
  const recovering = f.setup.recover({ revision: f.setup.status().revision }); await entered.promise;
  assert.deepEqual(order, ['recover', 'probe', 'save', 'finish']); assert.equal(f.setup.status().phase, 'saving'); assert.equal(f.admissions(), 1);
  assert.throws(() => f.setup.cancel({ revision: f.setup.status().revision }), { code: 'SETUP_RUNTIME_NOT_CANCELABLE' });
  assert.deepEqual(await f.settings.read(), { revision: 1, selection });
  ended.resolve(); const result = await recovering;
  assert.equal(result.phase, 'restartRequired'); assert.equal(result.recovery, null); assert.deepEqual(result.selection, selection); assert.equal(f.admissions(), 0);
  assert.throws(() => f.setup.inspectRecovery({ revision: result.revision }), { code: 'SETUP_RUNTIME_RECOVERY_UNAVAILABLE' });
});

test('a finish failure retains the saved revision and a new diagnosis/retry never overwrites settings', async t => {
  let finishes = 0, saves = 0;
  const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async () => recoveryInfo(), recover: async () => {},
    finish: async () => { if (++finishes === 1) throw new Error('PRIVATE_MARKER_PATH'); } } });
  f.options.settings = { ...f.settings, save: async (value, revision) => { saves++; return f.settings.save(value, revision); } };
  await f.setup.inspectRecovery({ revision: 0 });
  const failed = await f.setup.recover({ revision: f.setup.status().revision });
  assert.equal(failed.phase, 'recoveryRequired'); assert.equal(failed.recovery, null); assert.deepEqual(failed.selection, selection);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE')); assert.equal(saves, 1); assert.equal(finishes, 1);
  await f.setup.inspectRecovery({ revision: failed.revision });
  assert.equal((await f.setup.recover({ revision: f.setup.status().revision })).phase, 'restartRequired');
  assert.equal(saves, 1); assert.equal(finishes, 2); assert.deepEqual(await f.settings.read(), { revision: 1, selection });
});

test('restart after save reuses only a matching initial settings snapshot and rejects revision or selection changes', async t => {
  for (const mismatch of ['none', 'selection', 'revision', 'unknown'] as const) {
    const f = await fixture(t); const saved = await f.settings.save(selection, 0); let finishes = 0, loads = 0;
    const initial = mismatch === 'unknown' ? null : mismatch === 'revision' ? { ...saved, revision: 0 } : saved;
    const setup = new DesktopRuntimeSetup({ ...f.options, initial, recoveryRequired: true,
      settings: { ...f.settings, save: async () => assert.fail('existing settings must not be overwritten') },
      recovery: { inspect: async () => ({ ...recoveryInfo(), selection: mismatch === 'selection' ? { ...selection, model: 'other-model' } : selection }),
        recover: async () => { loads++; }, finish: async () => { finishes++; } } });
    t.after(() => setup.close());
    const diagnosed = await setup.inspectRecovery({ revision: 0 });
    if (mismatch === 'none') { assert.equal((await setup.recover({ revision: diagnosed.revision })).phase, 'restartRequired'); assert.equal(finishes, 1); assert.equal(loads, 1); }
    else { assert.equal(diagnosed.recovery, null); assert.equal(diagnosed.error?.code, 'SETUP_RUNTIME_RECOVERY_FAILED'); assert.equal(finishes, 0); assert.equal(loads, 0); }
    assert.deepEqual(await f.settings.read(), saved);
  }
});

test('recovery cancellation holds admission until actual completion and requires a new diagnosis without saving', async t => {
  for (const stage of ['inspect', 'recover', 'probe'] as const) {
    const entered = deferred(), ended = deferred(); t.after(() => ended.resolve()); let active!: AbortSignal, report: ((p: DesktopRuntimeInstallProgress) => void) | undefined;
    const pause = async (signal: AbortSignal) => { active = signal; entered.resolve(); await ended.promise; };
    const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async signal => { if (stage === 'inspect') await pause(signal); return recoveryInfo(); },
      recover: async (_, signal, progress) => { report = progress; if (stage === 'recover') await pause(signal); },
      finish: async () => assert.fail('cancel must retain the record') }, probe: async (_, signal) => { if (stage === 'probe') await pause(signal); } });
    if (stage !== 'inspect') await f.setup.inspectRecovery({ revision: 0 });
    const pending = stage === 'inspect' ? f.setup.inspectRecovery({ revision: 0 }) : f.setup.recover({ revision: f.setup.status().revision });
    await entered.promise; const before = f.setup.status(); report?.({ stage: 'loading', completed: 1, total: 2 });
    assert.equal(f.setup.status().revision, before.revision);
    const cancelled = f.setup.cancel({ revision: before.revision }); let settled = false; void cancelled.then(() => { settled = true; });
    assert.equal(active.aborted, true); assert.equal(cancelled, pending); assert.equal(f.setup.status().phase, 'canceling');
    report?.({ stage: 'loading', completed: 2, total: 2 }); assert.equal(f.setup.status().progress, null);
    await Promise.resolve(); assert.equal(settled, false); assert.equal(f.admissions(), 1);
    ended.resolve(); const result = await cancelled;
    assert.equal(result.phase, 'recoveryRequired'); assert.equal(result.error?.code, 'SETUP_RUNTIME_RECOVERY_CANCELLED'); assert.equal(result.recovery, null);
    assert.equal(f.admissions(), 0); assert.deepEqual(await readdir(f.root), ['desktop-installation.json']);
  }
});

test('recovery close waits record finalization and cannot turn a committed write into cancellation', async t => {
  const entered = deferred(), ended = deferred(); t.after(() => ended.resolve());
  const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async () => recoveryInfo(), recover: async () => {},
    finish: async () => { entered.resolve(); await ended.promise; } } });
  await f.setup.inspectRecovery({ revision: 0 }); const pending = f.setup.recover({ revision: f.setup.status().revision }); await entered.promise;
  let closed = false; const close = f.setup.close().then(() => { closed = true; }); await Promise.resolve();
  assert.equal(closed, false); assert.equal(f.admissions(), 1); assert.equal(f.setup.status().phase, 'closing');
  ended.resolve(); await Promise.all([pending, close]); assert.equal(f.admissions(), 0); assert.equal(f.setup.status().error, null);
  assert.deepEqual(await f.settings.read(), { revision: 1, selection });
});

test('invalid diagnosis, external settings mutation and unavailable recovery fail closed with fixed messages', async t => {
  for (const malformed of [{ ...recoveryInfo(), fingerprint: 'PRIVATE_PATH' }, { ...recoveryInfo(), token: 'PRIVATE_TOKEN' },
    { ...recoveryInfo(), images: [{ kind: 'worker', status: 'present' }, { kind: 'worker', status: 'missing' }] }]) {
    const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async () => malformed as DesktopRuntimeRecoveryInfo,
      recover: async () => assert.fail(), finish: async () => assert.fail() } });
    const result = await f.setup.inspectRecovery({ revision: 0 }); assert.equal(result.recovery, null); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.deepEqual(await f.settings.read(), { revision: 0, selection: null });
  }
  const f = await fixture(t, { recoveryRequired: true, recovery: { inspect: async () => recoveryInfo(), recover: async () => {}, finish: async () => assert.fail() },
    probe: async () => { await f.settings.save({ ...selection, model: 'external' }, 0); } });
  await f.setup.inspectRecovery({ revision: 0 }); const failed = await f.setup.recover({ revision: f.setup.status().revision });
  assert.equal(failed.error?.code, 'SETUP_RUNTIME_RECOVERY_FAILED'); assert.equal((await f.settings.read()).selection!.model, 'external');
  const missing = await fixture(t, { recoveryRequired: true }); assert.equal(missing.setup.status().recoveryAvailable, false);
  assert.throws(() => missing.setup.inspectRecovery({ revision: 0 }), { code: 'SETUP_RUNTIME_RECOVERY_UNAVAILABLE' });
});
