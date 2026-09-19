import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';
import { command, type Command, type CommandOptions } from './process.ts';

export class DesktopDockerTargetError extends Error {
  constructor(readonly code: 'DESKTOP_DOCKER_TARGET_INVALID' | 'DESKTOP_DOCKER_TARGET_FAILED') {
    super(code); this.name = 'DesktopDockerTargetError';
  }
}
const invalid = () => new DesktopDockerTargetError('DESKTOP_DOCKER_TARGET_INVALID');
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stable = (a: BigIntStats, b: BigIntStats) => same(a, b) && b.isFile() && b.nlink === 1n
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const markerSchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop-docker'),
  distro: z.string(), wslExecutable: z.string() }).strict();
const buildxMarkerSchema = z.object({ version: z.literal(1), product: z.literal('agent-company-desktop-buildx'),
  distro: z.string(), wslExecutable: z.string(), dockerConfigDir: z.string() }).strict();
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

function localPath(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw invalid();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(3).split(/[\\/]/).some(part =>
    /[<>:"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw invalid();
  const path = resolve(value);
  if (path === parse(path).root) throw invalid();
  return path;
}
async function inspectPath(path: string, kind: 'file' | 'directory', create = false): Promise<BigIntStats> {
  let cursor = parse(path).root;
  const parts = relative(cursor, path).split(/[\\/]/).filter(Boolean);
  let last!: BigIntStats;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]);
    const directory = index < parts.length - 1 || kind === 'directory';
    if (directory && create) await mkdir(cursor).catch(error => { if (error.code !== 'EEXIST') throw error; });
    last = await lstat(cursor, { bigint: true });
    if (last.isSymbolicLink() || (directory ? !last.isDirectory() : !last.isFile()) || relative(cursor, await realpath(cursor))) throw invalid();
  }
  return last;
}
async function smallDocument(path: string): Promise<unknown> {
  const before = await inspectPath(path, 'file');
  if (before.nlink !== 1n || before.size < 1n || before.size > 4096n) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const bytes = Buffer.alloc(4097);
  try {
    if (!stable(before, await handle.stat({ bigint: true }))) throw invalid();
    let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (BigInt(length) !== before.size || !stable(before, await handle.stat({ bigint: true })) || !stable(before, await lstat(path, { bigint: true }))) throw invalid();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { bytes.fill(0); await handle.close(); }
}
async function inspectBuildTokenFile(path: string, maximumBytes: bigint): Promise<void> {
  const before = await inspectPath(path, 'file');
  if (before.nlink !== 1n || before.size < 0n || before.size > maximumBytes) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!stable(before, await handle.stat({ bigint: true }))
      || !stable(before, await inspectPath(path, 'file'))) throw invalid();
  } finally { await handle.close(); }
}
function oneLine(value: string): string {
  const line = value.replace(/\r?\n$/, '');
  if (!line || line.length > 8192 || /[\x00-\x1f\x7f]/.test(line)) throw invalid();
  return line;
}
export interface DesktopDockerTarget {
  readonly command: Command;
  mapFile(path: string, signal?: AbortSignal): Promise<string>;
  mapAuthFile(path: string, signal?: AbortSignal): Promise<string>;
}

/** Explicit local WSL only. It never searches PATH, adopts a Docker context, or invokes a shell. */
export async function createDesktopDockerTarget(options: {
  wslExecutable: string; distro: string; dockerConfigDir: string; runner?: Command;
  /** Build-only state. Must be a fresh sibling/disjoint directory, never reused or inherited. */
  buildxConfigDir?: string;
}): Promise<DesktopDockerTarget> {
  try {
    const executable = localPath(options.wslExecutable), configDir = localPath(options.dockerConfigDir);
    const buildxDir = options.buildxConfigDir === undefined ? undefined : localPath(options.buildxConfigDir);
    if (buildxDir && (inside(configDir, buildxDir) || inside(buildxDir, configDir))) throw invalid();
    if (buildxDir) await inspectPath(dirname(buildxDir), 'directory');
    if (basename(executable).toLowerCase() !== 'wsl.exe' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(options.distro)) throw invalid();
    const distro = options.distro, executableStat = await inspectPath(executable, 'file'), runner = options.runner ?? command;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const invoke = async (args: string[], config: CommandOptions = {}) => {
      if (!same(executableStat, await inspectPath(executable, 'file'))) throw invalid();
      return runner(executable, args, { ...config, env: { ...env } });
    };
    const bytes: Buffer[] = []; let length = 0;
    const listed = await invoke(['--list', '--quiet'], { timeoutMs: 15_000, captureStdout: false, onStdout(chunk) {
      length += chunk.length; if (length > 64 * 1024) throw invalid(); bytes.push(Buffer.from(chunk));
    } });
    if (listed.code !== 0) throw invalid();
    const raw = Buffer.concat(bytes);
    const list = raw.length ? new TextDecoder(raw.includes(0) || (raw[0] === 0xff && raw[1] === 0xfe) ? 'utf-16le' : 'utf-8', { fatal: true }).decode(raw)
      : listed.stdout;
    if (list.length > 64 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(list)) throw invalid();
    const distros = list.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (distros.some(value => value !== value.trim()) || new Set(distros).size !== distros.length || !distros.includes(distro)) throw invalid();
    let mappedBuildx: string | undefined;
    const linux = (file: string, args: string[]) => ['--distribution', distro, '--exec', '/usr/bin/env', '-i',
      'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', ...(mappedBuildx ? [`BUILDX_CONFIG=${mappedBuildx}`] : []), file, ...args];
    const mapPath = async (path: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const mapped = await invoke(linux('/usr/bin/wslpath', ['-a', '-u', path]), { signal, timeoutMs: 15_000 });
      if (mapped.code !== 0) throw invalid();
      const value = oneLine(mapped.stdout);
      if (!value.startsWith('/') || value.includes('\\') || value.split('/').some(part => part === '.' || part === '..')) throw invalid();
      const restored = await invoke(linux('/usr/bin/wslpath', ['-a', '-w', value]), { signal, timeoutMs: 15_000 });
      if (restored.code !== 0) throw invalid();
      const original = oneLine(restored.stdout);
      if (process.platform === 'win32' ? !win32.isAbsolute(original) || win32.relative(path, original) !== '' : relative(path, original) !== '') throw invalid();
      signal?.throwIfAborted();
      return value;
    };
    let buildxStat: BigIntStats | undefined;
    const buildxMarker = 'desktop-buildx-target.json';
    const buildxIdentity = { version: 1 as const, product: 'agent-company-desktop-buildx' as const,
      distro, wslExecutable: executable, dockerConfigDir: configDir };
    if (buildxDir) {
      await mkdir(buildxDir); // EEXIST is intentional, including a prior owned build directory.
      buildxStat = await inspectPath(buildxDir, 'directory');
      await writeFile(join(buildxDir, buildxMarker), JSON.stringify(buildxIdentity), { flag: 'wx', mode: 0o600 });
    }
    const validateBuildx = async () => {
      if (!buildxDir || !buildxStat) return;
      if (!same(buildxStat, await inspectPath(buildxDir, 'directory'))) throw invalid();
      const marker = buildxMarkerSchema.parse(await smallDocument(join(buildxDir, buildxMarker)));
      if (marker.distro !== distro || marker.wslExecutable !== executable || marker.dockerConfigDir !== configDir) throw invalid();
    };
    await validateBuildx();
    if (buildxDir) { mappedBuildx = await mapPath(buildxDir); await validateBuildx(); }
    await inspectPath(configDir, 'directory', true);
    const names = await readdir(configDir), markerName = 'desktop-docker-target.json';
    const identity = { version: 1 as const, product: 'agent-company-desktop-docker' as const, distro, wslExecutable: executable };
    if (!names.length) {
      await writeFile(join(configDir, markerName), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      await writeFile(join(configDir, 'config.json'), '{}', { flag: 'wx', mode: 0o600 });
    }
    const configStat = await inspectPath(configDir, 'directory');
    const validateConfig = async () => {
      await validateBuildx();
      if (!same(configStat, await inspectPath(configDir, 'directory'))) throw invalid();
      const found = await readdir(configDir);
      // BuildKit stores registry-host seed randomness in Docker config.Dir(),
      // independently of BUILDX_CONFIG. Its flock file contains no data. The
      // 64 KiB seed bound is our build limit, not an upstream fixed file size.
      // https://github.com/docker/buildx/blob/9e66234aa13328a5e75b75aa5574e1ca6d6d9c01/vendor/github.com/moby/buildkit/session/auth/authprovider/tokenseed.go
      const buildFiles = buildxDir ? ['.token_seed', '.token_seed.lock'] : [];
      if (!found.includes(markerName) || !found.includes('config.json')
        || found.some(name => ![markerName, 'config.json', ...buildFiles].includes(name))) throw invalid();
      for (const name of buildFiles) {
        if (found.includes(name)) await inspectBuildTokenFile(join(configDir, name), name === '.token_seed' ? 64n * 1024n : 0n);
      }
      const marker = markerSchema.parse(await smallDocument(join(configDir, markerName)));
      if (marker.distro !== identity.distro || marker.wslExecutable !== identity.wslExecutable) throw invalid();
      const config = await smallDocument(join(configDir, 'config.json'));
      if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) throw invalid();
    };
    await validateConfig();
    const mappedConfig = await mapPath(configDir);
    await validateConfig();
    const wrapped: Command = async (file, args, config = {}) => {
      try {
        const boundary = args.indexOf('--');
        if (boundary !== -1 && (!['run', 'create'].includes(args[0]) || !/^sha256:[a-f0-9]{64}$/.test(args[boundary + 1] ?? ''))) throw invalid();
        // Only a Docker end-of-options marker followed by an immutable image
        // makes the remaining words container arguments (for example python -c).
        const dockerOptions = boundary === -1 ? args : args.slice(0, boundary);
        if (file !== 'docker' || !args.length || !/^[a-z][a-z-]*$/.test(args[0])
          || ['context', 'login', 'logout'].includes(args[0])
          || dockerOptions.some(value => /^(?:--(?:host|context|config|tls|tlsverify|tlscacert|tlskey)(?:=|$)|-H|-c)/.test(value))) throw invalid();
        await validateConfig();
        return await invoke(linux('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', '--config', mappedConfig, ...args]), config);
      } catch (error) { throw error instanceof DesktopDockerTargetError ? error : new DesktopDockerTargetError('DESKTOP_DOCKER_TARGET_FAILED'); }
    };
    const mapFile = async (value: string, signal?: AbortSignal): Promise<string> => {
      try {
        const path = localPath(value), before = await inspectPath(path, 'file');
        if (before.nlink !== 1n) throw invalid();
        await validateConfig();
        const mapped = await mapPath(path, signal);
        if (!stable(before, await inspectPath(path, 'file'))) throw invalid();
        return mapped;
      } catch (error) { throw error instanceof DesktopDockerTargetError ? error : new DesktopDockerTargetError('DESKTOP_DOCKER_TARGET_FAILED'); }
    };
    return { command: wrapped, mapFile, async mapAuthFile(value, signal) {
      if (basename(value) !== 'auth.json') throw invalid();
      return mapFile(value, signal);
    } };
  } catch (error) { throw error instanceof DesktopDockerTargetError ? error : new DesktopDockerTargetError('DESKTOP_DOCKER_TARGET_INVALID'); }
}
