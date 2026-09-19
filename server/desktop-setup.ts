import { randomUUID } from 'node:crypto';
import type { DesktopSetupLoginInput, DesktopSetupStatus } from '../shared/desktop-setup.ts';
import { openDesktopCodexAccount, type DesktopCodexAccountClient, type DesktopCodexAccountEvent,
  type DesktopCodexAccountOptions } from './desktop-codex-account.ts';

export class DesktopSetupError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export interface DesktopSetupOptions {
  provider: { executable: string; version: string } | null;
  providerInvalid?: boolean;
  credentialsRoot: string;
  workspaceKey: string;
  /** Retained throughout a pending login, so deployment readiness includes its cleanup. */
  admit: () => () => void;
  /** Synchronous runtime gate; changing credentials must never race model admission. */
  assertIdle: () => void;
  assertNoCredentialWriters?: () => Promise<void>;
  executionReady?: () => Promise<boolean>;
  openAccount?: (options: DesktopCodexAccountOptions) => Promise<DesktopCodexAccountClient>;
}
type Attempt = { id: string; providerId: string | null;
  early: Array<{ loginId: string | null; success: boolean }>; completed?: boolean };

/** Coordinates one owner's account setup. It does not activate model execution. */
export class DesktopSetup {
  private state: DesktopSetupStatus;
  private client?: DesktopCodexAccountClient;
  private generation = 0;
  private attempt?: Attempt;
  private operation?: Promise<DesktopSetupStatus>;
  private releaseAdmission?: () => void;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: DesktopSetupOptions) {
    this.state = { revision: 0, phase: options.provider ? 'unchecked' : 'unavailable',
      provider: { id: 'codex', version: options.provider?.version ?? null, available: !!options.provider },
      account: null, login: null, error: options.providerInvalid ? { code: 'SETUP_PROVIDER_INVALID',
        message: 'Codex 연결 구성요소를 확인하지 못했습니다. 앱을 복구한 뒤 다시 사용할 수 있습니다.' } : null, executionReady: false };
  }
  status(): DesktopSetupStatus { return structuredClone(this.state); }
  assertIdle(): void {
    if (this.closing || this.operation || this.client || this.releaseAdmission) {
      throw new DesktopSetupError(409, 'SETUP_BUSY', '진행 중인 계정 연결 처리가 있습니다.');
    }
  }
  async readStatus(): Promise<DesktopSetupStatus> {
    const current = this.status();
    if (current.phase !== 'connected' || !this.options.executionReady) return current;
    let ready = false;
    try { ready = await this.options.executionReady(); } catch { /* Runtime unavailability never exposes a path or upstream diagnostic. */ }
    // A logout/cancel while the runtime query was pending must not revive its prior account state.
    const latest = this.status();
    return { ...latest, executionReady: latest.revision === current.revision && latest.phase === 'connected' && ready };
  }
  private set(patch: Partial<DesktopSetupStatus>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1,
      ...(this.closing ? { phase: 'closing', login: null } : {}) };
  }
  private validate(revision: number, phases: DesktopSetupStatus['phase'][], entering = true) {
    if (this.closing) throw new DesktopSetupError(409, 'SETUP_CLOSING', '앱을 종료하고 있습니다.');
    if (!Number.isSafeInteger(revision) || revision !== this.state.revision) {
      throw new DesktopSetupError(409, 'SETUP_STALE', '연결 상태가 변경됐습니다. 최신 상태를 확인한 뒤 다시 처리할 수 있습니다.');
    }
    if (!this.options.provider) throw new DesktopSetupError(409, 'SETUP_UNAVAILABLE', '이 설치 묶음에는 Codex 연결 구성요소가 없습니다.');
    if (this.operation || !phases.includes(this.state.phase)) throw new DesktopSetupError(409, 'SETUP_BUSY', '진행 중인 연결 처리가 있습니다.');
    if (entering) this.options.assertIdle();
  }
  private admit() { this.releaseAdmission ??= this.options.admit(); }
  private release() { const release = this.releaseAdmission; this.releaseAdmission = undefined; release?.(); }
  private async discardClient() {
    const client = this.client;
    // Events from this child must not be mistaken for a later login attempt.
    this.generation++;
    if (client) {
      try { await client.close(); }
      finally { if (this.client === client) this.client = undefined; }
    }
  }
  private async connection() {
    if (this.client) return this.client;
    const generation = ++this.generation;
    const client = await (this.options.openAccount ?? openDesktopCodexAccount)({
      executable: this.options.provider!.executable, credentialsRoot: this.options.credentialsRoot,
      workspaceKey: this.options.workspaceKey, onEvent: event => this.event(generation, event),
      assertNoCredentialWriters: this.options.assertNoCredentialWriters,
    });
    this.client = client;
    void client.closed.then(() => this.childStopped(generation), () => this.childStopped(generation));
    return client;
  }
  private childStopped(generation: number) {
    if (generation !== this.generation || this.closing || this.operation) return;
    void this.run(async () => { throw new DesktopSetupError(502, 'SETUP_CONNECTION_LOST', '로그인 연결이 종료됐습니다. 다시 확인할 수 있습니다.'); });
  }
  private event(generation: number, event: DesktopCodexAccountEvent) {
    if (generation !== this.generation || this.closing) return;
    if (event.type !== 'loginCompleted' || !this.attempt) return;
    const attempt = this.attempt;
    if (attempt.providerId === null) {
      // Completion can arrive in the same stdout chunk before login/start's response.
      if (attempt.early.length < 4) attempt.early.push(event);
      return;
    }
    if (attempt.providerId !== event.loginId) return;
    attempt.completed ??= event.success;
    this.completeWhenIdle();
  }
  private completeWhenIdle() {
    const attempt = this.attempt;
    if (this.closing || this.operation || this.state.phase !== 'awaiting' || attempt?.completed === undefined) return;
    void this.run(async () => {
      this.set({ phase: 'checking', login: null });
      if (!attempt.completed) {
        await this.client!.logout();
        throw new DesktopSetupError(400, 'SETUP_LOGIN_FAILED', '로그인을 완료하지 못했습니다. 다시 연결할 수 있습니다.');
      }
      await this.confirmAccount(true);
    });
  }
  private async confirmAccount(required: boolean) {
    const result = await (await this.connection()).readAccount(false);
    if (required && !result.account) throw new DesktopSetupError(502, 'SETUP_LOGIN_UNCONFIRMED', '계정 연결 완료를 확인하지 못했습니다.');
    await this.discardClient();
    this.attempt = undefined;
    this.set({ phase: result.account ? 'connected' : 'disconnected', account: result.account ?? null, login: null, error: null });
  }
  private run(action: () => Promise<void>): Promise<DesktopSetupStatus> {
    const operation = Promise.resolve().then(action).catch(async error => {
      // The protocol layer redacts upstream data; this boundary also excludes arbitrary callback errors.
      const known = error instanceof DesktopSetupError;
      this.attempt = undefined;
      this.set({ phase: 'failed', account: null, login: null, error: {
        code: known ? error.code : 'SETUP_CONNECTION_FAILED',
        message: known ? error.message : '계정 연결을 처리하지 못했습니다. 연결 상태를 다시 확인할 수 있습니다.',
      } });
      try { await this.discardClient(); } catch { /* The child client settles only after actual exit/pipe close. */ }
    }).then(() => this.status()).finally(() => {
      if (this.operation === operation) this.operation = undefined;
      if (this.state.phase !== 'awaiting' && !this.client) this.release();
      this.completeWhenIdle();
    });
    this.operation = operation;
    return operation;
  }
  check(revision: number): Promise<DesktopSetupStatus> {
    this.validate(revision, ['unchecked', 'disconnected', 'connected', 'failed']); this.admit();
    this.set({ phase: 'checking', error: null });
    return this.run(() => this.confirmAccount(false));
  }
  login(input: DesktopSetupLoginInput): Promise<DesktopSetupStatus> {
    this.validate(input.revision, ['unchecked', 'disconnected', 'failed']); this.admit();
    this.set({ phase: 'starting', error: null, account: null, login: null });
    return this.run(async () => {
      const client = await this.connection();
      // An unchecked persisted account is verified, never silently replaced by a fresh login.
      const prior = await client.readAccount(false);
      if (prior.account) {
        await this.discardClient();
        this.set({ phase: 'connected', account: prior.account, error: null });
        return;
      }
      const attempt: Attempt = { id: randomUUID(), providerId: null, early: [] }; this.attempt = attempt;
      const result = await client.startLogin(input.method === 'apiKey' ? { type: 'apiKey', apiKey: input.apiKey } : { type: 'chatgptDeviceCode' });
      if (result.type === 'apiKey') { await this.confirmAccount(true); return; }
      if (result.type !== 'chatgptDeviceCode') throw new DesktopSetupError(502, 'SETUP_PROTOCOL_FAILED', '로그인 응답을 확인하지 못했습니다.');
      attempt.providerId = result.loginId;
      attempt.completed = attempt.early.find(item => item.loginId === result.loginId)?.success;
      attempt.early = [];
      this.set({ phase: 'awaiting', login: { attemptId: attempt.id, method: 'chatgptDeviceCode',
        verificationUrl: result.verificationUrl, userCode: result.userCode } });
    });
  }
  cancel(revision: number, attemptId: string): Promise<DesktopSetupStatus> {
    // Cancellation finishes the account operation already holding admission.
    this.validate(revision, ['awaiting'], false);
    if (this.attempt?.id !== attemptId || !this.attempt.providerId) {
      throw new DesktopSetupError(409, 'SETUP_STALE_LOGIN', '현재 로그인 요청과 일치하지 않습니다.');
    }
    const providerId = this.attempt.providerId;
    // Ignore completion races after the user has chosen to cancel this specific attempt.
    this.attempt = undefined; this.set({ phase: 'canceling', login: null, error: null });
    return this.run(async () => {
      await this.client!.cancelLogin(providerId);
      // Login may have committed just before cancellation; this attempt began with no account.
      await this.client!.logout();
      await this.confirmAccount(false);
      if (this.state.account) throw new DesktopSetupError(502, 'SETUP_CANCEL_UNCONFIRMED', '로그인 취소를 확인하지 못했습니다.');
    });
  }
  logout(revision: number): Promise<DesktopSetupStatus> {
    this.validate(revision, ['connected', 'disconnected', 'unchecked', 'failed']); this.admit();
    this.set({ phase: 'disconnecting', login: null, error: null });
    return this.run(async () => {
      await (await this.connection()).logout();
      await this.confirmAccount(false);
      if (this.state.account) throw new DesktopSetupError(502, 'SETUP_LOGOUT_UNCONFIRMED', '계정 연결 해제를 확인하지 못했습니다.');
    });
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true; this.set({ phase: 'closing', login: null });
      try { await this.operation; await this.discardClient(); }
      finally { this.attempt = undefined; this.release(); }
    })();
  }
}
