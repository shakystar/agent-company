import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { command, type Command } from '../server/process.ts';
import { assertDesktopProviderDirectory, inspectDesktopFile, readDesktopProviderFile, verifyPinnedDesktopFile, verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';
import { assertDesktopPayloadCopySpace, readDesktopPayload } from './desktop-payload.ts';
import { stageDesktopNativeNotices } from './desktop-native-notices.ts';
import { retireDesktopCompilerPayload } from './desktop-build-retirement.ts';

const invalid = (code = 'DESKTOP_INSTALLER_INPUT_INVALID') => Object.assign(new Error(code), { code });
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const desktopInstallerCliVersion = '2.11.4';
/** CLI 2.11.4 bundle.rs patches this unique marker for NSIS, then restores
 * the Cargo executable. Predict the installed bytes without changing either file.
 * https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri-bundler/src/bundle.rs */
export function desktopNsisExecutablePin(data: Buffer) {
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = data.indexOf(marker);
  if (offset < 0 || data.indexOf(marker, offset + 1) !== -1) throw invalid('DESKTOP_INSTALLER_BUNDLE_MARKER_INVALID');
  const installed = Buffer.from(data);
  installed.write('NSS', offset + marker.length - 3, 'ascii');
  return { bytes: installed.length, sha256: hash(installed) };
}
const installerTemplate = Object.freeze({
  path: 'windows/installer-template.nsi',
  upstreamCommit: '7cd71369c00978a3783b6ae3e9972358abbe4ae6',
  upstreamPath: 'crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi',
  upstreamBytes: 32007,
  upstreamSha256: '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079',
  bytes: 32000,
  sha256: '80acd061181c7620f8c3e57f3d99e752728d509eb834229f5d774e70293d6737',
});
const target = 'x86_64-pc-windows-msvc';
const contains = (parent: string, child: string) => {
  const path = relative(resolve(parent), resolve(child));
  return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
type Source = { path: string; data: Buffer; pin: { bytes: number; sha256: string } };

export async function desktopNativeSources(root: string): Promise<Source[]> {
  const paths = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json'];
  async function visit(part: string) {
    await assertDesktopProviderDirectory(join(root, part));
    for (const entry of await readdir(join(root, part), { withFileTypes: true })) {
      const path = `${part}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else paths.push(path);
      if (paths.length > 512) throw invalid();
    }
  }
  for (const part of ['src', 'shell', 'icons', 'windows']) await visit(part);
  const result: Source[] = []; let bytes = 0;
  for (const path of paths.sort()) {
    const source = await readDesktopProviderFile(join(root, path), 2 * 1024 * 1024);
    bytes += source.data.length; if (bytes > 32 * 1024 * 1024) throw invalid();
    result.push({ path, ...source });
  }
  for (const required of ['src/install_lease.rs', 'windows/installer-hooks.nsh', 'windows/payload-cleanup.mjs', 'windows/app-manifest.xml', installerTemplate.path, 'icons/icon.ico']) {
    if (!result.some(source => source.path === required)) throw invalid('DESKTOP_INSTALLER_SOURCE_INCOMPLETE');
  }
  const template = result.find(source => source.path === installerTemplate.path)!;
  // Offline pin of the official CLI 2.11.4 template with one approved token removal.
  // Reconstructing the original also prevents silently accepting any other template edit.
  const directive = 'SetCompressor "{{compression}}"', text = template.data.toString('utf8');
  const upstream = Buffer.from(text.replace(directive, 'SetCompressor /SOLID "{{compression}}"'));
  if (template.pin.bytes !== installerTemplate.bytes || template.pin.sha256 !== installerTemplate.sha256
    || text.split(directive).length !== 2 || upstream.length !== installerTemplate.upstreamBytes
    || hash(upstream) !== installerTemplate.upstreamSha256) throw invalid('DESKTOP_INSTALLER_TEMPLATE_INVALID');
  return result;
}

/** Small directory map avoids Windows' environment-length limit for thousands of resources.
 * The directories are fresh manifest-only copies and are checked again after the bundler. */
export function desktopInstallerConfig<T extends Record<string, unknown>>(base: T, payloadRoot: string) {
  if (!isAbsolute(payloadRoot) || base.identifier !== 'com.agentcompany.desktop.beta'
    || base.productName !== 'Agent Company Beta' || typeof base.version !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(base.version)) throw invalid();
  const absolute = (path: string) => join(payloadRoot, path).replaceAll('\\', '/');
  return { ...base, mainBinaryName: 'agent-company-beta', build: { frontendDist: 'shell' },
    bundle: { active: true, targets: ['nsis'], icon: ['icons/icon.ico'], createUpdaterArtifacts: false,
      useLocalToolsDir: true,
      resources: { [`${absolute('resources')}/`]: 'resources/', [`${absolute('binaries')}/`]: 'binaries/',
        [absolute('payload-manifest.json')]: 'payload-manifest.json', [absolute('native-dependencies.lock')]: 'native-dependencies.lock' },
      windows: { allowDowngrades: false, webviewInstallMode: { type: 'downloadBootstrapper', silent: true },
        nsis: { installMode: 'currentUser', languages: ['Korean', 'English'], displayLanguageSelector: false,
          installerHooks: 'windows/installer-hooks.nsh', template: installerTemplate.path } } } };
}

/** All executable inputs come from the new candidate, never the old installation. */
export function desktopCleanupHook(payloadRoot: string, helperPath: string) {
  const quote = (path: string) => {
    if (!isAbsolute(path) || /[\r\n"$]/.test(path)) throw invalid();
    return path.replaceAll('/', '\\');
  };
  const node = quote(join(payloadRoot, 'binaries/node-x86_64-pc-windows-msvc.exe'));
  const manifest = quote(join(payloadRoot, 'payload-manifest.json'));
  const helper = quote(helperPath);
  return `; Generated from pinned candidate inputs; runs under the existing lease.
!macro AC_PAYLOAD_CLEANUP_EXEC Phase
  nsExec::ExecToLog '\"$PLUGINSDIR\\ac-cleanup-node.exe\" --no-addons --no-global-search-paths \"$PLUGINSDIR\\ac-cleanup.mjs\" \"\${Phase}\" \"$INSTDIR\" \"$PLUGINSDIR\\ac-candidate.json\" \"$INSTDIR\\payload-retirement.json\"'
  Pop $0
  StrCmp $0 0 +4
    DetailPrint "설치 파일 검증 또는 이전 파일 정리에 실패했습니다. 설치 프로그램을 다시 실행하십시오."
    SetErrorLevel 2
    Quit
!macroend
!macro AC_PAYLOAD_CLEANUP_PREPARE
  InitPluginsDir
  File /oname=$PLUGINSDIR\\ac-cleanup-node.exe "${node}"
  File /oname=$PLUGINSDIR\\ac-cleanup.mjs "${helper}"
  File /oname=$PLUGINSDIR\\ac-candidate.json "${manifest}"
  ; The helper is a fixed module, without user Node preload configuration.
  System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_OPTIONS", w "")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_PATH", w "")'
  !insertmacro AC_PAYLOAD_CLEANUP_EXEC prepare
!macroend
!macro AC_PAYLOAD_CLEANUP_COMMIT
  !insertmacro AC_PAYLOAD_CLEANUP_EXEC commit
!macroend
`;
}

async function verifyStagedTree(root: string) {
  const payload = await readDesktopPayload(root);
  const expected = new Set(payload.manifest.files.map(file => file.path));
  async function visit(part: string) {
    await assertDesktopProviderDirectory(join(root, part));
    for (const entry of await readdir(join(root, part), { withFileTypes: true })) {
      const path = `${part}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (!expected.delete(path)) throw invalid('DESKTOP_INSTALLER_EXTRA_RESOURCE');
    }
  }
  for (const part of ['resources', 'binaries']) await visit(part);
  if (expected.size) throw invalid('DESKTOP_INSTALLER_MISSING_RESOURCE');
  for (const file of payload.manifest.files) await verifyPinnedDesktopPayloadFile(join(root, file.path), file);
  return payload;
}

/** Builds an internal candidate through the official CLI. Does not install, publish or claim signing. */
export async function buildDesktopInstaller(input: { projectRoot: string; source: string; destination: string; nativeBuild?: string }, supplied: {
  command?: Command; assertSpace?: typeof assertDesktopPayloadCopySpace; stage?: typeof stageDesktopNativeNotices;
} = {}) {
  const { projectRoot, source, destination } = input;
  if (![projectRoot, source, destination].every(isAbsolute) || contains(source, destination) || contains(destination, source)
    || contains(destination, projectRoot)) throw invalid();
  await assertDesktopProviderDirectory(projectRoot); await assertDesktopProviderDirectory(dirname(destination));
  try { await lstat(destination); throw invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const payload = await readDesktopPayload(source);
  const assertSpace = supplied.assertSpace ?? assertDesktopPayloadCopySpace;
  // Bundling a verified native build needs one bundler resource copy, plus the
  // existing 2 GiB allowance for packaging tools, temporary files and setup.
  // A full build additionally reserves a payload-sized compiler allowance.
  const allowance = 2n * 1024n ** 3n + payload.copyBytes * (input.nativeBuild ? 1n : 2n);
  await assertSpace(dirname(destination), payload.copyBytes + allowance);
  const nativeRoot = join(projectRoot, 'desktop/src-tauri'), original = await desktopNativeSources(nativeRoot);
  const nativeCompiled = input.nativeBuild
    ? await (await import('./desktop-native-build.ts')).verifyDesktopNativeBuild(input.nativeBuild, original)
    : undefined;
  const assertSources = async () => {
    const current = await desktopNativeSources(nativeRoot);
    if (JSON.stringify(current.map(({ path, pin }) => ({ path, pin }))) !== JSON.stringify(original.map(({ path, pin }) => ({ path, pin })))) throw invalid('DESKTOP_INSTALLER_SOURCE_CHANGED');
  };
  const cliRoot = join(projectRoot, 'node_modules/@tauri-apps/cli');
  const cliPackage = await readDesktopProviderFile(join(cliRoot, 'package.json'), 2 * 1024 * 1024);
  if (JSON.parse(cliPackage.data.toString('utf8')).version !== desktopInstallerCliVersion) throw invalid('DESKTOP_INSTALLER_CLI_VERSION');
  const cli = join(cliRoot, 'tauri.js'), cliSnapshot = await readDesktopProviderFile(cli, 2 * 1024 * 1024);
  const run = supplied.command ?? command;
  const version = await run(process.execPath, [cli, '--version'], { timeoutMs: 30_000 });
  if (version.code !== 0 || version.stdout.trim() !== `tauri-cli ${desktopInstallerCliVersion}`) throw invalid('DESKTOP_INSTALLER_CLI_VERSION');
  await assertSources(); await assertSpace(dirname(destination), payload.copyBytes + allowance);
  await mkdir(destination);
  const payloadRoot = join(destination, 'payload'), project = join(destination, 'project'), cargo = join(project, 'src-tauri');
  const staged = await (supplied.stage ?? stageDesktopNativeNotices)({ projectRoot, payload, destination: payloadRoot, additionalBytes: allowance }, { assertSpace, command: run });
  await assertSources();
  for (const file of original) {
    const output = join(cargo, file.path);
    await mkdir(dirname(output), { recursive: true });
    await assertDesktopProviderDirectory(dirname(output));
    await writeFile(output, file.data, { flag: 'wx' });
    await verifyPinnedDesktopPayloadFile(output, file.pin);
  }
  const cleanupPath = join(cargo, 'windows/payload-cleanup-generated.nsh');
  const cleanupBytes = Buffer.from(desktopCleanupHook(payloadRoot, join(cargo, 'windows/payload-cleanup.mjs')));
  const cleanupPin = { bytes: cleanupBytes.length, sha256: hash(cleanupBytes) };
  await writeFile(cleanupPath, cleanupBytes, { flag: 'wx' });
  const base = JSON.parse(original.find(file => file.path === 'tauri.conf.json')!.data.toString('utf8'));
  const config = desktopInstallerConfig(base, payloadRoot), configPath = join(cargo, 'tauri.installer.conf.json');
  const configBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  await writeFile(configPath, configBytes, { flag: 'wx' });
  const configPin = { bytes: configBytes.length, sha256: hash(configBytes) };
  // A minimal build project has no user/workspace data and does not depend on the root frontend build.
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'agent-company-installer-build', version: base.version, private: true }), { flag: 'wx' });
  const verified = await verifyStagedTree(payloadRoot);
  if (hash(verified.manifestBytes) !== staged.payloadManifestSha256) throw invalid('DESKTOP_INSTALLER_PAYLOAD_CHANGED');
  const lockPin = original.find(file => file.path === 'Cargo.lock')!.pin;
  await verifyPinnedDesktopPayloadFile(join(payloadRoot, 'native-dependencies.lock'), lockPin);
  await verifyPinnedDesktopPayloadFile(cli, cliSnapshot.pin);
  const env: NodeJS.ProcessEnv = {};
  // Preserve standard Windows/MSVC discovery roots without forwarding model credentials.
  // Omitting these can make rustc fall back to an unrelated link.exe on PATH.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
    'CARGO_HOME', 'RUSTUP_HOME', 'INCLUDE', 'LIB', 'LIBPATH', 'VSINSTALLDIR', 'VCINSTALLDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CARGO_TARGET_DIR = join(destination, 'target');
  await assertSpace(destination, allowance);
  const nativeBuildManifestSha256 = nativeCompiled?.manifestSha256;
  if (nativeCompiled) {
    const output = join(destination, 'target', target, 'release', 'agent-company-beta.exe');
    await mkdir(dirname(output), { recursive: true });
    await copyFile(nativeCompiled.executable, output, constants.COPYFILE_EXCL);
    await verifyPinnedDesktopPayloadFile(output, nativeCompiled.pin);
  }
  const args = input.nativeBuild
    ? [cli, 'bundle', '--ci', '--target', target, '--bundles', 'nsis', '--config', configPath]
    : [cli, 'build', '--ci', '--target', target, '--bundles', 'nsis', '--config', configPath, '--', '--locked', '--offline'];
  const result = await run(process.execPath, args,
    { cwd: cargo, env, timeoutMs: 60 * 60_000 });
  await writeFile(join(destination, 'build.log'), `${result.stdout}\n${result.stderr}`, { flag: 'wx' });
  if (result.code !== 0) throw invalid('DESKTOP_INSTALLER_BUILD_FAILED');
  await assertSources(); await verifyPinnedDesktopPayloadFile(configPath, configPin);
  await verifyPinnedDesktopPayloadFile(cleanupPath, cleanupPin);
  for (const file of original) await verifyPinnedDesktopPayloadFile(join(cargo, file.path), file.pin);
  await verifyPinnedDesktopPayloadFile(join(payloadRoot, 'native-dependencies.lock'), lockPin);
  if (hash((await verifyStagedTree(payloadRoot)).manifestBytes) !== staged.payloadManifestSha256) throw invalid('DESKTOP_INSTALLER_PAYLOAD_CHANGED');
  const release = join(destination, 'target', target, 'release'), cargoExecutable = join(release, 'agent-company-beta.exe');
  await assertDesktopProviderDirectory(release);
  const before = await lstat(cargoExecutable, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 512n * 1024n * 1024n) throw invalid('DESKTOP_INSTALLER_OUTPUT_INVALID');
  // Cargo hard-links the main output to its deps artifact. Preserve it and validate an independent copy.
  const nativePath = join(destination, 'agent-company-beta.exe');
  await copyFile(cargoExecutable, nativePath, constants.COPYFILE_EXCL);
  const after = await lstat(cargoExecutable, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) if (before[key] !== after[key]) throw invalid('DESKTOP_INSTALLER_OUTPUT_CHANGED');
  const native = await inspectDesktopFile(nativePath, 512 * 1024 * 1024);
  await verifyPinnedDesktopFile(nativePath, native, { windowsX64Executable: true });
  const nativeBytes = await readFile(nativePath);
  if (nativeBytes.length !== native.bytes || hash(nativeBytes) !== native.sha256) throw invalid('DESKTOP_INSTALLER_OUTPUT_CHANGED');
  const installedNative = desktopNsisExecutablePin(nativeBytes);
  if (input.nativeBuild) {
    const { verifyDesktopNativeBuild } = await import('./desktop-native-build.ts');
    const compiled = await verifyDesktopNativeBuild(input.nativeBuild, original);
    if (compiled.manifestSha256 !== nativeBuildManifestSha256 || compiled.pin.sha256 !== native.sha256) throw invalid('DESKTOP_INSTALLER_NATIVE_CHANGED');
  }
  await verifyPinnedDesktopPayloadFile(nativePath, native);
  const installers = join(release, 'bundle/nsis'); await assertDesktopProviderDirectory(installers);
  const files = await readdir(installers);
  if (files.length !== 1 || !files[0].endsWith('-setup.exe')) throw invalid('DESKTOP_INSTALLER_OUTPUT_INVALID');
  const installerPath = join(installers, files[0]), installer = await inspectDesktopFile(installerPath);
  if (!installer.bytes) throw invalid('DESKTOP_INSTALLER_OUTPUT_INVALID');
  const handle = await open(installerPath, 'r');
  try {
    const header = Buffer.alloc(4096), read = await handle.read(header, 0, header.length, 0);
    if (read.bytesRead < 64 || header.readUInt16LE(0) !== 0x5a4d) throw invalid('DESKTOP_INSTALLER_OUTPUT_INVALID');
    const pe = header.readUInt32LE(0x3c);
    if (pe > read.bytesRead - 26 || header.readUInt32LE(pe) !== 0x4550 || header.readUInt16LE(pe + 4) !== 0x014c
      || header.readUInt16LE(pe + 24) !== 0x10b) throw invalid('DESKTOP_INSTALLER_OUTPUT_INVALID');
  } finally { await handle.close(); }
  await verifyPinnedDesktopPayloadFile(installerPath, installer);
  const manifest = { version: 1, createdAt: new Date().toISOString(), target, cliVersion: desktopInstallerCliVersion,
    applicationVersion: base.version, nativeBuildManifestSha256, buildMode: input.nativeBuild ? 'bundle-verified-native' : 'legacy-full-build', executable: { path: relative(destination, nativePath).replaceAll('\\', '/'), ...native },
    installedExecutable: { path: 'agent-company-beta.exe', ...installedNative },
    installer: { path: relative(destination, installerPath).replaceAll('\\', '/'), ...installer },
    sourcePayloadManifestSha256: staged.sourcePayloadManifestSha256, payloadManifestSha256: staged.payloadManifestSha256,
    sources: original.map(({ path, pin }) => ({ path, ...pin })), configSha256: configPin.sha256,
    cleanupHook: { path: 'project/src-tauri/windows/payload-cleanup-generated.nsh', ...cleanupPin },
    nsisTemplate: { ...installerTemplate, change: 'Remove only /SOLID and its following space' },
    distributionReady: false, signatureStatus: 'not-verified', installed: false,
    remaining: ['Actual clean installation and data preservation', 'Actual runtime/model and external client validation',
      'Complete third-party notices', 'Publisher signing and update channel verification'] };
  await writeFile(join(destination, 'installer-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const retirement = await retireDesktopCompilerPayload(destination);
  await writeFile(join(destination, 'compiler-payload-retirement.json'), JSON.stringify({ at: new Date().toISOString(), ...retirement }, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
