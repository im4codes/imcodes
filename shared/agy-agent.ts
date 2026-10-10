/** Canonical transport/provider identity for the Google Antigravity (`agy`) CLI stream-json transport. */
export const AGY_SDK_PROVIDER_ID = 'agy-sdk' as const;

/** Name of the `agy` executable resolved from PATH (override with `AGY_CLI_PATH` or `ProviderConfig.binaryPath`). */
export const AGY_CLI_BINARY = 'agy' as const;

/** Environment variable that overrides the `agy` executable location. */
export const AGY_CLI_PATH_ENV = 'AGY_CLI_PATH' as const;

/**
 * Wire-format constants of `agy --input-format stream-json --output-format stream-json`.
 * Verified against agy 1.x: one NDJSON object per line, discriminated by `event`.
 */
export const AGY_STREAM_EVENT = {
  /** Input: `{event:'user', message:{content: string | ContentBlock[]}}`. */
  USER: 'user',
  /** Output: first event of a process, carries `conversation_id`, `cwd`, tools and `permission_mode`. */
  INIT: 'init',
  /** Output: incremental step state (`text_delta`, tool info, usage). */
  STEP_UPDATE: 'step_update',
  /** Output: terminal event of one turn (`status`, `response`, `usage`). */
  RESULT: 'result',
} as const;

export const AGY_STEP_TYPE = {
  USER_INPUT: 'user_input',
  AGENT_RESPONSE: 'agent_response',
  TOOL: 'tool',
} as const;

export const AGY_STEP_STATE = {
  ACTIVE: 'ACTIVE',
  DONE: 'DONE',
} as const;

export const AGY_RESULT_STATUS = {
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
} as const;

/** `agy` CLI flags used by the transport. */
export const AGY_CLI_FLAG = {
  INPUT_FORMAT: '--input-format',
  OUTPUT_FORMAT: '--output-format',
  STREAM_JSON: 'stream-json',
  SKIP_PERMISSIONS: '--dangerously-skip-permissions',
  CONVERSATION: '--conversation',
  MODEL: '--model',
  EFFORT: '--effort',
  ADD_DIR: '--add-dir',
  /** `-p` swallows the next argv as its prompt; the `=` form keeps the prompt empty and stdin-driven. */
  PRINT_STDIN: '--print=',
} as const;

/** Canonical tier / group ids for `agy-sdk` quota accounting. */
export const PROVIDER_QUOTA_GROUP_ID = {
  GEMINI: 'gemini',
  CLAUDE_GPT: 'claude-gpt',
} as const;

/** Product display labels for `agy-sdk` quota groups (untranslated proper nouns). */
export const PROVIDER_QUOTA_GROUP_LABEL = {
  GEMINI: 'Gemini',
  CLAUDE_GPT: 'Claude/GPT',
} as const;
