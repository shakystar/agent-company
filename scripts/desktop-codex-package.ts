import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import source from '../desktop/providers/codex/0.154.0/source.json' with { type: 'json' };
import { resolveDesktopCodexProvider } from '../server/desktop-codex-provider.ts';
import { assertDesktopProviderDirectory, verifyPinnedDesktopFile } from './desktop-provider-files.ts';

const noticesRoot = fileURLToPath(new URL('../desktop/providers/codex/0.154.0/', import.meta.url));

/** No environment defaults, host package discovery, download, execution or credential reads. */
export function desktopCodexExecutableArgument(args: string[]): string | null {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== '--codex-executable' || !args[1]) {
    throw new Error('사용법: --codex-executable <공식 Codex 0.154.0 Windows x64 실행파일 절대 경로>');
  }
  return args[1];
}

export async function inspectDesktopCodexPackage(executable: string) {
  await verifyPinnedDesktopFile(executable, source.executable, { windowsX64Executable: true });
  for (const notice of source.notices) await verifyPinnedDesktopFile(join(noticesRoot, notice.file), notice);
  return { provider: 'codex' as const, version: '0.154.0' as const, target: 'x86_64-pc-windows-msvc' as const,
    bytes: source.executable.bytes + source.notices.reduce((sum, notice) => sum + notice.bytes, 0),
    executableSha256: source.executable.sha256, releaseUrl: source.releaseUrl, commit: source.commit,
    scope: 'account-management-only' as const, distributionReady: false as const };
}

/** The caller owns a fresh payload resource root. A failed copy never publishes provider.json. */
export async function stageDesktopCodexPackage(executable: string, resourceRoot: string) {
  const inspected = await inspectDesktopCodexPackage(executable);
  await assertDesktopProviderDirectory(resourceRoot);
  const directory = join(resourceRoot, 'providers', 'codex');
  await mkdir(join(resourceRoot, 'providers')); // Deliberately reject an existing provider tree.
  await mkdir(directory);
  await verifyPinnedDesktopFile(executable, source.executable, { windowsX64Executable: true, destination: join(directory, 'codex.exe') });
  for (const notice of source.notices) {
    await verifyPinnedDesktopFile(join(noticesRoot, notice.file), notice, { destination: join(directory, notice.file) });
  }
  await writeFile(join(directory, 'source.json'), JSON.stringify(source, null, 2) + '\n', { flag: 'wx' });
  const license = source.notices.find(notice => notice.file === 'LICENSE');
  if (!license) throw new Error('DESKTOP_PROVIDER_LICENSE_MISSING');
  await writeFile(join(directory, 'provider.json'), JSON.stringify({ schemaVersion: 1, provider: inspected.provider,
    version: inspected.version, target: inspected.target,
    executable: { file: 'codex.exe', bytes: source.executable.bytes, sha256: source.executable.sha256 },
    license: { file: 'LICENSE', bytes: license.bytes, sha256: license.sha256 } }, null, 2) + '\n', { flag: 'wx' });
  const provider = await resolveDesktopCodexProvider(resourceRoot);
  if (!provider || provider.sha256 !== inspected.executableSha256) throw new Error('DESKTOP_PROVIDER_STAGE_INVALID');
  return inspected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = desktopCodexExecutableArgument(process.argv.slice(2));
  if (!executable) throw new Error('검증할 공식 Codex 실행파일의 절대 경로가 필요합니다.');
  console.log(JSON.stringify({ type: 'desktop-codex-input-verified', ...await inspectDesktopCodexPackage(executable),
    binaryCopied: false, loginStarted: false, modelCalls: 0 }));
}
