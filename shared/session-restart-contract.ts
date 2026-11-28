export interface AppliedSessionRestartState {
  agentType: string;
  ccPreset: string | null;
  requestedModel: string | null;
  activeModel: string | null;
  modelDisplay: string | null;
  runtimeType: string | null;
  providerId: string | null;
  cwd: string | null;
  label: string | null;
  description: string | null;
  effort: string | null;
  transportConfig: Record<string, unknown> | null;
  runtimeEpoch: string | null;
}

export interface SessionRestartCommandAck {
  type: 'session.restart_response' | 'subsession.restart_response';
  requestId: string;
  ok: boolean;
  rejected?: boolean;
  error?: string;
  restartEpoch?: number;
  previousRuntimeEpoch?: string | null;
  applied?: AppliedSessionRestartState;
}

export type SessionRestartRelayResult =
  | { status: 'committed'; applied: AppliedSessionRestartState | null }
  | { status: 'superseded' }
  | { status: 'rejected'; error: string }
  | { status: 'pending'; requestId: string; restartEpoch: number }
  | { status: 'legacy_sent' };

export const DEFAULT_SESSION_RESTART_TIMEOUT_MS = 15_000;
