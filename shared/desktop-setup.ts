export type DesktopSetupPhase = 'unavailable' | 'unchecked' | 'checking' | 'disconnected'
  | 'starting' | 'awaiting' | 'connected' | 'canceling' | 'disconnecting' | 'failed' | 'closing';

export interface DesktopSetupStatus {
  revision: number;
  phase: DesktopSetupPhase;
  provider: { id: 'codex'; version: string | null; available: boolean };
  account: { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: string } | null;
  login: { attemptId: string; method: 'chatgptDeviceCode'; verificationUrl: string; userCode: string } | null;
  error: { code: string; message: string } | null;
  /** Connected account plus currently available configured runtime; not proof of a model call. */
  executionReady: boolean;
}

export type DesktopSetupLoginInput = { revision: number; method: 'chatgptDeviceCode' }
  | { revision: number; method: 'apiKey'; apiKey: string };
