import { assertDesktopMigrationStartup } from './desktop-migration-cutover.ts';
import { createDesktopGitHubRuntime } from './desktop-github.ts';
import { createApp } from './app.ts';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { desktopPaths, openDesktopInstallation } from './desktop-paths.ts';
import { createDesktopAccess } from './desktop-access.ts';
import { desktopStartSchema, type DesktopStart, type DesktopController } from './desktop-protocol.ts';
import { OperationalModelBudget } from './operational-budget.ts';
import { activeStorage, defaultStorageLimits, type StorageConfig } from './storage.ts';
import { ResourceScheduler, readResourceConfig } from './resources.ts';
import type { RuntimeDriver } from '../shared/types.ts';
import { DesktopSetup, DesktopSetupError } from './desktop-setup.ts';
import { resolveDesktopCodexProvider } from './desktop-codex-provider.ts';
import { desktopRuntimeSettings, type DesktopRuntimeSettingsSnapshot } from './desktop-runtime-settings.ts';
import { createDesktopRuntimeContext, probeDesktopRuntimeSelection } from './desktop-runtime-factory.ts';
import { resolveDesktopWorkerProvider } from './desktop-worker-provider.ts';
import { DesktopRuntimeSetup } from './desktop-runtime-setup.ts';
import { desktopImagePackageAvailable } from './desktop-image-package.ts';
import { hasUnfinishedDesktopImageInstall, installDesktopRuntimeImages, inspectDesktopImageRecovery, recoverDesktopRuntimeImages } from './desktop-image-install.ts';
import { canonicalRuntimeJson } from '../shared/runtime-releases.ts';
import { DesktopMcp } from './desktop-mcp.ts';
import { DesktopUpdatePreparation } from './desktop-update-preparation.ts';
import { loadDesktopMigrationRuntime } from './desktop-migration-runtime.ts';

const unconfiguredRuntimes = new WeakSet<RuntimeDriver>();

/** A fresh installation has no model connection. It must not borrow the developer's runtime or auth. */
export function unconfiguredDesktopRuntime(): RuntimeDriver {
  const runtime: RuntimeDriver = {
    async inspect() { return { mode: 'docker', available: false, authenticated: false, image: '', model: '',
      version: null, message: '이 설치형 작업실의 실행 환경과 모델 연결을 설정해야 합니다.' }; },
    async execute() { throw new Error('설치형 작업실의 실행 환경과 모델 연결이 없습니다.'); },
    async canResume() { return false; },
    // This entry cannot create a worker or import a volume. Local metadata still has disk quotas.
    forkWorkspace() { return runtime; },
    async listWorkspaceVolumes() { return []; },
    // This implementation has no worker/helper creation path. Login children are
    // tracked independently through the service's external admission lease.
    async confirmDeploymentIdle() {},
  };
  unconfiguredRuntimes.add(runtime); return runtime;
}

export async function startDesktopController(raw: DesktopStart, signal: AbortSignal,
  runtime?: RuntimeDriver): Promise<DesktopController> {
  const request = desktopStartSchema.parse(raw);
  signal.throwIfAborted();
  const paths = desktopPaths(request.resourceRoot, request.appDataRoot);
  const installation = await openDesktopInstallation(paths);
  let app: Awaited<ReturnType<typeof createApp>> | undefined, origin: string | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // A failed service close must retain the lease; never permit another writer over a live DB.
    await app?.close();
    await installation.release();
    origin = undefined;
  })();
  try {
    signal.throwIfAborted();
    await assertDesktopMigrationStartup(paths.appDataRoot, installation.workspaceKey);
    const storage: StorageConfig = { rootDir: paths.dataDir, backupDir: paths.backupDir,
      ownerKey: installation.workspaceKey, limits: { ...defaultStorageLimits } };
    const selected = await activeStorage(storage);
    const operationalBudget = await OperationalModelBudget.open({ directory: join(paths.dataDir, 'operational-budget'),
      ownerKey: installation.workspaceKey });
    let provider: Awaited<ReturnType<typeof resolveDesktopCodexProvider>> = null, providerInvalid = false;
    try { provider = await resolveDesktopCodexProvider(paths.resourceRoot); } catch { providerInvalid = true; }
    const injectedRuntime = Boolean(runtime), settingsStore = desktopRuntimeSettings(paths.appDataRoot, installation.workspaceKey);
    let savedSettings: DesktopRuntimeSettingsSnapshot | null = null, configurationFailed = false, unfinishedInstall = false;
    let runtimeContext: Awaited<ReturnType<typeof createDesktopRuntimeContext>> | undefined;
    if (!runtime) {
      try {
        const settings = savedSettings = await settingsStore.read();
        unfinishedInstall = await hasUnfinishedDesktopImageInstall(paths.appDataRoot);
        if (unfinishedInstall) throw new Error('DESKTOP_RUNTIME_INSTALL_UNCERTAIN');
        if (settings.selection) {
          const migrationRuntime = await loadDesktopMigrationRuntime(selected.dataDir, installation.workspaceKey, selected.workspaceKey);
          runtimeContext = await createDesktopRuntimeContext({ paths, ownerKey: installation.workspaceKey,
            workspaceKey: selected.workspaceKey, selection: settings.selection, ...migrationRuntime }, { resolveAccount: async () => provider });
          runtime = runtimeContext.runtime;
        } else runtime = unconfiguredDesktopRuntime();
      } catch {
        configurationFailed = true;
        // A damaged saved configuration may have prior writers. Preserve Runs and
        // forbid account changes instead of treating it as a brand-new installation.
        const message = '저장된 실행 환경을 확인하지 못했습니다. 설치 구성과 실행 환경을 복구한 뒤 앱을 다시 시작할 수 있습니다.';
        runtime = unconfiguredDesktopRuntime(); unconfiguredRuntimes.delete(runtime);
        runtime.inspect = async () => ({ mode: 'docker', available: false, authenticated: false, image: '', model: '', version: null, message });
        runtime.recover = async () => { throw new Error(message); };
        runtime.confirmDeploymentIdle = async () => { throw new Error(message); };
      }
    }
    const selectedRuntime = runtime;
    let workerAvailable = Boolean(runtimeContext);
    const setupResourcesReadable = !injectedRuntime && !!savedSettings && (!configurationFailed || unfinishedInstall);
    if (setupResourcesReadable && !workerAvailable) {
      try { workerAvailable = Boolean(await resolveDesktopWorkerProvider(paths.resourceRoot)); } catch { /* Missing/invalid bundle remains unavailable. */ }
    }
    const imagesAvailable = setupResourcesReadable && Boolean(provider) && workerAvailable && await desktopImagePackageAvailable(paths.resourceRoot);
    let completedImageRecovery: Awaited<ReturnType<typeof recoverDesktopRuntimeImages>> | undefined;
    let accountSetup: DesktopSetup | undefined, runtimeSetup: DesktopRuntimeSetup | undefined, mcp: DesktopMcp | undefined;
    let updates: DesktopUpdatePreparation | undefined;
    const github = await createDesktopGitHubRuntime(paths.appDataRoot, installation.workspaceKey);
    app = await createApp({ dataDir: join(selected.dataDir, 'db'), runtime, storage, operationalBudget, github,
      scheduler: new ResourceScheduler(readResourceConfig({})), allowedOrigins: [],
      desktopAccess: createDesktopAccess({ token: request.token, cookieName: request.cookieName, origin: () => origin }),
      desktopUpdate: service => { updates = new DesktopUpdatePreparation(service); },
      desktopMcp: async service => mcp = await DesktopMcp.open({ appDataRoot: paths.appDataRoot, resourceRoot: paths.resourceRoot,
        ownerKey: installation.workspaceKey, generationKey: selected.workspaceKey, service,
        generation: async () => (await activeStorage(storage)).workspaceKey, origin: () => origin }),
      desktopSetup: admit => accountSetup = new DesktopSetup({ provider, providerInvalid, credentialsRoot: paths.credentialsDir,
        workspaceKey: installation.workspaceKey, admit: () => {
          const releaseExternal = admit();
          try {
            const releaseAccount = runtimeContext?.authentication.admitAccount();
            return () => { releaseAccount?.(); releaseExternal(); };
          } catch {
            releaseExternal();
            throw new DesktopSetupError(409, 'SETUP_RUNTIME_ACTIVE', '모델의 인증 사용과 정리가 끝난 뒤 계정 연결을 변경할 수 있습니다.');
          }
        }, assertIdle: () => {
          try {
            runtimeSetup?.assertIdle();
            if (runtimeContext) runtimeContext.authentication.assertAccountAvailable();
            else if (!unconfiguredRuntimes.has(selectedRuntime)) throw new Error();
          } catch { throw new DesktopSetupError(409, 'SETUP_RUNTIME_ACTIVE', '모델의 인증 사용과 정리가 끝난 뒤 계정 연결을 변경할 수 있습니다.'); }
        }, assertNoCredentialWriters: runtimeContext ? () => runtimeContext.authentication.assertNoWriters() : undefined,
        executionReady: runtimeContext ? async () => {
          return (await runtimeContext.probe(AbortSignal.timeout(30_000))).credentialsPresent;
        } : undefined }),
      desktopRuntimeSetup: injectedRuntime ? undefined : admit => runtimeSetup = new DesktopRuntimeSetup({
        available: Boolean(provider) && workerAvailable, recoveryRequired: configurationFailed, initial: savedSettings,
        settings: settingsStore, admit, assertAccountIdle: () => accountSetup!.assertIdle(),
        probe: (selection, signal) => probeDesktopRuntimeSelection({ paths, ownerKey: installation.workspaceKey,
          workspaceKey: selected.workspaceKey, selection, signal }),
        ...(imagesAvailable ? {
          install: (selection, signal, onProgress) => installDesktopRuntimeImages({ paths,
            ownerKey: installation.workspaceKey, workspaceKey: selected.workspaceKey, selection, signal, onProgress }),
          recovery: {
            inspect: signal => inspectDesktopImageRecovery({ paths, ownerKey: installation.workspaceKey,
              workspaceKey: selected.workspaceKey, signal }),
            recover: async (info, signal, onProgress) => {
              completedImageRecovery = undefined;
              completedImageRecovery = await recoverDesktopRuntimeImages({ paths, ownerKey: installation.workspaceKey,
                workspaceKey: selected.workspaceKey, info, signal, onProgress });
            },
            finish: async info => {
              const completed = completedImageRecovery;
              if (!completed || completed.fingerprint !== info.fingerprint
                || canonicalRuntimeJson(completed.selection) !== canonicalRuntimeJson(info.selection)) throw new Error('DESKTOP_RUNTIME_INSTALL_UNCERTAIN');
              await completed.finish(); completedImageRecovery = undefined;
            },
          },
        } : {}),
      }),
      preview: { controllerOrigins: () => origin ? [origin] : [] } });
    await app.register(fastifyStatic, { root: paths.distDir });
    app.setNotFoundHandler((incoming, reply) => incoming.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'API 경로를 찾을 수 없습니다.' }) : reply.sendFile('index.html'));
    signal.throwIfAborted();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    signal.throwIfAborted();
    origin = address;
    await mcp?.publish();
    signal.throwIfAborted();
    return { origin, workspaceKey: installation.workspaceKey, close,
      beginClose: () => updates!.beginClose(),
      update: (command, controlSignal) => updates!.control(command, controlSignal) };
  } catch (error) {
    // The service/store reports a failed startup cleanup separately. Retain both
    // leases until this process exits and normal stale-lease recovery can run.
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'SERVICE_STARTUP_CLEANUP_PENDING')) await close();
    throw error;
  }
}
