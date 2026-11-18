/** Canonical transport/provider identity for the Google Antigravity (`agy`) CLI stream-json transport. */
export const AGY_SDK_PROVIDER_ID = 'agy-sdk' as const;

export const AGY_ACP_COMMAND = 'acp' as const;
export const AGY_ACP_AGENT_NAME = 'Antigravity ACP Server' as const;

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
  SYSTEM_ERROR: 'system_error',
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

/** Native individual-quota diagnostic that can leak from AG conversation history. */
export const AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX = 'Individual quota reached.';

/** Native stream-interruption diagnostic written by `core.appendErrorStep` after partial output. */
export const AGY_STREAM_INTERRUPTED_ERROR = 'The stream was interrupted. Please continue the task you were working on.';

/** AG may copy these diagnostics from an earlier system_error into later results.
 * Classification alone is NEVER sufficient to discard an error: callers must
 * prove a complete, clean current turn in the same conversation. */
export function isAgyHistoricalErrorCandidate(error: string): boolean {
  return error === AGY_STREAM_INTERRUPTED_ERROR
    || error.startsWith(AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX)
    || /^API error \(attempt [1-9]\d*\): \S/u.test(error);
}

/** `agy` CLI flags used by the transport. */
export const AGY_CLI_FLAG = {
  INPUT_FORMAT: '--input-format',
  OUTPUT_FORMAT: '--output-format',
  STREAM_JSON: 'stream-json',
  SKIP_PERMISSIONS: '--dangerously-skip-permissions',
  CONVERSATION: '--conversation',
  MODEL: '--model',
  EFFORT: '--effort',
  SETTINGS: '--settings',
  ADD_DIR: '--add-dir',
  DISABLE_TELEMETRY: '--disable-telemetry',
  LOG_FILE: '--log-file',
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

/** Canonical static/fallback models for `agy-sdk` used when CLI probe is pending or unauthenticated. */
export const AGY_FALLBACK_MODEL_IDS = [
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-low',
  'gemini-4-carbon-high',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-4-argon-low',
  'gemini-4-neon-high',
  'gemini-4-neon-medium',
  'gemini-4-neon-low',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-high',
  'claude-opus-5-5-low',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-low',
  'gpt-oss-120b-medium',
] as const;

export const AGY_DEFAULT_MODEL_ID = 'gemini-4-hydrogen-high' as const;

/**
 * True when `model` is an Antigravity/AGY model (gemini-4-hydrogen-*, gemini-3.8-flash-*, gemini-4-argon-*, gemini-4-carbon-*,
 * or an explicit agy fallback/alias model id).
 */
export function isAgyModelId(model: string | null | undefined): boolean {
  const trimmed = model?.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed === 'agy' || trimmed === AGY_SDK_PROVIDER_ID) return true;
  if (/^gemini-(?:4-hydrogen|4-argon|4-carbon|4-neon|3\.8-flash)(?:-(?:high|medium|low))?$/i.test(trimmed)) return true;
  if (/^gemini-(?:4|3\.8)(?:$|[-_.])/i.test(trimmed)) return true;
  if (/^gemini-(?:flash|argon|hydrogen|carbon|neon)(?:$|[-_.])/i.test(trimmed)) return true;
  return false;
}

export const looksLikeAgyModelId = isAgyModelId;

/**
 * Normalizes stored, settings.json display-name, or bare-family AGY model strings into
 * canonical `agy` model IDs. Empty values and bare backend placeholders (`agy`, `agy-sdk`)
 * collapse to `undefined`; unknown/custom IDs (including test stub IDs like `model-a`)
 * pass through trimmed unchanged.
 */
export function normalizeAgyModelId(rawModel?: string | null): string | undefined {
  const trimmed = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'agy' || lower === AGY_SDK_PROVIDER_ID) return undefined;

  const gemini4Display = /^gemini\s+4\s+(hydrogen|carbon|argon|neon)(?:\s*\((low|medium|high)\))?$/i.exec(trimmed);
  if (gemini4Display) {
    return `gemini-4-${gemini4Display[1]!.toLowerCase()}-${(gemini4Display[2] ?? 'high').toLowerCase()}`;
  }

  const flashDisplay = /^gemini\s+3\.8\s+flash(?:\s*\((low|medium|high)\))?$/i.exec(trimmed);
  if (flashDisplay) {
    return `gemini-3.8-flash-${(flashDisplay[1] ?? 'high').toLowerCase()}`;
  }

  const claudeDisplay = /^claude\s+(opus|sonnet)\s+5\.5(?:\s*\((low|medium|high)\))?$/i.exec(trimmed);
  if (claudeDisplay) {
    return `claude-${claudeDisplay[1]!.toLowerCase()}-5-5-${(claudeDisplay[2] ?? 'high').toLowerCase()}`;
  }

  const gptOss = /^gpt[-\s]?oss[-\s]?120b(?:\s*\((low|medium|high)\)|-(low|medium|high))?$/i.exec(trimmed);
  if (gptOss) {
    return `gpt-oss-120b-${(gptOss[1] ?? gptOss[2] ?? 'medium').toLowerCase()}`;
  }

  const canonical = /^(gemini-4-(?:hydrogen|carbon|argon|neon)|gemini-3\.8-flash|claude-(?:opus|sonnet)-5-5)(?:-(low|medium|high))?$/i.exec(trimmed);
  if (canonical) {
    return `${canonical[1]!.toLowerCase()}-${(canonical[2] ?? 'high').toLowerCase()}`;
  }

  return trimmed;
}

/**
 * Resolves the effective AGY model id for runtime/CLI execution, falling back to
 * `AGY_DEFAULT_MODEL_ID` whenever no explicit model was selected or a bare backend
 * placeholder (`agy-sdk`) was passed.
 */
export function resolveEffectiveAgyModelId(rawModel?: string | null): string {
  return normalizeAgyModelId(rawModel) ?? AGY_DEFAULT_MODEL_ID;
}

/** Persisted evidence for AG's lazy native-conversation creation. Missing means
 * unknown, NOT unused. STARTED is monotone for one provider route. */
export const AGY_NATIVE_SESSION_STATE = {
  UNSTARTED: 'unstarted',
  STARTED: 'started',
} as const;
export type AgyNativeSessionState = typeof AGY_NATIVE_SESSION_STATE[keyof typeof AGY_NATIVE_SESSION_STATE];

/** Local adapter evidence: persistence failed before any native process/input. */
export const AGY_NATIVE_START_NOT_ATTEMPTED = 'agyNativeStartNotAttempted' as const;

/** An RPC rejection without a returned native id is not proof of non-creation. */
export const AGY_NATIVE_START_RECOVERY_HINT = 'Use Start over (session_restart reset=true) to explicitly create a new conversation. The previous native creation outcome is unknown; automatic fresh retry is disabled.';
