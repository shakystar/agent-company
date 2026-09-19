/** Initialization did not return an owner, but its resources could not be
 * confirmed closed. Keep controller leases until process termination. */
export class ServiceStartupCleanupError extends AggregateError {
  readonly code = 'SERVICE_STARTUP_CLEANUP_PENDING';
  constructor(startupError: unknown, cleanupError: unknown) {
    super([startupError, cleanupError], '제어 서버 초기화 실패 후 데이터베이스 종료를 확인하지 못했습니다.', { cause: startupError });
    this.name = 'ServiceStartupCleanupError';
  }
}
