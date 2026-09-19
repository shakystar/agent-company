import { createHash } from 'node:crypto';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { ContainerRuntime } from './runtime.ts';
import { desktopPaths, type DesktopPaths } from './desktop-paths.ts';
import { desktopRuntimeSelectionSchema, type DesktopRuntimeSelection } from './desktop-runtime-settings.ts';
import { resolveDesktopCodexProvider } from './desktop-codex-provider.ts';
import { resolveDesktopWorkerProvider } from './desktop-worker-provider.ts';
import { createDesktopDockerTarget, type DesktopDockerTarget } from './desktop-docker-target.ts';
import { DesktopDockerAuth } from './desktop-docker-auth.ts';
import { command, type Command } from './process.ts';
import { validateWorkerReleaseCatalogSet, validateHistoricalWorkerAuthBindings,
  type HistoricalWorkerAuthBinding, type WorkerReleaseCatalog } from '../shared/runtime-releases.ts';

export class DesktopRuntimeFactoryError extends Error {
  constructor(readonly code: 'DESKTOP_RUNTIME_SELECTION_INVALID' | 'DESKTOP_RUNTIME_PROVIDER_MISSING'
    | 'DESKTOP_RUNTIME_PROVIDER_INVALID' | 'DESKTOP_RUNTIME_PROBE_FAILED') { super(code); this.name = 'DesktopRuntimeFactoryError'; }
}
export interface DesktopRuntimeFactoryDependencies {
  resolveAccount: typeof resolveDesktopCodexProvider;
  resolveWorker: typeof resolveDesktopWorkerProvider;
  createTarget: typeof createDesktopDockerTarget;
  /** Explicit transport injection for bounded probe tests; normal callers use the standard command. */
  probeCommand?: Command;
}
const defaults: DesktopRuntimeFactoryDependencies = { resolveAccount: resolveDesktopCodexProvider,
  resolveWorker: resolveDesktopWorkerProvider, createTarget: createDesktopDockerTarget };

export interface DesktopRuntimeContextOptions {
  paths: DesktopPaths; ownerKey: string; workspaceKey: string; selection: DesktopRuntimeSelection;
  /** Private migration metadata verified against its source export before use.
   * It is not a user-selectable provider and never contains credentials. */
  historicalReleaseCatalogs?: WorkerReleaseCatalog[];
  historicalAuthBindings?: HistoricalWorkerAuthBinding[];
}
export interface DesktopRuntimeProbe {
  engine: '29.1.3'; arch: 'amd64'; image: string; browserImage: string | null; model: string; credentialsPresent: boolean;
}
export async function resolveDesktopRuntimeSelection(options: DesktopRuntimeContextOptions, supplied: Partial<DesktopRuntimeFactoryDependencies>) {
  const dependencies = { ...defaults, ...supplied };
  let paths: DesktopPaths, selection: DesktopRuntimeSelection;
  try {
    paths = desktopPaths(options.paths.resourceRoot, options.paths.appDataRoot);
    if (Object.entries(paths).some(([key, value]) => options.paths[key as keyof DesktopPaths] !== value)) throw new Error();
    z.uuid().parse(options.ownerKey); z.uuid().parse(options.workspaceKey);
    selection = desktopRuntimeSelectionSchema.parse(options.selection);
  } catch { throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_SELECTION_INVALID'); }
  let account: Awaited<ReturnType<typeof resolveDesktopCodexProvider>>, worker: Awaited<ReturnType<typeof resolveDesktopWorkerProvider>>;
  try { [account, worker] = await Promise.all([dependencies.resolveAccount(paths.resourceRoot), dependencies.resolveWorker(paths.resourceRoot)]); }
  catch { throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_PROVIDER_INVALID'); }
  if (!account || !worker) throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_PROVIDER_MISSING');
  if (account.version !== worker.codexVersion) throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_PROVIDER_INVALID');
  let historicalReleaseCatalogs: WorkerReleaseCatalog[], historicalAuthBindings: HistoricalWorkerAuthBinding[];
  try {
    historicalReleaseCatalogs = validateWorkerReleaseCatalogSet(worker.releaseCatalog, options.historicalReleaseCatalogs ?? []).historical;
    historicalAuthBindings = validateHistoricalWorkerAuthBindings(worker.releaseCatalog, historicalReleaseCatalogs, options.historicalAuthBindings ?? []);
  }
  catch { throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_PROVIDER_INVALID'); }
  return { paths, selection, account, provider: worker, dependencies, historicalReleaseCatalogs, historicalAuthBindings };
}
function lazyTarget(selection: DesktopRuntimeSelection, dockerConfigDir: string,
  createTarget: typeof createDesktopDockerTarget, runner?: Command): DesktopDockerTarget {
  let opening: Promise<DesktopDockerTarget> | undefined;
  const selectedTarget = () => opening ??= createTarget({ wslExecutable: selection.wslExecutable,
    distro: selection.distro, dockerConfigDir, ...(runner ? { runner } : {}) })
    .catch(error => { opening = undefined; throw error; });
  return {
    command: async (file, args, commandOptions) => (await selectedTarget()).command(file, args, commandOptions),
    mapFile: async (file, signal) => (await selectedTarget()).mapFile(file, signal),
    mapAuthFile: async (file, signal) => (await selectedTarget()).mapAuthFile(file, signal),
  };
}

/** Presence/compatibility only. These checks neither authenticate a key nor create a model process. */
async function probeSelection(provider: NonNullable<Awaited<ReturnType<typeof resolveDesktopWorkerProvider>>>,
  selection: DesktopRuntimeSelection, target: DesktopDockerTarget,
  authentication: Pick<DesktopDockerAuth, 'assertIdle' | 'hasCredentials' | 'assertAccountAvailable'>,
  signal: AbortSignal): Promise<DesktopRuntimeProbe> {
  try {
    signal.throwIfAborted();
    const engine = await target.command('docker', ['version', '--format', '{{.Server.Version}}/{{.Server.Arch}}'], { signal, timeoutMs: 30_000 });
    if (engine.code !== 0 || engine.stdout.trim() !== `${provider.engine.version}/${provider.engine.arch}`) throw new Error();
    signal.throwIfAborted();
    const images = [...new Set([provider.releaseCatalog.active.image, ...(provider.browserImage ? [provider.browserImage] : [])])];
    for (const image of images) {
      const inspected = await target.command('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { signal, timeoutMs: 30_000 });
      if (inspected.code !== 0 || inspected.stdout.trim() !== image) throw new Error();
      signal.throwIfAborted();
    }
    await authentication.assertIdle();
    signal.throwIfAborted();
    const credentialsPresent = await authentication.hasCredentials();
    authentication.assertAccountAvailable();
    signal.throwIfAborted();
    return { engine: provider.engine.version, arch: provider.engine.arch, image: provider.releaseCatalog.active.image,
      browserImage: provider.browserImage ?? null, model: selection.model, credentialsPresent };
  } catch { throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_PROBE_FAILED'); }
}

/** No process is started until probe/recovery/execution. A missing target is retried only at the same explicit selection. */
export async function createDesktopRuntimeContext(options: DesktopRuntimeContextOptions,
  supplied: Partial<DesktopRuntimeFactoryDependencies> = {}) {
  const { paths, selection, account, provider, dependencies, historicalReleaseCatalogs, historicalAuthBindings } = await resolveDesktopRuntimeSelection(options, supplied);
  const target = lazyTarget(selection, join(paths.appDataRoot, 'runtime', 'docker'), dependencies.createTarget);
  const authentication = new DesktopDockerAuth({ credentialsRoot: paths.credentialsDir, workspaceKey: options.ownerKey, target });
  const runtime = new ContainerRuntime({ mode: 'docker', auth: 'desktop-codex', authFile: '',
    image: provider.releaseCatalog.active.image, releaseCatalog: provider.releaseCatalog, historicalReleaseCatalogs, historicalAuthBindings,
    browserImage: provider.browserImage, workspaceKey: options.workspaceKey, persistentWorkspaces: true,
    dockerSandbox: provider.engine.sandbox, model: selection.model, timeoutMs: 900_000 }, target.command,
  { authentication, mapHostPath: target.mapFile,
    securityProfiles: { worker: join(paths.resourceRoot, 'worker', 'security', 'codex-userns.json'),
      browser: join(paths.resourceRoot, 'worker', 'security', 'browser-userns.json') } });
  return { runtime, authentication, accountProvider: account,
    selection: Object.freeze(structuredClone(selection)),
    /** Engine/image availability and credential presence, not a model/authentication efficacy test. */
    probe: (signal: AbortSignal) => probeSelection(provider, selection, target, authentication, signal),
  };
}

/** Initial setup inspection under the installation lease. It returns values, never an execution capability.
 * Failed checks leave only their private probe target metadata, not an active runtime/configuration. */
export async function probeDesktopRuntimeSelection(options: DesktopRuntimeContextOptions & { signal?: AbortSignal },
  supplied: Partial<DesktopRuntimeFactoryDependencies> = {}): Promise<DesktopRuntimeProbe> {
  const timeout = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const { paths, selection: original, provider, dependencies } = await resolveDesktopRuntimeSelection(options, supplied);
    signal.throwIfAborted();
    const selection = { ...original, wslExecutable: win32.normalize(original.wslExecutable).replace(/^[a-z]:/, drive => drive.toUpperCase()) };
    const key = createHash('sha256').update(JSON.stringify([selection.wslExecutable, selection.distro])).digest('hex');
    const bindSignal = (runner: Command): Command => async (file, args, input = {}) => {
      const current = input.signal ? AbortSignal.any([input.signal, signal]) : signal;
      current.throwIfAborted();
      const result = await runner(file, args, { ...input, signal: current,
        timeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
        beforeSpawn: () => { current.throwIfAborted(); input.beforeSpawn?.(); } });
      // Await the real command's cancellation/pipe cleanup before reporting failure.
      current.throwIfAborted();
      return result;
    };
    const target = lazyTarget(selection, join(paths.appDataRoot, 'setup-probes', 'docker', key),
      dependencies.createTarget, bindSignal(dependencies.probeCommand ?? command));
    // Also covers the writer query, whose coordinator interface has no signal argument.
    const readOnlyTarget: DesktopDockerTarget = { ...target, command: bindSignal(target.command) };
    const authentication = new DesktopDockerAuth({ credentialsRoot: paths.credentialsDir,
      workspaceKey: options.ownerKey, target: readOnlyTarget });
    return await probeSelection(provider, selection, readOnlyTarget, authentication, signal);
  } catch (error) {
    if (error instanceof DesktopRuntimeFactoryError) throw error;
    throw new DesktopRuntimeFactoryError('DESKTOP_RUNTIME_PROBE_FAILED');
  }
}
