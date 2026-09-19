export interface DesktopRuntimeSelection {
  kind: 'wsl-docker';
  wslExecutable: string;
  distro: string;
  model: string;
}
export interface DesktopRuntimeSetupStatus {
  revision: number;
  phase: 'unavailable' | 'unconfigured' | 'installing' | 'checking' | 'diagnosing' | 'recovering' | 'canceling' | 'saving' | 'restartRequired' | 'configured' | 'recoveryRequired' | 'closing';
  available: boolean;
  imageInstallAvailable: boolean;
  recoveryAvailable: boolean;
  recovery: DesktopRuntimeRecoveryInfo | null;
  progress: DesktopRuntimeInstallProgress | null;
  selection: DesktopRuntimeSelection | null;
  error: { code: string; message: string } | null;
}
export interface DesktopRuntimeSetupInput { revision: number; selection: DesktopRuntimeSelection }
export interface DesktopRuntimeInstallProgress { stage: 'verifying' | 'checking' | 'loading' | 'downloading'; completed: number; total: number }
/** Metadata diagnosis only; file/archive verification happens during explicit recovery. */
export interface DesktopRuntimeRecoveryInfo {
  fingerprint: string;
  selection: DesktopRuntimeSelection;
  images: Array<{ kind: 'worker' | 'browser'; status: 'present' | 'missing' }>;
}
