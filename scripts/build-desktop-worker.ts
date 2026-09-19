import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopDockerTarget, type DesktopDockerTarget } from '../server/desktop-docker-target.ts';
import { inspectRuntimeBase, inspectWorkerSources } from '../server/releases.ts';
import type { RuntimeConfig } from '../server/runtime.ts';
import type { Command } from '../server/process.ts';
import { assertCompatibleWorkerReleases, canonicalRuntimeJson, createWorkerReleaseManifest, validateWorkerReleaseCatalog,
  workerImageSchema, workerSourceFiles } from '../shared/runtime-releases.ts';
import { assertDesktopProviderDirectory, readDesktopProviderFile, verifyPinnedDesktopArchive,
  verifyPinnedDesktopPayloadFile } from './desktop-provider-files.ts';
import { inspectDesktopWorkerPackage, type DesktopWorkerPackageImage } from './desktop-worker-package.ts';
import { verifyDesktopImageArchive } from '../server/desktop-image-archive.ts';

const floor = 20n * 1024n ** 3n, maximumArchive = 8 * 1024 ** 3;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export interface DesktopWorkerBuildOptions { wslExecutable: string; distro: string; browserImage?: string; previousWorkerPackage?: string }
export function desktopWorkerBuildArguments(args: string[]): DesktopWorkerBuildOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--wsl-executable', '--distro', '--browser-image', '--previous-worker-package'].includes(key) || values[key] || !value || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('명시 WSL 실행파일·배포판과 선택적인 불변 browser image·이전 worker package만 허용합니다.');
    }
    values[key] = value;
  }
  if (!values['--wsl-executable'] || !isAbsolute(values['--wsl-executable'])
    || !/[\\/]wsl\.exe$/i.test(values['--wsl-executable']) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(values['--distro'] ?? '')) {
    throw new Error('명시 WSL 실행파일의 절대 경로와 배포판이 필요합니다.');
  }
  if (values['--previous-worker-package'] && (!isAbsolute(values['--previous-worker-package'])
    || values['--previous-worker-package'].split(/[\\/]/).some(part => part === '.' || part === '..'))) {
    throw new Error('이전 worker package는 명시적인 절대 resource 경로여야 합니다.');
  }
  return { wslExecutable: values['--wsl-executable'], distro: values['--distro'],
    ...(values['--previous-worker-package'] ? { previousWorkerPackage: values['--previous-worker-package'] } : {}),
    ...(values['--browser-image'] ? { browserImage: workerImageSchema.parse(values['--browser-image']) } : {}) };
}
interface Dependencies {
  createTarget: typeof createDesktopDockerTarget;
  runtimeBase: typeof inspectRuntimeBase;
  verifyArchive: (path: string, pin: { image: string; bytes: number; sha256: string }) => Promise<void>;
  freeBytes: (path: string) => Promise<bigint>;
}
const defaults: Dependencies = { createTarget: createDesktopDockerTarget, runtimeBase: inspectRuntimeBase,
  verifyArchive: async (path, pin) => { const archive = await verifyDesktopImageArchive(path, pin); await archive.close(); },
  freeBytes: async path => { const disk = await statfs(path, { bigint: true }); return disk.bavail * disk.bsize; } };

/** Only explicit public package inputs are read. Authentication and mutable operating catalogs are never inputs. */
async function previousPackageSnapshot(path: string) {
  await assertDesktopProviderDirectory(path);
  const document = await readDesktopProviderFile(join(path, 'runtimes/codex/worker.json'), 2 * 1024 * 1024);
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.data));
  const files = ['runtimes/codex/images.json', ...workerSourceFiles.map(file => `worker/${file}`),
    'worker/security/codex-userns.json', ...(raw.browserImage ? ['worker/security/browser-userns.json'] : [])];
  const pins: Array<{ file: string; pin: { bytes: number; sha256: string } }> = [{ file: 'runtimes/codex/worker.json', pin: document.pin }];
  for (const file of files) pins.push({ file, pin: (await readDesktopProviderFile(join(path, file), 2 * 1024 * 1024)).pin });
  const receipt = await inspectDesktopWorkerPackage(path);
  const assertUnchanged = async () => {
    for (const { file, pin } of pins) await verifyPinnedDesktopPayloadFile(join(path, file), pin);
  };
  await assertUnchanged();
  return { path, pins, receipt, async verify() {
    await assertUnchanged();
    const current = await inspectDesktopWorkerPackage(path);
    if (canonicalRuntimeJson(current) !== canonicalRuntimeJson(receipt)) throw new Error('이전 worker package가 빌드 중 변경됐습니다.');
    await assertUnchanged();
  } };
}

/** Creates a separate unsigned candidate. Only an explicit verified package may supply prior manifests;
 * no .env, operating catalog, tag, authentication or model execution is adopted. */
export async function buildDesktopWorker(options: DesktopWorkerBuildOptions,
  paths = { source: join(root, 'worker'), builds: join(root, 'desktop', 'worker-builds') },
  supplied: Partial<Dependencies> = {}) {
  // Apply the CLI contract to programmatic calls as well.
  desktopWorkerBuildArguments(['--wsl-executable', options.wslExecutable, '--distro', options.distro,
    ...(options.browserImage ? ['--browser-image', options.browserImage] : []),
    ...(options.previousWorkerPackage ? ['--previous-worker-package', options.previousWorkerPackage] : [])]);
  const dependencies = { ...defaults, ...supplied };
  await assertDesktopProviderDirectory(paths.source);
  await assertDesktopProviderDirectory(dirname(paths.builds));
  const capacity = async (bytes: bigint) => {
    if (await dependencies.freeBytes(dirname(paths.builds)) - bytes < floor) {
      throw new Error('worker 후보의 디스크 여유가 부족합니다. 최소 20GiB와 빌드·이미지 보관 공간이 필요합니다.');
    }
  };
  // Initial build allowance; later archive copies use inspected image sizes and per-chunk checks.
  // This is a preflight, not a disk quota on Docker's separate storage filesystem.
  await capacity(2n * 1024n ** 3n);
  const previous = options.previousWorkerPackage ? await previousPackageSnapshot(options.previousWorkerPackage) : undefined;
  await mkdir(paths.builds, { recursive: true }); await assertDesktopProviderDirectory(paths.builds);
  const owner = randomUUID(), output = join(paths.builds, `${new Date().toISOString().replace(/[:.]/g, '-')}-${owner}`);
  await mkdir(output);
  const worker = join(output, 'worker'); await mkdir(worker); await mkdir(join(worker, 'security'));
  const sources: Record<string, string> = {};
  const inputs: Array<{ path: string; pin: { bytes: number; sha256: string } }> = [];
  for (const file of [...workerSourceFiles, 'Dockerfile', 'security/codex-userns.json', 'security/browser-userns.json', 'security/LICENSE.moby']) {
    const input = await readDesktopProviderFile(join(paths.source, file), 1024 * 1024);
    await verifyPinnedDesktopPayloadFile(join(paths.source, file), input.pin, { destination: join(worker, file) });
    inputs.push({ path: join(worker, file), pin: input.pin });
    if ((workerSourceFiles as readonly string[]).includes(file)) sources[file] = input.pin.sha256;
  }
  await writeFile(join(worker, '.dockerignore'), `*\n!Dockerfile\n${workerSourceFiles.map(file => `!${file}`).join('\n')}\n`, { flag: 'wx' });
  const target = await dependencies.createTarget({ ...options, dockerConfigDir: join(output, 'docker-config'), buildxConfigDir: join(output, 'buildx-state') });
  const invoke = async (args: string[], timeoutMs = 60_000) => {
    const result = await target.command('docker', args, { timeoutMs });
    if (result.code !== 0) throw new Error('설치형 worker 이미지 명령이 실패했습니다.');
    return result.stdout.trim();
  };
  if (await invoke(['version', '--format', '{{.Server.Version}}/{{.Server.Arch}}']) !== '29.1.3/amd64') {
    throw new Error('설치형 worker는 검증된 Docker 29.1.3/amd64가 필요합니다.');
  }
  const iid = join(output, 'image-id'); await writeFile(iid, '', { flag: 'wx' });
  const dockerfile = await target.mapFile(join(worker, 'Dockerfile'));
  await capacity(2n * 1024n ** 3n);
  // No -t: this build cannot repoint an operating image tag.
  await invoke(['build', '--platform=linux/amd64', '--build-arg', 'CODEX_VERSION=0.154.0',
    '--label', 'agent-company.desktop-provider=codex-0.154.0', '--iidfile', await target.mapFile(iid),
    '--file', dockerfile, posix.dirname(dockerfile)], 600_000);
  const buildImage = workerImageSchema.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readDesktopProviderFile(iid, 256)).data).trim());
  // Docker 29's containerd store can return a multi-platform index as the build
  // ID. A platform-filtered export preserves the selected manifest, not that index.
  const platformImage = async (input: string) => {
    const selected = JSON.parse(await invoke(['image', 'inspect', input, '--platform=linux/amd64', '--format', '{{json .}}']));
    if (selected.Os !== 'linux' || selected.Architecture !== 'amd64') throw new Error('내보낼 이미지의 플랫폼을 확인하지 못했습니다.');
    return workerImageSchema.parse(selected.Id);
  };
  const image = await platformImage(buildImage);
  const browserImage = options.browserImage ? await platformImage(options.browserImage) : undefined;
  const built = JSON.parse(await invoke(['image', 'inspect', buildImage, '--platform=linux/amd64', '--format', '{{json .}}']));
  if (built.Id !== image || built.Os !== 'linux' || built.Architecture !== 'amd64'
    || built.Config?.Labels?.['agent-company.desktop-provider'] !== 'codex-0.154.0') throw new Error('새 worker 빌드의 이미지 식별자와 공급자 표식이 다릅니다.');
  // The selected child may not have its own image-store record yet. Inspect/run/save
  // the immutable original with an explicit platform; pin the verified exported child.
  const platformCommand: Command = (file, args, commandOptions) => {
    if (args[0] === 'image' && args[1] === 'inspect' && args[2] === image) {
      return target.command(file, [...args.slice(0, 2), buildImage, '--platform=linux/amd64', ...args.slice(3)], commandOptions);
    }
    if (args[0] === 'run' || args[0] === 'create') {
      const imageIndex = args.indexOf(image);
      if (imageIndex < 1) throw new Error('worker 검사 이미지가 선택한 플랫폼 ID와 다릅니다.');
      return target.command(file, [args[0], '--platform=linux/amd64', ...args.slice(1, imageIndex), buildImage, ...args.slice(imageIndex + 1)], commandOptions);
    }
    return target.command(file, args, commandOptions);
  };
  const config: RuntimeConfig = { mode: 'docker', image, auth: 'none', authFile: '', model: '', timeoutMs: 60_000 };
  await verifyCodexVersion({ ...target, command: platformCommand }, image, owner);
  const sourceHashes = await inspectWorkerSources(config, image, owner, platformCommand, sources);
  // The fingerprint parser's Python -c belongs to the container command, not
  // Docker's global context flags. Make that boundary explicit for this target.
  const fingerprintCommand: Command = (file, args, commandOptions) => {
    const index = args.indexOf(image);
    return platformCommand(file, args[0] === 'run' && args.includes('--entrypoint=python3') && index >= 0
      ? [...args.slice(0, index), '--', ...args.slice(index)] : args, commandOptions);
  };
  const manifest = createWorkerReleaseManifest({ image, sourceHashes,
    runtimeBaseHash: await dependencies.runtimeBase(config, image, owner, fingerprintCommand) });
  const manifests = [manifest];
  for (const prior of previous?.receipt.provider.releaseCatalog.manifests ?? []) {
    assertCompatibleWorkerReleases(manifest, prior);
    if (prior.image === image || prior.id === manifest.id) {
      if (canonicalRuntimeJson(prior) !== canonicalRuntimeJson(manifest)) throw new Error('이전 worker manifest와 새 이미지 증거가 충돌합니다.');
    } else manifests.push(prior);
  }
  const releaseCatalog = validateWorkerReleaseCatalog({ version: 1, active: { image, manifestId: manifest.id }, manifests });
  for (const prior of previous?.pins.filter(input => input.file.startsWith('worker/security/')) ?? []) {
    await verifyPinnedDesktopPayloadFile(join(output, prior.file), prior.pin);
  }
  const runtime = join(output, 'runtimes', 'codex'); await mkdir(runtime, { recursive: true });
  const images: DesktopWorkerPackageImage[] = [];
  for (const kind of ['worker', ...(options.browserImage ? ['browser'] : [])] as const) {
    const id = kind === 'worker' ? image : browserImage!;
    const sourceId = kind === 'worker' ? buildImage : options.browserImage!;
    if (kind === 'browser' && id === image) throw new Error('browser와 worker의 이미지가 같습니다.');
    const info = JSON.parse(await invoke(['image', 'inspect', sourceId, '--platform=linux/amd64', '--format', '{{json .}}'])) as Record<string, unknown>;
    if (info.Id !== id || info.Os !== 'linux' || info.Architecture !== 'amd64'
      || !Number.isSafeInteger(info.Size) || (info.Size as number) < 1 || (info.Size as number) > maximumArchive) {
      throw new Error('동봉 이미지의 불변 ID·대상·크기를 확인하지 못했습니다.');
    }
    await capacity(BigInt(info.Size as number) * 2n + 64n * 1024n ** 2n);
    const file = kind === 'worker' ? 'worker.tar' : 'browser.tar', path = join(runtime, file);
    const handle = await open(path, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0;
    try {
      const saved = await target.command('docker', ['image', 'save', '--platform=linux/amd64', sourceId], {
        timeoutMs: 600_000, captureStdout: false, async onStdout(chunk) {
          if (bytes + chunk.length > maximumArchive) throw new Error('동봉 이미지 보관 파일이 8GiB를 초과합니다.');
          await capacity(BigInt(chunk.length));
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, bytes + written);
            if (!result.bytesWritten) throw new Error('동봉 이미지 쓰기를 완료하지 못했습니다.');
            written += result.bytesWritten;
          }
          hash.update(chunk); bytes += chunk.length;
        },
      });
      if (saved.code !== 0 || !bytes) throw new Error('동봉 이미지 내보내기를 완료하지 못했습니다.');
      await handle.sync();
    } finally { await handle.close(); }
    const pin = { bytes, sha256: hash.digest('hex') };
    await verifyPinnedDesktopArchive(path, pin);
    await dependencies.verifyArchive(path, { image: id, ...pin });
    images.push(kind === 'worker' ? { kind, file: 'worker.tar', image: id, ...pin } : { kind: 'browser', file: 'browser.tar', image: id, ...pin });
  }
  // Publish the provider only after both exports and all snapshot checks finish.
  await previous?.verify();
  for (const input of inputs) await verifyPinnedDesktopPayloadFile(input.path, input.pin);
  await writeFile(join(runtime, 'images.json'), JSON.stringify({ version: 1, images }, null, 2), { flag: 'wx' });
  await writeFile(join(runtime, 'worker.json'), JSON.stringify({ version: 1, provider: 'codex', codexVersion: '0.154.0', target: 'linux-x64',
    engine: { version: '29.1.3', arch: 'amd64', sandbox: 'codex-userns' },
    releaseCatalog,
    ...(browserImage ? { browserImage } : {}) }, null, 2), { flag: 'wx' });
  const receipt = await inspectDesktopWorkerPackage(output);
  await writeFile(join(output, 'build-receipt.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
    buildId: owner, buildImage, image, codexVersion: '0.154.0', sourceHashes, runtimeBaseHash: manifest.runtimeBaseHash,
    dockerfileSha256: inputs.find(input => input.path === join(worker, 'Dockerfile'))!.pin.sha256,
    ...(previous ? { previousWorkerPackage: { path: previous.path, files: previous.pins,
      images: previous.receipt.images, releaseCatalog: previous.receipt.provider.releaseCatalog } } : {}),
    archiveLoadVerified: false, modelVerified: false, distributionReady: false }, null, 2), { flag: 'wx' });
  return { output, ...receipt, distributionReady: false as const };
}

async function verifyCodexVersion(target: DesktopDockerTarget, image: string, owner: string): Promise<void> {
  const name = `ac-desktop-version-${owner}`;
  try {
    const result = await target.command('docker', ['run', '--rm', '--pull=never', '--name', name,
      '--label', 'app=agent-company', '--label', `agent-company.desktop-build=${owner}`, '--label', 'agent-company.role=desktop-version',
      '--read-only', '--network=none', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--memory=128m', '--cpus=0.25', '--pids-limit=32', '--entrypoint=codex', image, '--version'], { timeoutMs: 30_000 });
    if (result.code !== 0 || result.stdout.trim() !== 'codex-cli 0.154.0') throw new Error('worker의 실제 Codex 버전이 다릅니다.');
  } finally {
    const inspected = await target.command('docker', ['inspect', name, '--format', '{{json .Config.Labels}}'], { timeoutMs: 30_000 });
    if (inspected.code === 0) {
      const labels = JSON.parse(inspected.stdout);
      if (labels.app !== 'agent-company' || labels['agent-company.desktop-build'] !== owner || labels['agent-company.role'] !== 'desktop-version') {
        throw new Error('worker 버전 검사 컨테이너의 소유권이 다릅니다.');
      }
      const removed = await target.command('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
      if (removed.code !== 0) throw new Error('worker 버전 검사 컨테이너를 정리하지 못했습니다.');
      const absent = await target.command('docker', ['inspect', name], { timeoutMs: 30_000 });
      if (absent.code === 0 || !/No such (?:object|container)/i.test(absent.stderr)) throw new Error('worker 버전 검사 컨테이너 종료를 확인하지 못했습니다.');
    } else if (!/No such (?:object|container)/i.test(inspected.stderr)) throw new Error('worker 버전 검사 컨테이너 종료를 확인하지 못했습니다.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('설치형 worker 빌드는 Windows x64에서 실행합니다.');
  console.log(JSON.stringify({ type: 'desktop-worker-built', ...await buildDesktopWorker(desktopWorkerBuildArguments(process.argv.slice(2))) }));
}
