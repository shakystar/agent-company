import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { workerSourceFiles } from '../shared/runtime-releases.ts';
import { inspectDesktopCodexPackage, stageDesktopCodexPackage } from './desktop-codex-package.ts';
import { assertDesktopProviderDirectory, inspectDesktopFile, verifyPinnedDesktopFile } from './desktop-provider-files.ts';
import { desktopBuildArguments } from './desktop-build-options.ts';
import { inspectDesktopWorkerPackage, stageDesktopWorkerPackage } from './desktop-worker-package.ts';
import { collectDesktopNpmNotices, inspectDesktopNodeNotices, writeDesktopNotices } from './desktop-notices.ts';
import { applyDesktopNoticeSupplements } from './desktop-notice-supplements.ts';

// A candidate payload only. Signing, native wrapper and clean-machine installation are separate gates.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('이 빌드는 Windows x64 Node 24 환경에서 생성합니다.');
}
const { codexExecutable, workerPackage } = desktopBuildArguments(process.argv.slice(2));
const codexInput = codexExecutable ? await inspectDesktopCodexPackage(codexExecutable) : null;
const workerInput = workerPackage ? await inspectDesktopWorkerPackage(workerPackage) : null;
const nodeInput = await inspectDesktopNodeNotices(process.execPath, root);
const npmNotices = await collectDesktopNpmNotices(root);
const supplements = await applyDesktopNoticeSupplements(npmNotices.components, join(root, 'desktop/notices/npm/supplements.json'));
const noticeBytes = [nodeInput.component, ...supplements.components].reduce((sum, component) => sum
  + component.files.reduce((bytes, file) => bytes + file.data.length, 0), 2 * 1024 * 1024);
await assertDesktopProviderDirectory(join(root, 'desktop'));
const builds = join(root, 'desktop', 'builds');
await mkdir(builds, { recursive: true });
await assertDesktopProviderDirectory(builds);
// Keep the operating workspace's 20 GiB floor. The 256 MiB allowance covers the
// current 129 MB server payload plus compiler output; it is not an OS reservation.
const disk = await statfs(builds, { bigint: true });
if (disk.bavail * disk.bsize < 20n * 1024n ** 3n + 256n * 1024n ** 2n + BigInt(codexInput?.bytes ?? 0) + BigInt(workerInput?.bytes ?? 0) + BigInt(noticeBytes)) {
  throw new Error('설치 묶음을 생성할 디스크 여유가 부족합니다. 최소 20GiB와 새 묶음 공간을 확보해야 합니다.');
}
const output = join(builds, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
const resources = join(output, 'resources');
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Never overwrite or clean a previous candidate or production dist.
await mkdir(resources);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const command = (args: string[]) => new Promise<void>((resolveCommand, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolveCommand() : reject(new Error(`설치형 컴파일 실패: ${code}`)));
});
await command([join(root, 'node_modules/typescript/bin/tsc'), '--project', join(root, 'tsconfig.desktop.json'), '--outDir', resources]);
await build({ root, build: { outDir: join(resources, 'dist'), sourcemap: false, emptyOutDir: false } });
await writeFile(join(resources, 'package.json'), JSON.stringify({ name: 'agent-company-desktop-server', private: true, version: '0.1.0', type: 'module' }));

type Package = { version: string; dev?: boolean; optional?: boolean; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes.toString('utf8')) as { lockfileVersion: number; packages: Record<string, Package> };
if (lock.lockfileVersion !== 3) throw new Error('설치형 의존성 잠금 형식을 확인해야 합니다.');
const included = new Map<string, Package>();
const locate = (from: string, name: string): string | undefined => {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error('의존성 이름이 올바르지 않습니다.');
  let cursor = resolve(root, from);
  while (cursor === root || cursor.startsWith(root + sep)) {
    const path = relative(root, join(cursor, 'node_modules', name)).replaceAll('\\', '/');
    if (lock.packages[path]) return path;
    if (cursor === root) break;
    cursor = dirname(cursor);
  }
};
const visit = (path: string) => {
  if (included.has(path)) return;
  const spec = lock.packages[path];
  if (!spec || spec.dev || !path.startsWith('node_modules/') || path.split('/').includes('..')) throw new Error('운영 의존성 범위를 확인해야 합니다.');
  included.set(path, spec);
  for (const name of new Set([...Object.keys(spec.dependencies ?? {}), ...Object.keys(spec.optionalDependencies ?? {})])) {
    const dependency = locate(path, name);
    if (dependency) visit(dependency);
    else if (!Object.hasOwn(spec.optionalDependencies ?? {}, name)) throw new Error(`필수 의존성이 없습니다: ${name}`);
  }
};
for (const name of ['@electric-sql/pglite', '@fastify/static', 'fastify', 'proper-lockfile', 'zod']) {
  const path = locate('', name); if (!path) throw new Error(`필수 의존성이 없습니다: ${name}`); visit(path);
}
async function copyTree(source: string, destination: string) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('배포 자원에 우회 연결이나 특수 파일이 있습니다.');
  if (info.isFile()) { await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination); return; }
  await mkdir(destination, { recursive: true });
  for (const item of await readdir(source)) {
    // Nested dependency packages are copied only through their own locked entry.
    if (item === 'node_modules' || item === '.git' || item.startsWith('.env') || item.endsWith('.map')) continue;
    await copyTree(join(source, item), join(destination, item));
  }
}
const packages = [];
for (const [path, spec] of included) {
  const source = join(root, path);
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (metadata.version !== spec.version) throw new Error(`설치된 의존성 버전이 잠금 파일과 다릅니다: ${path}`);
  await copyTree(source, join(resources, path));
  packages.push({ path, name: metadata.name, version: spec.version, integrity: spec.integrity, license: metadata.license });
}
for (const path of [...workerSourceFiles, 'security/codex-userns.json', 'security/browser-userns.json', 'security/LICENSE.moby']) {
  await copyTree(join(root, 'worker', path), join(resources, 'worker', path));
}
await mkdir(join(output, 'binaries'));
await nodeInput.assertUnchanged();
await verifyPinnedDesktopFile(process.execPath, nodeInput.binary, { windowsX64Executable: true,
  destination: join(output, 'binaries', 'node-x86_64-pc-windows-msvc.exe') });
const codexProvider = codexExecutable ? await stageDesktopCodexPackage(codexExecutable, resources) : null;
const workerProvider = workerPackage ? await stageDesktopWorkerPackage(workerPackage, resources, workerInput!) : null;
await npmNotices.assertUnchanged();
await supplements.assertUnchanged();
await mkdir(join(resources, 'notices'));
const notices = await writeDesktopNotices(join(resources, 'notices', 'server'), [nodeInput.component, ...supplements.components], npmNotices.issues);
// Each listed byte is part of this candidate; no .env, DB, credentials, backups, proof data or source maps are inputs.
const files: Array<{ path: string; bytes: number; sha256: string }> = [];
async function inventory(directory: string) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await inventory(path);
    else if (item.isFile()) {
      files.push({ path: relative(output, path).replaceAll('\\', '/'), ...await inspectDesktopFile(path, 8 * 1024 ** 3) });
    } else throw new Error('배포 후보에 특수 파일이 있습니다.');
  }
}
await inventory(output);
for (const name of ['pglite.wasm', 'initdb.wasm', 'pglite.data']) {
  if (!files.some(file => file.path === `resources/node_modules/@electric-sql/pglite/dist/${name}`)) throw new Error('PGlite 실행 자원이 없습니다.');
}
if (files.some(file => file.path.split('/').some(part => ['.data', '.verification', '.git', 'credentials', 'backups'].includes(part)
  || part.startsWith('.env') || part.endsWith('.map')))) throw new Error('배포 제외 파일이 후보에 포함됐습니다.');
await writeFile(join(output, 'payload-manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
  target: 'x86_64-pc-windows-msvc', protocol: 1, entry: 'resources/server/desktop-entry.js', node: process.version,
  packageLockSha256: digest(lockBytes), distributionReady: false,
  remaining: ['Native integration verification', 'Actual runtime image installation and model verification', 'Complete third-party notices', 'Signing and installer verification'],
  providers: codexProvider ? [codexProvider] : [], worker: workerProvider, packages, notices,
  nodeSource: nodeInput.source, noticeSupplements: { manifestSha256: supplements.manifestSha256, applied: supplements.applied }, files }, null, 2));
console.log(JSON.stringify({ type: 'desktop-payload-built', output, files: files.length,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0), distributionReady: false }));
