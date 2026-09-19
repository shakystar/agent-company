import { z } from 'zod';
import type { DesktopRuntimeInstallProgress, DesktopRuntimeRecoveryInfo, DesktopRuntimeSelection, DesktopRuntimeSetupInput, DesktopRuntimeSetupStatus } from '../shared/desktop-runtime-setup.ts';
import { desktopRuntimeSelectionSchema, DesktopRuntimeSettingsError, type desktopRuntimeSettings,
  type DesktopRuntimeSettingsSnapshot } from './desktop-runtime-settings.ts';
import { DesktopSetupError } from './desktop-setup.ts';

export interface DesktopRuntimeSetupOptions {
  available: boolean;
  recoveryRequired: boolean;
  initial: DesktopRuntimeSettingsSnapshot | null;
  settings: ReturnType<typeof desktopRuntimeSettings>;
  admit: () => () => void;
  assertAccountIdle: () => void;
  probe: (selection: DesktopRuntimeSetupInput['selection'], signal: AbortSignal) => Promise<unknown>;
  /** Resolves or rejects only after its actual child processes and cleanup have completed. */
  install?: (selection: DesktopRuntimeSetupInput['selection'], signal: AbortSignal,
    onProgress: (progress: DesktopRuntimeInstallProgress) => void) => Promise<unknown>;
  recovery?: {
    inspect(signal: AbortSignal): Promise<DesktopRuntimeRecoveryInfo>;
    recover(info: DesktopRuntimeRecoveryInfo, signal: AbortSignal,
      onProgress: (progress: DesktopRuntimeInstallProgress) => void): Promise<unknown>;
    /** Runs after the settings commit boundary and must retain the record on failure. */
    finish(info: DesktopRuntimeRecoveryInfo): Promise<void>;
  };
}

const recoverySchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), selection: desktopRuntimeSelectionSchema,
  images: z.array(z.object({ kind: z.enum(['worker', 'browser']), status: z.enum(['present', 'missing']) }).strict()).min(1).max(2)
    .refine(images => images.filter(image => image.kind === 'worker').length === 1 && new Set(images.map(image => image.kind)).size === images.length),
}).strict();
const sameSelection = (a: DesktopRuntimeSelection | null, b: DesktopRuntimeSelection | null) => a === null || b === null ? a === b
  : a.kind === b.kind && a.wslExecutable === b.wslExecutable && a.distro === b.distro && a.model === b.model;

/** Initial configuration only. Saved changes take effect in a new native controller process. */
export class DesktopRuntimeSetup {
  private state: DesktopRuntimeSetupStatus;
  private operation?: Promise<DesktopRuntimeSetupStatus>;
  private controller?: AbortController;
  private closing = false;
  private committing = false;
  private closePromise?: Promise<void>;
  private expectedSettings: DesktopRuntimeSettingsSnapshot | null;
  constructor(private readonly options: DesktopRuntimeSetupOptions) {
    this.expectedSettings = options.initial ? structuredClone(options.initial) : null;
    this.state = { revision: 0, available: options.available && !options.recoveryRequired,
      imageInstallAvailable: options.available && !options.recoveryRequired && !!options.install, progress: null,
      recoveryAvailable: !!options.recovery, recovery: null,
      selection: options.initial?.selection ? structuredClone(options.initial.selection) : null,
      phase: options.recoveryRequired ? 'recoveryRequired' : options.initial?.selection ? 'configured'
        : options.available ? 'unconfigured' : 'unavailable', error: null };
  }
  status(): DesktopRuntimeSetupStatus { return structuredClone(this.state); }
  assertIdle(): void {
    if (this.closing || this.operation) throw new DesktopSetupError(409, 'SETUP_RUNTIME_BUSY', '실행 환경 작업이 끝난 뒤 계정 연결을 변경할 수 있습니다.');
  }
  private set(patch: Partial<DesktopRuntimeSetupStatus>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1,
      ...(this.closing ? { phase: 'closing' as const } : {}) };
  }
  configure(input: DesktopRuntimeSetupInput): Promise<DesktopRuntimeSetupStatus> {
    return this.begin(input, false);
  }
  install(input: DesktopRuntimeSetupInput): Promise<DesktopRuntimeSetupStatus> {
    return this.begin(input, true);
  }
  private async readExpectedSettings(selection?: DesktopRuntimeSelection) {
    const current = await this.options.settings.read(), expected = this.expectedSettings;
    if (!expected || current.revision !== expected.revision || !sameSelection(current.selection, expected.selection)
      || selection && current.selection && !sameSelection(current.selection, selection)) {
      throw new DesktopRuntimeSettingsError('DESKTOP_RUNTIME_SETTINGS_STALE');
    }
    return current;
  }
  private reportProgress(controller: AbortController, phase: 'installing' | 'recovering') {
    return (progress: DesktopRuntimeInstallProgress) => {
      if (this.closing || controller.signal.aborted || this.controller !== controller || this.state.phase !== phase
        || !progress || !['verifying', 'checking', 'loading', 'downloading'].includes(progress.stage)
        || !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total)
        || progress.completed < 0 || progress.total < progress.completed) return;
      // Progress is observational; it must not invalidate a pending cancellation revision.
      this.state = { ...this.state, progress: { stage: progress.stage, completed: progress.completed, total: progress.total } };
    };
  }
  inspectRecovery(input: { revision: number }): Promise<DesktopRuntimeSetupStatus> { return this.beginRecovery(input, false); }
  recover(input: { revision: number }): Promise<DesktopRuntimeSetupStatus> { return this.beginRecovery(input, true); }
  private beginRecovery(input: { revision: number }, retrying: boolean): Promise<DesktopRuntimeSetupStatus> {
    this.assertIdle(); this.assertRevision(input.revision);
    const recovery = this.options.recovery, info = this.state.recovery ? structuredClone(this.state.recovery) : null;
    if (!recovery || this.state.phase !== 'recoveryRequired' || retrying && !info) {
      throw new DesktopSetupError(409, 'SETUP_RUNTIME_RECOVERY_UNAVAILABLE', '현재 상태에서는 실행 이미지 복구를 시작할 수 없습니다.');
    }
    this.options.assertAccountIdle();
    const release = this.options.admit(), controller = new AbortController();
    this.controller = controller;
    this.set({ phase: retrying ? 'recovering' : 'diagnosing', progress: null, error: null, ...(!retrying ? { recovery: null } : {}) });
    const operation = (async () => {
      await this.readExpectedSettings(info?.selection); controller.signal.throwIfAborted();
      if (!retrying) {
        const diagnosed = recoverySchema.parse(await recovery.inspect(controller.signal)); controller.signal.throwIfAborted();
        await this.readExpectedSettings(diagnosed.selection); controller.signal.throwIfAborted();
        this.set({ phase: 'recoveryRequired', recovery: diagnosed }); return;
      }
      // Only the server-held diagnosis is replayed. Each callback receives its own snapshot.
      await recovery.recover(structuredClone(info!), controller.signal, this.reportProgress(controller, 'recovering'));
      controller.signal.throwIfAborted(); this.set({ phase: 'checking', progress: null });
      await this.options.probe(structuredClone(info!.selection), controller.signal); controller.signal.throwIfAborted();
      const current = await this.readExpectedSettings(info!.selection); controller.signal.throwIfAborted();
      this.committing = true; this.set({ phase: 'saving', progress: null });
      if (!current.selection) {
        const saved = await this.options.settings.save(info!.selection, current.revision);
        // A later finish failure must never cause a second settings write on explicit retry.
        this.expectedSettings = structuredClone(saved); this.set({ selection: structuredClone(saved.selection) });
      }
      await recovery.finish(structuredClone(info!));
      this.set({ phase: 'restartRequired', selection: structuredClone(info!.selection), recovery: null, progress: null, error: null });
    })().catch(error => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const cancelled = controller.signal.aborted && !this.committing && code !== 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN'
        && !(error instanceof DesktopRuntimeSettingsError);
      this.set({ phase: 'recoveryRequired', available: false, imageInstallAvailable: false, progress: null, recovery: null,
        error: { code: cancelled ? 'SETUP_RUNTIME_RECOVERY_CANCELLED' : 'SETUP_RUNTIME_RECOVERY_FAILED',
          message: cancelled ? '복구 작업을 취소했습니다. 복구 기록은 유지됩니다.'
            : code === 'DESKTOP_RUNTIME_INSTALL_SPACE' ? '실행 이미지를 복구할 여유 공간이 부족합니다.'
            : code === 'DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE' ? '실행 이미지와 Docker 저장 방식이 호환되지 않습니다. 호환되는 설치 묶음이 필요합니다.'
            : '실행 이미지 복구를 완료하지 못했습니다. 복구 기록은 유지됩니다. 다시 진단할 수 있습니다.' } });
    }).then(() => this.status()).finally(() => {
      if (this.operation === operation) this.operation = undefined;
      if (this.controller === controller) this.controller = undefined;
      this.committing = false; release();
    });
    this.operation = operation; return operation;
  }
  private assertRevision(value: number) {
    if (!Number.isSafeInteger(value) || value !== this.state.revision) {
      throw new DesktopSetupError(409, 'SETUP_STALE', '실행 환경 상태가 변경됐습니다. 최신 상태를 다시 확인할 수 있습니다.');
    }
  }
  private begin(input: DesktopRuntimeSetupInput, installing: boolean): Promise<DesktopRuntimeSetupStatus> {
    this.assertIdle();
    this.assertRevision(input.revision);
    if (!this.state.available || this.state.phase !== 'unconfigured' || installing && !this.state.imageInstallAvailable) {
      throw new DesktopSetupError(409, 'SETUP_RUNTIME_UNAVAILABLE', '현재 상태에서는 새 실행 환경을 저장할 수 없습니다.');
    }
    const selection = desktopRuntimeSelectionSchema.parse(input.selection);
    this.options.assertAccountIdle();
    const release = this.options.admit(), controller = new AbortController();
    this.controller = controller; this.set({ phase: installing ? 'installing' : 'checking', progress: null, error: null });
    const operation = (async () => {
      const current = await this.options.settings.read();
      controller.signal.throwIfAborted();
      if (current.selection || current.revision !== this.options.initial?.revision) throw new DesktopRuntimeSettingsError('DESKTOP_RUNTIME_SETTINGS_STALE');
      if (installing) {
        await this.options.install!(selection, controller.signal, this.reportProgress(controller, 'installing'));
        controller.signal.throwIfAborted(); this.set({ phase: 'checking', progress: null });
      }
      await this.options.probe(selection, controller.signal);
      controller.signal.throwIfAborted();
      // This is the commit boundary: cancellation cannot claim to undo an atomic settings write.
      this.committing = true; this.set({ phase: 'saving', progress: null });
      const saved = await this.options.settings.save(selection, current.revision);
      this.set({ phase: 'restartRequired', selection: saved.selection, progress: null, error: null });
    })().catch(error => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const uncertain = code === 'DESKTOP_RUNTIME_INSTALL_UNCERTAIN';
      const damaged = error instanceof DesktopRuntimeSettingsError || uncertain;
      const cancelled = controller.signal.aborted && !damaged && !this.committing;
      this.set({ phase: damaged ? 'recoveryRequired' : 'unconfigured',
        available: !damaged && this.options.available,
        imageInstallAvailable: !damaged && this.options.available && !!this.options.install, progress: null,
        error: { code: uncertain ? 'SETUP_RUNTIME_INSTALL_UNCERTAIN' : damaged ? 'SETUP_RUNTIME_SETTINGS_FAILED' : cancelled ? 'SETUP_RUNTIME_CANCELLED' : installing ? 'SETUP_RUNTIME_INSTALL_FAILED' : 'SETUP_RUNTIME_CHECK_FAILED',
          message: uncertain ? '이미지 처리의 완료 여부를 확인하지 못했습니다. 실행 환경 복구가 필요합니다.'
            : damaged ? '저장된 실행 환경을 확인하지 못했습니다. 앱 데이터 복구가 필요합니다.'
            : cancelled ? '실행 환경 작업을 취소했습니다. 설정은 저장하지 않았습니다.'
            : code === 'DESKTOP_RUNTIME_INSTALL_SPACE' ? '실행 이미지를 설치할 여유 공간이 부족합니다.'
            : code === 'DESKTOP_RUNTIME_INSTALL_INCOMPATIBLE' ? '실행 이미지와 Docker 저장 방식이 호환되지 않습니다. 호환되는 설치 묶음이 필요합니다.'
            : installing ? '실행 이미지 설치 또는 실행 환경 확인을 완료하지 못했습니다. 지정한 WSL 배포판과 Docker 상태를 확인할 수 있습니다.'
            : '실행 환경을 확인하지 못했습니다. WSL 배포판과 Docker, 앱의 실행 이미지 준비 상태를 확인할 수 있습니다.' } });
    }).then(() => this.status()).finally(() => {
      if (this.operation === operation) this.operation = undefined;
      if (this.controller === controller) this.controller = undefined;
      this.committing = false;
      release();
    });
    this.operation = operation; return operation;
  }
  cancel(input: { revision: number }): Promise<DesktopRuntimeSetupStatus> {
    this.assertRevision(input.revision);
    if (this.closing || !this.operation || !this.controller || this.committing) {
      throw new DesktopSetupError(409, 'SETUP_RUNTIME_NOT_CANCELABLE', '현재 실행 환경 작업은 취소할 수 없습니다. 최신 상태를 다시 확인할 수 있습니다.');
    }
    if (this.state.phase !== 'canceling') this.set({ phase: 'canceling', progress: null, error: null });
    this.controller.abort(); return this.operation;
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true; this.set({ phase: 'closing', progress: null });
      this.controller?.abort();
      await this.operation;
    })();
  }
}
