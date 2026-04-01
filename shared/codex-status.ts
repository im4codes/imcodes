export const CODEX_STATUS_MSG = {
  REQUEST: 'codex.status_request',
} as const;

export interface CodexStatusSnapshot {
  capturedAt: number;
  contextLeftPercent?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  fiveHourLeftPercent?: number;
  fiveHourResetAt?: string;
  weeklyLeftPercent?: number;
  weeklyResetAt?: string;
}
