import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectImageRuntimeBase, baseFingerprintScript } from '../server/image-fingerprint.ts';
import type { RuntimeConfig } from '../server/runtime.ts';
import type { Command, CommandOptions } from '../server/process.ts';

const image = `sha256:${'a'.repeat(64)}`;
const ownerKey = '842d7b15-e353-419a-9589-b363741e511d';
const config: RuntimeConfig = { mode: 'docker', image, model: 'fixture', auth: 'none', authFile: '', timeoutMs: 1000 };
const chunks = [Buffer.from([0, 255, 254, 0, 13, 10]), Buffer.from([128, 195, 40, 0, 65])];
const filesystem = 'b'.repeat(64);
interface Recorded { file: string; args: string[]; options: CommandOptions }
function fixture(options: { failure?: 'export' | 'parser'; foreignExportOwner?: boolean; volumes?: Record<string, object> | null; distro?: string } = {}) {
  const calls: Recorded[] = [], received: Buffer[] = [], labels = new Map<string, Record<string, string>>(), removed: string[] = [];
  let exportSignal: AbortSignal | undefined, parserSignal: AbortSignal | undefined, exportName: string | undefined;
  let exportEntered!: () => void;
  const entered = new Promise<void>(resolve => { exportEntered = resolve; });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const normalized = (file: string, args: string[]) => {
    if (options.distro) {
      assert.equal(file, 'wsl.exe'); assert.deepEqual(args.slice(0, 4), ['--distribution', options.distro, '--exec', 'docker']);
      return args.slice(4);
    }
    assert.equal(file, 'docker'); return args;
  };
  const retainLabels = (args: string[]) => {
    const name = args[args.indexOf('--name') + 1], value: Record<string, string> = {};
    for (let index = 0; index < args.length; index++) if (args[index] === '--label') {
      const [key, ...parts] = args[index + 1].split('='); value[key] = parts.join('=');
    }
    labels.set(name, value); return name;
  };
  const runner: Command = async (file, rawArgs, commandOptions = {}) => {
    const args = normalized(file, rawArgs); calls.push({ file, args, options: commandOptions });
    if (args[0] === 'image' && args[1] === 'inspect') return ok(JSON.stringify({ Id: image, Os: 'linux', Architecture: 'amd64',
      Config: { User: '1000:1000', Volumes: options.volumes ?? null, Env: ['FIXTURE=true'] } }));
    if (args[0] === 'create') { exportName = retainLabels(args); return ok('c'.repeat(64)); }
    if (args[0] === 'export') {
      exportSignal = commandOptions.signal; exportEntered();
      assert.equal(commandOptions.captureStdout, false);
      assert.equal(commandOptions.onLine, undefined);
      assert.equal(commandOptions.input, undefined);
      assert.ok(commandOptions.onStdout, 'export transfers bounded binary chunks');
      await commandOptions.onStdout(chunks[0]);
      if (options.failure === 'export') return { code: 19, stdout: '', stderr: 'fixture export failure' };
      if (options.failure === 'parser') {
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(new Error('fixture export aborted'));
          if (exportSignal?.aborted) stop(); else exportSignal?.addEventListener('abort', stop, { once: true });
        });
      }
      await commandOptions.onStdout(chunks[1]); return ok();
    }
    if (args[0] === 'run') {
      retainLabels(args); parserSignal = commandOptions.signal;
      assert.ok(commandOptions.inputStream, 'parser receives an asynchronous binary stream');
      assert.equal(commandOptions.input, undefined);
      if (options.failure === 'parser') { await entered; return { code: 23, stdout: '', stderr: 'fixture parser failure' }; }
      try { for await (const chunk of commandOptions.inputStream) received.push(Buffer.from(chunk)); }
      catch (error) { if (options.failure !== 'export') throw error; return { code: 1, stdout: '', stderr: 'fixture parser cancelled' }; }
      return ok(filesystem);
    }
    if (args[0] === 'inspect') {
      const name = args[1], actual = labels.get(name);
      if (!actual) return { code: 1, stdout: '', stderr: 'No such container' };
      const selected = options.foreignExportOwner && name === exportName ? { ...actual, 'agent-company.workspace': 'someone-else' } : actual;
      return ok(JSON.stringify(selected));
    }
    if (args[0] === 'rm') { const name = args.at(-1)!; removed.push(name); labels.delete(name); return ok(); }
    throw new Error(`Unexpected fixture Docker command: ${args.join(' ')}`);
  };
  return { runner, calls, received, removed, labels, exportName: () => exportName, exportSignal: () => exportSignal, parserSignal: () => parserSignal };
}

test('image fingerprint streams raw export bytes into an unprivileged parser and removes only its helpers', { timeout: 5000 }, async () => {
  const h = fixture();
  assert.match(await inspectImageRuntimeBase(config, image, ownerKey, h.runner), /^[a-f0-9]{64}$/);
  assert.deepEqual(Buffer.concat(h.received), Buffer.concat(chunks), 'binary bytes must not pass through a text decoder');
  const create = h.calls.find(call => call.args[0] === 'create')!, parser = h.calls.find(call => call.args[0] === 'run')!;
  assert.ok(create.args.includes(image)); assert.ok(parser.args.includes(image)); assert.ok(parser.args.includes(baseFingerprintScript));
  assert.ok(parser.args.includes('--user=1000:1000')); assert.ok(parser.args.includes('--cap-drop=ALL'));
  assert.ok(parser.args.includes('--read-only')); assert.ok(parser.args.includes('--network=none'));
  assert.ok(parser.args.includes('--security-opt=no-new-privileges:true'));
  assert.equal(h.calls.some(call => call.args.includes('--privileged') || call.args.includes('--cap-add=DAC_READ_SEARCH') || call.args.includes('--security-opt=seccomp=unconfined')), false);
  assert.equal(h.calls.some(call => call.args[0] === 'start'), false, 'the exported target image is never started');
  assert.equal(h.labels.size, 0); assert.equal(h.removed.length, 2);
});

test('WSL image fingerprint forwards binary callbacks without invoking an intermediate shell', { timeout: 5000 }, async () => {
  const h = fixture({ distro: 'fixture-distro' });
  await inspectImageRuntimeBase({ ...config, wslDistro: 'fixture-distro' }, image, ownerKey, h.runner);
  assert.deepEqual(Buffer.concat(h.received), Buffer.concat(chunks));
  assert.ok(h.calls.every(call => call.file === 'wsl.exe'));
});

test('export failure cancels the parser and settles cleanup without returning a fingerprint', { timeout: 5000 }, async () => {
  const h = fixture({ failure: 'export' });
  await assert.rejects(inspectImageRuntimeBase(config, image, ownerKey, h.runner), /export failure|fingerprint|파일시스템/);
  assert.equal(h.parserSignal()?.aborted, true); assert.equal(h.labels.size, 0);
});

test('parser failure aborts an unfinished export and waits for both helper cleanups', { timeout: 5000 }, async () => {
  const h = fixture({ failure: 'parser' });
  await assert.rejects(inspectImageRuntimeBase(config, image, ownerKey, h.runner), /parser failure|fingerprint|파일시스템/);
  assert.equal(h.exportSignal()?.aborted, true); assert.equal(h.labels.size, 0);
});

test('cleanup refuses a same-name target with different workspace ownership', { timeout: 5000 }, async () => {
  const h = fixture({ foreignExportOwner: true });
  await assert.rejects(inspectImageRuntimeBase(config, image, ownerKey, h.runner), error => error instanceof AggregateError
    && error.errors.some(cause => cause instanceof Error && /소유권|owner/.test(cause.message)));
  assert.ok(h.exportName()); assert.equal(h.removed.includes(h.exportName()!), false);
});

test('image-defined volumes are rejected before creating or running an incomplete export', async () => {
  const h = fixture({ volumes: { '/private-data': {} } });
  await assert.rejects(inspectImageRuntimeBase(config, image, ownerKey, h.runner), /volume|볼륨/i);
  assert.equal(h.calls.some(call => ['create', 'run', 'export'].includes(call.args[0])), false);
});
