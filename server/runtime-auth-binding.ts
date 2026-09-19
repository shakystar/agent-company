/** Private control-plane capability. Neither credentials nor host paths belong
 * in Run inputs, checkpoints, worker results or public workspace state. */
export interface RuntimeAuthBindingLease {
  readonly source: string;
  readonly ownerKey: string;
  readonly signal: AbortSignal;
  validate(): Promise<void>;
  release(): Promise<void>;
}
export interface RuntimeAuthBinding {
  readonly ownerKey: string;
  hasCredentials(): Promise<boolean>;
  acquire(signal: AbortSignal): Promise<RuntimeAuthBindingLease>;
  /** Under an account-home lease, before the account process is created. */
  assertNoWriters(): Promise<void>;
  /** Read-only drain check, including queued/active users and failed cleanup. */
  assertIdle(): Promise<void>;
  /** Retry only a previously failed release after worker cleanup. */
  retryCleanup(): Promise<void>;
}
