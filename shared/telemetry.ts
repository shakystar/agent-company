export type ModelPhase = 'task' | 'evaluate' | 'trial' | 'repair';
export interface ModelUsage {
  status: 'unknown' | 'partial' | 'reported';
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}
export interface CommandObservation {
  id: string;
  kind: 'command_execution';
  command: string;
  status: 'completed' | 'failed' | 'unknown';
  exitCode: number | null;
  outputExcerpt: string;
}
export interface ModelStartRequest { runId: string; phase: ModelPhase; kind: string; reason: string }
export type ModelStartContext = ModelStartRequest;
export interface ModelAttempt extends ModelStartRequest {
  id: string;
  model: string;
  status: 'started' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  usage: ModelUsage;
  observations: CommandObservation[];
  observationsTruncated: boolean;
  error: string | null;
}
export class BudgetPauseError extends Error {
  readonly code = 'MODEL_BUDGET_PAUSED';
  constructor(message = '모델 실행 예산이 부족하여 진행 상태를 보존하고 대기합니다.') { super(message); this.name = 'BudgetPauseError'; }
}
export function isBudgetPause(error: unknown): error is BudgetPauseError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'MODEL_BUDGET_PAUSED';
}
export const unknownUsage = (): ModelUsage => ({ status: 'unknown', inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null });
