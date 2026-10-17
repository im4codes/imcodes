/** Read-only compatibility boundary for AGY's SQLite/protobuf conversation format.
 * Unknown formats fail closed; this is not an authoritative quota API. */
export const AGY_NATIVE_STEP = { USER_INPUT: 14, AGENT_RESPONSE: 15, SYSTEM_ERROR: 17 } as const;
export const AGY_NATIVE_DONE = 3;
export const AGY_NATIVE_ERROR = 5;
export const AGY_NATIVE_FIELD = {
  TYPE: 1, STATUS: 4, USER: 19, RESPONSE: 20,
  USER_TEXT: 2, RESPONSE_TEXT: 1, RESPONSE_TEXT_COPY: 8,
  CREATED_AT: 1, ENDED_AT: 8, SECONDS: 1, NANOS: 2,
} as const;
export const AGY_HISTORY_LIMIT = {
  ROWS: 2048, METADATA_BYTES: 4096, INPUT_CANDIDATES: 8, ROW_BYTES: 16 * 1024 * 1024, TOTAL_BYTES: 64 * 1024 * 1024, TIMEOUT_MS: 2500,
} as const;
export interface AgyHistoryRequest {
  home: string;
  conversationId: string;
  promptHash: string;
  sentAt: number;
  resultAt: number;
  error: string;
}
export interface AgyRecoveredResponse { userStepIndex: number; responseStepIndex: number; text: string }
