import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { command, type Command } from '../server/process.ts';
import { buildDesktopInstaller, desktopInstallerConfig, desktopNsisExecutablePin, desktopNativeSources } from '../scripts/desktop-installer.ts';
import base from '../desktop/src-tauri/tauri.conf.json' with { type: 'json' };

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const target = 'x86_64-pc-windows-msvc';
function pe(x64: boolean) {
  const data = Buffer.alloc(256); data.writeUInt16LE(0x5a4d); data.writeUInt32LE(64, 0x3c);
  data.writeUInt32LE(0x4550, 64); data.writeUInt16LE(x64 ? 0x8664 : 0x014c, 68); data.writeUInt16LE(x64 ? 0x20b : 0x10b, 88);
  if (x64) data.write('__TAURI_BUNDLE_TYPE_VAR_UNK', 128, 'ascii');
  return data;
}

test('NSIS installed executable pin predicts the official bundle marker without mutating its source', () => {
  const source = pe(true), before = Buffer.from(source), expected = Buffer.from(source);
  expected.write('NSS', 128 + Buffer.byteLength('__TAURI_BUNDLE_TYPE_VAR_'), 'ascii');
  assert.deepEqual(desktopNsisExecutablePin(source), { bytes: expected.length, sha256: hash(expected) });
  assert.deepEqual(source, before);
  const tampered = Buffer.from(source); tampered[220] = 1;
  assert.notEqual(desktopNsisExecutablePin(tampered).sha256, desktopNsisExecutablePin(source).sha256);
});

test('NSIS installed pin rejects missing, duplicate, or already patched bundle markers', () => {
  for (const value of [Buffer.from('no marker'), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK'), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS')]) {
    assert.throws(() => desktopNsisExecutablePin(value), /DESKTOP_INSTALLER_BUNDLE_MARKER_INVALID/);
  }
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ac-installer-')), projectRoot = join(root, 'project'), source = join(root, 'payload'), destination = join(root, 'candidate');
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /ac-installer-[^\\/]+$/); await rm(root, { recursive: true, force: true }); });
  const native = join(projectRoot, 'desktop/src-tauri');
  const inputs = { 'Cargo.toml': '[package]\nname="native-fixture"\nversion="0.1.0"\n', 'Cargo.lock': 'version = 4\n',
    'tauri.conf.json': JSON.stringify(base), 'build.rs': '// Fixture', 'src/install_lease.rs': '// Fixture lease',
    'src/lib.rs': '// Fixture main', 'shell/index.html': '<div>Fixture</div>', 'icons/icon.ico': 'Fixture icon', 'windows/installer-hooks.nsh': '; Fixture hook', 'windows/payload-cleanup.mjs': '// Fixture cleanup' };
  for (const [path, text] of Object.entries(inputs)) { await mkdir(dirname(join(native, path)), { recursive: true }); await writeFile(join(native, path), text); }
  for (const path of ['windows/installer-template.nsi', 'windows/app-manifest.xml']) {
    await writeFile(join(native, path), await readFile(new URL(`../desktop/src-tauri/${path}`, import.meta.url)));
  }
  const cli = join(projectRoot, 'node_modules/@tauri-apps/cli'); await mkdir(cli, { recursive: true });
  await writeFile(join(cli, 'package.json'), JSON.stringify({ version: '2.11.4' })); await writeFile(join(cli, 'tauri.js'), '// Fixture only');
  const supplement = join(projectRoot, 'desktop/notices/cargo'); await mkdir(supplement, { recursive: true });
  await writeFile(join(supplement, 'supplements.json'), JSON.stringify({ version: 1, supplements: [] }));
  const crate = join(root, 'crate'); await mkdir(crate); await writeFile(join(crate, 'Cargo.toml'), '[package]\nname="fixture-crate"\nversion="1.0.0"');
  await writeFile(join(crate, 'LICENSE'), 'Original fixture license');
  const registry = 'registry+https://github.com/rust-lang/crates.io-index', rootId = 'path+file:///fixture#native-fixture@0.1.0', dep = `${registry}#fixture-crate@1.0.0`;
  const metadata = { version: 1, packages: [
    { id: rootId, name: 'native-fixture', version: '0.1.0', source: null, license: null, license_file: null, manifest_path: join(native, 'Cargo.toml') },
    { id: dep, name: 'fixture-crate', version: '1.0.0', source: registry, license: 'MIT', license_file: null, manifest_path: join(crate, 'Cargo.toml') },
  ], resolve: { root: rootId, nodes: [{ id: rootId, dependencies: [dep] }, { id: dep, dependencies: [] }] } };
  const members = ['resources/server/desktop-entry.js', 'resources/dist/index.html', 'binaries/node-x86_64-pc-windows-msvc.exe'];
  const bytes = Buffer.from('Public fixture only');
  for (const path of members) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), bytes); }
  await writeFile(join(source, 'payload-manifest.json'), JSON.stringify({ version: 1, protocol: 1, target,
    entry: members[0], distributionReady: false, files: members.map(path => ({ path, bytes: bytes.length, sha256: hash(bytes) })) }));
  await writeFile(join(source, 'auth.json'), 'PRIVATE FIXTURE NOT PACKAGED');
  const calls: string[] = [];
  let onBuild = async () => {};
  const runner: Command = async (file, args, options) => {
    if (args.includes('--version')) { calls.push('version'); return { code: 0, stdout: 'tauri-cli 2.11.4\n', stderr: '' }; }
    if (args[0] === 'metadata') { calls.push('metadata'); await options!.onStdout!(Buffer.from(JSON.stringify(metadata))); return { code: 0, stdout: '', stderr: '' }; }
    calls.push('build'); assert.equal(file, process.execPath); assert.equal(args[0], join(cli, 'tauri.js'));
    assert.deepEqual(args.slice(1), ['build', '--ci', '--target', target, '--bundles', 'nsis', '--config', join(destination, 'project/src-tauri/tauri.installer.conf.json'), '--', '--locked', '--offline']);
    assert.equal(options?.cwd, join(destination, 'project/src-tauri'));
    const config = JSON.parse(await readFile(join(options!.cwd!, 'tauri.installer.conf.json'), 'utf8'));
    assert.equal(config.bundle.windows.nsis.template, 'windows/installer-template.nsi');
    for (const path of ['windows/installer-template.nsi', 'windows/app-manifest.xml', 'windows/installer-hooks.nsh']) {
      assert.deepEqual(await readFile(join(options!.cwd!, path)), await readFile(join(native, path)));
    }
    assert.equal(options?.env?.CARGO_TARGET_DIR, join(destination, 'target'));
    for (const key of ['AGENT_DATA_ROOT', 'OPENAI_API_KEY', 'TAURI_CONFIG', 'NODE_OPTIONS']) assert.equal(options?.env?.[key], undefined);
    const release = join(destination, 'target', target, 'release'); await mkdir(join(release, 'bundle/nsis'), { recursive: true });
    await writeFile(join(release, 'compiled-native.exe'), pe(true));
    await link(join(release, 'compiled-native.exe'), join(release, 'agent-company-beta.exe'));
    await writeFile(join(release, 'bundle/nsis/fixture_0.1.0_x64-setup.exe'), pe(false));
    await onBuild();
    return { code: 0, stdout: 'Fixture CLI build', stderr: '' };
  };
  return { root, projectRoot, source, destination, native, cli, calls, runner,
    input: { projectRoot, source, destination }, setBuild: (value: typeof onBuild) => { onBuild = value; },
    assertSpace: async (_path: string, planned: bigint) => { calls.push('space'); assert.ok(planned > 2n * 1024n ** 3n); } };
}

test('installer config uses the official CLI schema, per-user NSIS and manifest-only resource directories', async () => {
  const require = createRequire(import.meta.url), Ajv = require('ajv'), addFormats = require('ajv-formats');
  // The published CLI schema uses identity escapes (such as \:) that require JavaScript's non-u regex mode.
  const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL('../node_modules/@tauri-apps/cli/config.schema.json', import.meta.url), 'utf8'));
  const config = desktopInstallerConfig(base, resolve('fixture payload'));
  const validate = ajv.compile(schema); assert.equal(validate(config), true, JSON.stringify(validate.errors));
  assert.deepEqual(config.app, base.app); assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.windows.allowDowngrades, false); assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.nsis.template, 'windows/installer-template.nsi');
  assert.equal(config.bundle.windows.nsis.installerHooks, 'windows/installer-hooks.nsh');
  assert.equal(Object.keys(config.bundle.resources).length, 4);
  assert.ok(Object.keys(config.bundle.resources).every(path => !path.includes('*')));
  assert.throws(() => desktopInstallerConfig({ ...base, identifier: 'different-product' }, resolve('payload')));
  assert.throws(() => desktopInstallerConfig(base, 'relative'));
});

test('installer build uses isolated sources and a fixed standard CLI; Cargo hard links become an independent native copy', async t => {
  const f = await fixture(t), before = await readFile(join(f.source, 'payload-manifest.json'));
  const result = await buildDesktopInstaller(f.input, { command: f.runner, assertSpace: f.assertSpace });
  assert.equal(f.calls[0], 'space'); assert.ok(f.calls.indexOf('metadata') < f.calls.indexOf('build'));
  assert.equal(result.distributionReady, false); assert.equal(result.signatureStatus, 'not-verified'); assert.equal(result.installed, false);
  assert.equal(result.executable.sha256, hash(pe(true)));
  assert.deepEqual(result.installedExecutable, { path: 'agent-company-beta.exe', ...desktopNsisExecutablePin(pe(true)) });
  assert.notEqual(result.installedExecutable.sha256, result.executable.sha256);
  assert.deepEqual(await readFile(join(f.source, 'payload-manifest.json')), before);
  assert.equal((await lstat(join(f.destination, result.executable.path))).nlink, 1);
  assert.equal((await readdir(join(f.destination, 'payload'))).includes('auth.json'), false);
  assert.equal(result.sources.find(file => file.path === 'Cargo.lock')!.sha256, hash(await readFile(join(f.native, 'Cargo.lock'))));
  const template = await readFile(join(f.native, 'windows/installer-template.nsi'));
  assert.equal(result.nsisTemplate.upstreamCommit, '7cd71369c00978a3783b6ae3e9972358abbe4ae6');
  assert.equal(result.nsisTemplate.sha256, hash(template));
  assert.equal(hash(Buffer.from(template.toString('utf8').replace('SetCompressor "{{compression}}"', 'SetCompressor /SOLID "{{compression}}"'))),
    '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079');
  for (const path of ['windows/installer-template.nsi', 'windows/app-manifest.xml']) {
    assert.equal(result.sources.find(file => file.path === path)!.sha256, hash(await readFile(join(f.native, path))));
  }
  assert.equal((await readFile(join(f.destination, 'installer-manifest.json'), 'utf8')).includes('PRIVATE FIXTURE'), false);
});

test('installer capacity failure precedes the CLI, Cargo and any candidate writes', async t => {
  const f = await fixture(t);
  await assert.rejects(buildDesktopInstaller(f.input, { command: f.runner, assertSpace: async () => { throw Error('space'); } }), /space/);
  assert.deepEqual(f.calls, []); await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
});

test('verified native bundling never invokes compilation and rejects stale sources before staging', async t => {
  const f=await fixture(t), nativeBuild=join(f.root,'compiled');await mkdir(nativeBuild);
  const sources=await desktopNativeSources(f.native), executable=pe(true);
  const receipt={version:1,target,cliVersion:'2.11.4',createdAt:new Date().toISOString(),toolchain:'rustc fixture',cacheKey:'fixture',durationMs:1,freeBytesBefore:'100',freeBytesAfter:'90',sourcePins:sources.map(({path,pin})=>({path,...pin})),executable:{path:'agent-company-beta.exe',bytes:executable.length,sha256:hash(executable)}};
  await writeFile(join(nativeBuild,'agent-company-beta.exe'),executable);await writeFile(join(nativeBuild,'native-build.json'),JSON.stringify(receipt));
  let bundled=0;
  const runner:Command=async(file,args,options)=>{
    if(args[1]!=='bundle')return f.runner(file,args,options);
    bundled++;assert.equal(file,process.execPath);
    assert.deepEqual(args.slice(1),['bundle','--ci','--target',target,'--bundles','nsis','--config',join(f.destination,'project/src-tauri/tauri.installer.conf.json')]);
    const release=join(f.destination,'target',target,'release');assert.deepEqual(await readFile(join(release,'agent-company-beta.exe')),executable);
    await mkdir(join(release,'bundle/nsis'),{recursive:true});await writeFile(join(release,'bundle/nsis/fixture_0.1.0_x64-setup.exe'),pe(false));
    return{code:0,stdout:'bundle fixture',stderr:''};
  };
  const built=await buildDesktopInstaller({...f.input,nativeBuild},{command:runner,assertSpace:f.assertSpace});
  assert.equal(bundled,1);assert.equal(built.buildMode,'bundle-verified-native');assert.equal(typeof built.nativeBuildManifestSha256,'string');
  assert.equal(f.calls.includes('build'),false);
  await writeFile(join(f.native,'src/lib.rs'),'changed');
  const destination=join(f.root,'stale');
  await assert.rejects(buildDesktopInstaller({...f.input,destination,nativeBuild},{command:runner,assertSpace:f.assertSpace}),/SOURCE_MISMATCH/);
  await assert.rejects(lstat(destination),{code:'ENOENT'});assert.equal(bundled,1);
});

for (const path of ['windows/installer-template.nsi', 'windows/app-manifest.xml']) {
  test(`installer rejects missing ${path} before CLI and candidate creation`, async t => {
    const f = await fixture(t); await rm(join(f.native, path));
    await assert.rejects(buildDesktopInstaller(f.input, { command: f.runner, assertSpace: f.assertSpace }), /DESKTOP_INSTALLER_SOURCE_INCOMPLETE/);
    assert.deepEqual(f.calls, ['space']); await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  });
}

for (const mutation of ['restore-solid', 'unrelated-edit']) {
  test(`installer rejects ${mutation} in its pinned template before CLI and candidate creation`, async t => {
    const f = await fixture(t), path = join(f.native, 'windows/installer-template.nsi');
    const text = await readFile(path, 'utf8');
    await writeFile(path, mutation === 'restore-solid' ? text.replace('SetCompressor "{{compression}}"', 'SetCompressor /SOLID "{{compression}}"') : `${text}\n; Changed template\n`);
    await assert.rejects(buildDesktopInstaller(f.input, { command: f.runner, assertSpace: f.assertSpace }), /DESKTOP_INSTALLER_TEMPLATE_INVALID/);
    assert.deepEqual(f.calls, ['space']); await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  });
}

test('installer retains Windows tool discovery roots but excludes credentials and linker overrides', async t => {
  const f = await fixture(t);
  const publicRoots = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData'];
  const excluded = ['OPENAI_API_KEY', 'NODE_OPTIONS', 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER'];
  const previous = Object.fromEntries([...publicRoots, ...excluded].map(key => [key, process.env[key]]));
  try {
    for (const [index, key] of publicRoots.entries()) process.env[key] = join(f.root, `windows-root-${index}`);
    for (const key of excluded) process.env[key] = 'PUBLIC-TEST-VALUE-NOT-FORWARDED';
    const runner: Command = async (file, args, options) => {
      if (args.includes('build')) {
        for (const key of publicRoots) assert.equal(options?.env?.[key], process.env[key]);
        for (const key of excluded) assert.equal(options?.env?.[key], undefined);
      }
      return f.runner(file, args, options);
    };
    await buildDesktopInstaller(f.input, { command: runner, assertSpace: f.assertSpace });
    assert.ok(f.calls.includes('build'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('installer rejects existing output, overlapping input and a substitute CLI version', async t => {
  const f = await fixture(t); await mkdir(f.destination); await writeFile(join(f.destination, 'preserve'), 'keep');
  await assert.rejects(buildDesktopInstaller(f.input), /DESKTOP_INSTALLER_INPUT_INVALID/);
  assert.equal(await readFile(join(f.destination, 'preserve'), 'utf8'), 'keep');
  await assert.rejects(buildDesktopInstaller({ ...f.input, destination: join(f.source, 'inside') }), /DESKTOP_INSTALLER_INPUT_INVALID/);
  const destination = join(f.root, 'another'); await writeFile(join(f.cli, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  await assert.rejects(buildDesktopInstaller({ ...f.input, destination }, { command: f.runner, assertSpace: f.assertSpace }), /DESKTOP_INSTALLER_CLI_VERSION/);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

for (const failure of ['original-source', 'copied-source', 'original-template', 'copied-template', 'app-manifest', 'payload', 'extra-resource', 'bad-installer', 'config', 'cargo-lock']) {
  test(`installer does not publish a receipt after ${failure} changes during the CLI build`, async t => {
    const f = await fixture(t);
    f.setBuild(async () => {
      const path = ({ 'original-source': join(f.native, 'src/lib.rs'), 'copied-source': join(f.destination, 'project/src-tauri/src/lib.rs'),
        'original-template': join(f.native, 'windows/installer-template.nsi'), 'copied-template': join(f.destination, 'project/src-tauri/windows/installer-template.nsi'),
        'app-manifest': join(f.destination, 'project/src-tauri/windows/app-manifest.xml'),
        payload: join(f.destination, 'payload/resources/server/desktop-entry.js'), 'extra-resource': join(f.destination, 'payload/resources/unlisted-auth.json'),
        'bad-installer': join(f.destination, 'target', target, 'release/bundle/nsis/fixture_0.1.0_x64-setup.exe'),
        config: join(f.destination, 'project/src-tauri/tauri.installer.conf.json'), 'cargo-lock': join(f.destination, 'project/src-tauri/Cargo.lock') })[failure]!;
      await writeFile(path, 'changed');
    });
    await assert.rejects(buildDesktopInstaller(f.input, { command: f.runner, assertSpace: f.assertSpace }));
    await assert.rejects(lstat(join(f.destination, 'installer-manifest.json')), { code: 'ENOENT' });
    assert.ok(f.calls.includes('build'));
  });
}

test('a failed CLI keeps the private candidate and log without an installer success receipt', async t => {
  const f = await fixture(t);
  const runner: Command = async (file, args, options) => args.includes('build') ? { code: 1, stdout: 'Fixture failure', stderr: 'Fixture error' } : f.runner(file, args, options);
  await assert.rejects(buildDesktopInstaller(f.input, { command: runner, assertSpace: f.assertSpace }), /DESKTOP_INSTALLER_BUILD_FAILED/);
  assert.match(await readFile(join(f.destination, 'build.log'), 'utf8'), /Fixture failure/);
  await assert.rejects(lstat(join(f.destination, 'installer-manifest.json')), { code: 'ENOENT' });
});

test('standard command runs the child in its explicit directory without changing the parent cwd', async t => {
  const f = await fixture(t), before = process.cwd();
  const result = await command(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: f.root });
  assert.equal(result.code, 0); assert.equal(resolve(result.stdout), resolve(f.root)); assert.equal(process.cwd(), before);
});
