import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createDesktopDockerTarget } from '../server/desktop-docker-target.ts';
import type { Command, CommandOptions } from '../server/process.ts';

type Call = { file: string; args: string[]; options: CommandOptions };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-desktop-target-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}ac-desktop-target-`));
    await rm(root, { recursive: true, force: true });
  });
  const wslExecutable = join(root, 'wsl.exe'); await writeFile(wslExecutable, 'fixture: never executed');
  const dockerConfigDir = join(root, '개인 Docker 설정'), distro = 'Ubuntu-24.04', calls: Call[] = [];
  const mappings = new Map<string, string>();
  let list = `${distro}\r\n`, utf16 = true, malformedBack = false, forwardSuffix = '', dockerCode = 0;
  const runner: Command = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    assert.equal(file, wslExecutable);
    if (args[0] === '--list') {
      if (utf16) { await options.onStdout?.(Buffer.from(list, 'utf16le')); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: list, stderr: '' };
    }
    assert.deepEqual(args.slice(0, 7), ['--distribution', distro, '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8']);
    const program = args.findIndex(arg => ['/usr/bin/wslpath', '/usr/bin/docker'].includes(arg));
    assert.ok(program === 7 || program === 8 && args[7].startsWith('BUILDX_CONFIG=/'));
    if (args[program] === '/usr/bin/wslpath') {
      if (args[program + 2] === '-u') {
        const path = args[program + 3], mapped = `/mnt/c/fixture/${mappings.size}/한글 space,comma/${path.endsWith('auth.json') ? 'auth.json' : 'file'}`;
        mappings.set(mapped, path);
        return { code: 0, stdout: `${mapped}${forwardSuffix}\n`, stderr: '' };
      }
      assert.equal(args[program + 2], '-w');
      return { code: 0, stdout: `${malformedBack ? join(root, 'different') : mappings.get(args[program + 3])}\r\n`, stderr: '' };
    }
    assert.equal(args[program], '/usr/bin/docker');
    return { code: dockerCode, stdout: 'fixture-output', stderr: 'fixture-stderr' };
  };
  const options = { wslExecutable, dockerConfigDir, distro, runner };
  return { root, options, calls, mappings, setList(value: string, encoded = true) { list = value; utf16 = encoded; },
    badBack() { malformedBack = true; }, badForward(value: string) { forwardSuffix = value; }, failDocker() { dockerCode = 2; } };
}
const privateError = (error: unknown) => {
  assert.ok(error instanceof Error && 'code' in error);
  assert.match(String(error.code), /^DESKTOP_DOCKER_TARGET_(INVALID|FAILED)$/);
  assert.equal(error.message, error.code); assert.equal('cause' in error, false);
  return true;
};

test('local target pins WSL distro, absolute Linux programs, clean environments, socket and private config', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget(f.options);
  const controller = new AbortController(), onLine = () => undefined;
  const result = await target.command('docker', ['ps', '-aq'], {
    env: { DOCKER_HOST: 'tcp://private-elsewhere', OPENAI_API_KEY: 'PRIVATE', NODE_OPTIONS: '--require=private' },
    signal: controller.signal, timeoutMs: 321, input: 'fixture-input', onLine,
  });
  assert.equal(result.code, 0);
  const call = f.calls.at(-1)!;
  assert.deepEqual(call.args.slice(7), ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', '--config', [...f.mappings.keys()][0], 'ps', '-aq']);
  for (const item of f.calls) {
    assert.ok(Object.keys(item.options.env!).every(key => ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].includes(key)));
    assert.equal(item.options.env?.DOCKER_HOST, undefined); assert.equal(item.options.env?.OPENAI_API_KEY, undefined);
  }
  assert.equal(call.options.signal, controller.signal); assert.equal(call.options.timeoutMs, 321);
  assert.equal(call.options.input, 'fixture-input'); assert.equal(call.options.onLine, onLine);
  assert.deepEqual(JSON.parse(await readFile(join(f.options.dockerConfigDir, 'config.json'), 'utf8')), {});
  await createDesktopDockerTarget(f.options); // Its exact owned directory can be reopened.
});

test('mapping requires a regular explicit file and the same-distro reverse path, retaining Unicode and spaces', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget(f.options);
  const auth = join(f.root, 'auth.json'), seccomp = join(f.root, '프로필 space,comma.json');
  await writeFile(auth, '{"fixture":true}'); await writeFile(seccomp, '{}');
  const source = await target.mapAuthFile(auth);
  assert.ok(source.endsWith('/auth.json'));
  assert.ok((await target.mapFile(seccomp)).startsWith('/mnt/c/fixture/'));
  await assert.rejects(target.mapAuthFile(seccomp), privateError);
  f.badBack(); await assert.rejects(target.mapAuthFile(auth), privateError);
});

test('remote/global Docker options, host commands and already wrapped WSL invocations cannot bypass the target', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget(f.options), baseline = f.calls.length;
  for (const [file, args] of [['wsl.exe', ['--exec', 'docker']], [f.options.wslExecutable, ['--exec', 'docker']],
    ['cmd.exe', ['/c', 'docker']], ['kubectl', ['version']], ['docker', ['--host', 'tcp://other', 'ps']],
    ['docker', ['ps', '--context=other']], ['docker', ['ps', '-cother']], ['docker', ['ps', '-Htcp://other']], ['docker', ['run', '--config', '/private']],
    ['docker', ['login']], ['docker', ['context', 'use', 'other']]] as Array<[string, string[]]>) {
    await assert.rejects(target.command(file, args), privateError);
  }
  assert.equal(f.calls.length, baseline);
});

test('only an explicit Docker delimiter with an immutable run/create image permits container argument flags', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget(f.options), image = `sha256:${'a'.repeat(64)}`;
  for (const action of ['run', 'create']) {
    const args = [action, '--read-only', '--entrypoint=python3', '--', image, '-B', '-c', 'print("fixture")'];
    await target.command('docker', args);
    assert.deepEqual(f.calls.at(-1)!.args.slice(-args.length), args);
  }
  const baseline = f.calls.length;
  for (const args of [['run', image, '-c', 'no boundary'], ['run', '--', 'worker:latest', '-c', 'script'],
    ['run', '--'], ['ps', '--', image, '-cother'], ['build', '--', image, '-cother'],
    ['run', '--host', 'tcp://other', '--', image, '-c', 'script'],
    ['run', '-cother', '--', image, '-c', 'script'], ['create', '--context=other', '--', image],
    ['run', '--', image.toUpperCase(), '-c', 'script']]) {
    await assert.rejects(target.command('docker', args), privateError);
  }
  assert.equal(f.calls.length, baseline);
});

test('unregistered, duplicate or malformed distro inventory is refused without creating config', async t => {
  const f = await fixture(t);
  for (const value of ['Other\r\n', `${f.options.distro}\n${f.options.distro}\n`, ` ${f.options.distro}\n`, `${f.options.distro}\n\u0001`]) {
    f.setList(value); await assert.rejects(createDesktopDockerTarget(f.options), privateError);
  }
  assert.deepEqual(await readdir(f.root), ['wsl.exe']);
  f.setList(`${f.options.distro}\n`, false);
  await createDesktopDockerTarget(f.options);
});

test('an existing unowned Docker config is never adopted or overwritten', async t => {
  const f = await fixture(t); await mkdir(f.options.dockerConfigDir);
  const path = join(f.options.dockerConfigDir, 'config.json'), contents = '{"credsStore":"PRIVATE_EXISTING_STORE"}';
  await writeFile(path, contents);
  await assert.rejects(createDesktopDockerTarget(f.options), privateError);
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('changed Docker config is refused before commands or path mapping can adopt credentials/context', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget(f.options), baseline = f.calls.length;
  await writeFile(join(f.options.dockerConfigDir, 'config.json'), '{"currentContext":"private-context"}');
  await assert.rejects(target.command('docker', ['version']), privateError);
  assert.equal(f.calls.length, baseline);
});

test('mapped source hard links, redirected config parents and malformed output are refused', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget(f.options), auth = join(f.root, 'auth.json');
  await writeFile(auth, '{}'); await link(auth, join(f.root, 'alias'));
  await assert.rejects(target.mapAuthFile(auth), privateError);
  await rm(join(f.root, 'alias'));
  f.badForward('\n/mnt/c/other'); await assert.rejects(target.mapAuthFile(auth), privateError);
  const real = join(f.root, 'actual'); await mkdir(real);
  const redirected = join(f.root, 'redirected'); await symlink(real, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createDesktopDockerTarget({ ...f.options, dockerConfigDir: join(redirected, 'config') }), privateError);
  assert.deepEqual(await readdir(real), []);
});

test('spawn errors are redacted and a missing explicit executable has no fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(createDesktopDockerTarget({ ...f.options, runner: async () => { throw new Error('PRIVATE_WSL_PATH_AND_ENV'); } }), privateError);
  await assert.rejects(createDesktopDockerTarget({ ...f.options, wslExecutable: join(f.root, 'missing', 'wsl.exe') }), privateError);
  assert.equal(f.calls.length, 0);
});

test('build-only target routes Buildx state to a separate owned directory and keeps Docker config at two files', async t => {
  const f = await fixture(t), buildxConfigDir = join(f.root, '별도 Buildx 상태');
  const target = await createDesktopDockerTarget({ ...f.options, buildxConfigDir });
  const mapped = [...f.mappings].find(([, value]) => value === buildxConfigDir)![0];
  await mkdir(join(buildxConfigDir, 'activity')); await writeFile(join(buildxConfigDir, 'activity', 'fixture'), 'build state');
  await target.command('docker', ['build', '--file', '/fixture/Dockerfile', '/fixture'], { env: { BUILDX_CONFIG: '/foreign/host/state' } });
  const call = f.calls.at(-1)!;
  assert.equal(call.args[7], `BUILDX_CONFIG=${mapped}`); assert.equal(call.args[8], '/usr/bin/docker');
  assert.equal(call.options.env?.BUILDX_CONFIG, undefined);
  assert.deepEqual((await readdir(f.options.dockerConfigDir)).sort(), ['config.json', 'desktop-docker-target.json']);
  assert.deepEqual((await readdir(buildxConfigDir)).sort(), ['activity', 'desktop-buildx-target.json']);
  assert.equal(JSON.parse(await readFile(join(buildxConfigDir, 'desktop-buildx-target.json'), 'utf8')).dockerConfigDir, f.options.dockerConfigDir);
  const noBuildx = await fixture(t); const ordinary = await createDesktopDockerTarget(noBuildx.options);
  await ordinary.command('docker', ['version']);
  assert.ok(noBuildx.calls.every(item => item.args.every(arg => !arg.startsWith('BUILDX_CONFIG='))));
});

test('Buildx state is never adopted from an existing unowned or previously owned directory', async t => {
  const f = await fixture(t), buildxConfigDir = join(f.root, 'existing-state');
  await mkdir(buildxConfigDir); await writeFile(join(buildxConfigDir, 'preserved'), 'FOREIGN_STATE');
  await assert.rejects(createDesktopDockerTarget({ ...f.options, buildxConfigDir }), privateError);
  assert.equal(await readFile(join(buildxConfigDir, 'preserved'), 'utf8'), 'FOREIGN_STATE');
  const fresh = join(f.root, 'owned-state'); await createDesktopDockerTarget({ ...f.options, buildxConfigDir: fresh });
  const before = await readFile(join(fresh, 'desktop-buildx-target.json'));
  await assert.rejects(createDesktopDockerTarget({ ...f.options, buildxConfigDir: fresh }), privateError);
  assert.deepEqual(await readFile(join(fresh, 'desktop-buildx-target.json')), before);
});

test('relative, overlapping and redirected Buildx paths cannot create a state directory', async t => {
  const f = await fixture(t);
  for (const buildxConfigDir of ['buildx-state', f.options.dockerConfigDir, join(f.options.dockerConfigDir, 'buildx'), f.root]) {
    await assert.rejects(createDesktopDockerTarget({ ...f.options, buildxConfigDir }), privateError);
  }
  assert.equal(f.calls.length, 0);
  const actual = join(f.root, 'actual'), redirect = join(f.root, 'redirect'); await mkdir(actual);
  await symlink(actual, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createDesktopDockerTarget({ ...f.options, buildxConfigDir: join(redirect, 'state') }), privateError);
  assert.deepEqual(await readdir(actual), []);
});

test('Buildx directory replacement and marker modification fail before another Docker command', async t => {
  const f = await fixture(t), buildxConfigDir = join(f.root, 'buildx-state');
  const target = await createDesktopDockerTarget({ ...f.options, buildxConfigDir }), baseline = f.calls.length;
  const marker = join(buildxConfigDir, 'desktop-buildx-target.json'), original = await readFile(marker, 'utf8');
  await writeFile(marker, JSON.stringify({ ...JSON.parse(original), distro: 'Other' }));
  await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
  await writeFile(marker, original);
  await link(marker, join(f.root, 'marker-alias'));
  await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
  await rm(join(f.root, 'marker-alias'));
  await rename(buildxConfigDir, join(f.root, 'previous-buildx'));
  const actual = join(f.root, 'replacement'); await mkdir(actual);
  await symlink(actual, buildxConfigDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
  assert.deepEqual(await readdir(actual), []);
});

test('build-only targets preserve bounded BuildKit seed files while retaining empty Docker config and isolated environments', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget({ ...f.options, buildxConfigDir: join(f.root, 'buildx-state') });
  const seed = join(f.options.dockerConfigDir, '.token_seed'), lock = join(f.options.dockerConfigDir, '.token_seed.lock');
  const bytes = Buffer.from(JSON.stringify({ 'registry-1.docker.io': { Seed: Buffer.alloc(16).toString('base64') } }));
  await writeFile(seed, bytes); await writeFile(lock, '');
  await target.command('docker', ['image', 'inspect', `sha256:${'a'.repeat(64)}`]);
  assert.deepEqual(await readFile(seed), bytes); assert.equal((await readFile(lock)).length, 0);
  assert.deepEqual((await readdir(f.options.dockerConfigDir)).sort(), ['.token_seed', '.token_seed.lock', 'config.json', 'desktop-docker-target.json']);
  assert.deepEqual(JSON.parse(await readFile(join(f.options.dockerConfigDir, 'config.json'), 'utf8')), {});
  const call = f.calls.at(-1)!;
  assert.ok(call.args[7].startsWith('BUILDX_CONFIG='));
  assert.ok(Object.keys(call.options.env!).every(key => ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].includes(key)));
  await writeFile(seed, Buffer.alloc(64 * 1024));
  await target.command('docker', ['version']); // The boundary is explicit, not the 74-byte observed fixture size.
  await writeFile(join(f.options.dockerConfigDir, 'config.json'), '{"auths":{"private":{}}}');
  const baseline = f.calls.length;
  await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
});

test('ordinary runtime targets reject either BuildKit file before another command', async t => {
  for (const name of ['.token_seed', '.token_seed.lock']) {
    const f = await fixture(t), target = await createDesktopDockerTarget(f.options), baseline = f.calls.length;
    await writeFile(join(f.options.dockerConfigDir, name), name.endsWith('.lock') ? '' : '{}');
    await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
    await assert.rejects(createDesktopDockerTarget(f.options), privateError);
  }
});

test('build seed allowance refuses extra names, nested paths, nonempty lock and oversized seeds before spawning', async t => {
  for (const name of ['.token_seed.other', '.token_seed.lock.other', 'tokens', '.token_seed', '.token_seed.lock']) {
    const f = await fixture(t), target = await createDesktopDockerTarget({ ...f.options, buildxConfigDir: join(f.root, 'buildx-state') });
    if (name === 'tokens') { await mkdir(join(f.options.dockerConfigDir, name)); await writeFile(join(f.options.dockerConfigDir, name, '.token_seed'), '{}'); }
    else await writeFile(join(f.options.dockerConfigDir, name), name === '.token_seed' ? Buffer.alloc(64 * 1024 + 1) : 'x');
    const baseline = f.calls.length;
    await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
  }
});

test('build seed names cannot be directories, hard links or redirected directory links', async t => {
  for (const name of ['.token_seed', '.token_seed.lock']) {
    for (const kind of ['directory', 'hardlink', 'junction']) {
      const f = await fixture(t), target = await createDesktopDockerTarget({ ...f.options, buildxConfigDir: join(f.root, 'buildx-state') });
      const path = join(f.options.dockerConfigDir, name), outside = join(f.root, 'outside');
      if (kind === 'directory') await mkdir(path);
      else if (kind === 'hardlink') { await writeFile(outside, ''); await link(outside, path); }
      else { await mkdir(outside); await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir'); }
      const baseline = f.calls.length;
      await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
      if (kind === 'hardlink') assert.equal((await readFile(outside)).length, 0);
      else if (kind === 'junction') assert.deepEqual(await readdir(outside), []);
    }
  }
});

test('build seed file symlinks are refused without reading their target', async t => {
  const f = await fixture(t), target = await createDesktopDockerTarget({ ...f.options, buildxConfigDir: join(f.root, 'buildx-state') });
  const outside = join(f.root, 'outside'); await writeFile(outside, 'PRIVATE_FIXTURE_NOT_ADOPTED');
  try { await symlink(outside, join(f.options.dockerConfigDir, '.token_seed'), 'file'); }
  catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows file symlink permission unavailable'); return; } throw error; }
  const baseline = f.calls.length;
  await assert.rejects(target.command('docker', ['version']), privateError); assert.equal(f.calls.length, baseline);
  assert.equal(await readFile(outside, 'utf8'), 'PRIVATE_FIXTURE_NOT_ADOPTED');
});
