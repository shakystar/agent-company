/** Browser uploads are bounded per file; directories are transferred file by file. */
export const MAX_IMPORTED_FILE_BYTES = 16 * 1024 * 1024;
export interface FileScope { type: 'agent' | 'team' | 'project'; id: string }
export interface FileImportInput { scope: FileScope; path: string; mediaType: string; base64: string }
export interface FileRecord {
  id: string; scope: FileScope; path: string; mediaType: string; bytes: number;
  sha256: string; createdAt: string;
}
export interface FileImportResult { file: FileRecord; workspaceRunId?: string }
export interface FileList { files: FileRecord[] }

export interface StorageLimits { dataBytes: number; backupBytes: number; tempBytes: number; minFreeBytes: number }
export interface StorageUsage { dataBytes: number; backupBytes: number; tempBytes: number; freeBytes: number }
export interface BackupRecord {
  id: string; createdAt: string; bytes: number; pinned: boolean; kind: 'automatic' | 'manual'; verified: true;
}
export interface RestoreRecord { id: string; backupId: string; createdAt: string }
export interface StorageStatus {
  enabled: boolean; limits: StorageLimits; usage: StorageUsage; backupDir: string; busy: boolean;
  paused: boolean; reason: string | null; backups: BackupRecord[]; restores: RestoreRecord[]; lastBackupAt: string | null;
}

const reservedRoots = new Set(['.agent', '.agents', '.agent-runtime', '.codex', 'agents.md', '.agent-workspace.json', '.agent-workspace.pending']);
/** Portable, relative file names only; never an arbitrary host path. */
export function validFilePath(path: string): boolean {
  if (!path || path.length > 1000 || /[\\:\u0000-\u001f\u007f<>"|?*]/.test(path)) return false;
  const parts = path.split('/');
  return !reservedRoots.has(parts[0].toLowerCase()) && parts.every(part =>
    part.length > 0 && part.length <= 255 && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export const filePathKey = (path: string) => path.normalize('NFC').toLowerCase();
