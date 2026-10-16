/** Provider-independent, caller-bound conversation history and summaries. */
export const SESSION_TEXT_HISTORY_DEFAULT_LIMIT = 20;
export const SESSION_TEXT_HISTORY_MAX_LIMIT = 200;
export const SESSION_TEXT_HISTORY_MAX_CHARS = 128_000;
export interface SessionTextMessage {
  eventId: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  truncated: boolean;
}

export const SESSION_HISTORY_KINDS = ['text', 'summary'] as const;
