/**
 * Switching a session's model without going through message text: session-to-
 * session delivery wraps what it sends (sender header and similar), so a
 * `/model X` sent by another session never matched the command and reached
 * the model as prose. The MCP tools call the switch directly by session name.
 */
export const SESSION_MODEL_CONTROL_ERROR = {
  SESSION_NOT_FOUND: 'session_not_found',
  UNSUPPORTED_RUNTIME: 'unsupported_runtime',
  UNKNOWN_MODEL: 'unknown_model',
  UNKNOWN_THINKING_LEVEL: 'unknown_thinking_level',
  THINKING_UNSUPPORTED: 'thinking_unsupported',
  PROOF_GATED: 'model_switch_proof_gated',
  UNSUPPORTED_AGENT: 'model_switch_unsupported',
} as const;
export const SESSION_MODEL_APPLIED = {
  LIVE: 'live',
  NEXT_START: 'next_start',
} as const;

export type SessionModelControlError =
  typeof SESSION_MODEL_CONTROL_ERROR[keyof typeof SESSION_MODEL_CONTROL_ERROR];

export type SessionThinkingSwitchResult =
  | { ok: true; sessionName: string; agentType: string; thinking: string; previousThinking?: string; applied: typeof SESSION_MODEL_APPLIED[keyof typeof SESSION_MODEL_APPLIED] }
  | { ok: false; sessionName: string; code: SessionModelControlError; error: string; availableThinkingLevels?: string[] };

export type SessionModelSwitchResult =
  | {
      ok: true;
      sessionName: string;
      agentType: string;
      model: string;
      previousModel?: string;
      thinking?: string;
      previousThinking?: string;
      thinkingApplied?: typeof SESSION_MODEL_APPLIED[keyof typeof SESSION_MODEL_APPLIED];
      /** `live`: the running runtime switched now. `next_start`: the session is
       *  idle and not loaded; it starts on this model the next time it runs. */
      applied: typeof SESSION_MODEL_APPLIED[keyof typeof SESSION_MODEL_APPLIED];
    }
  | { ok: false; sessionName: string; code: SessionModelControlError; error: string; availableModels?: string[]; availableThinkingLevels?: string[] };

export type SessionModelListResult =
  | {
      ok: true;
      sessionName: string;
      agentType: string;
      currentModel?: string;
      currentThinking?: string;
      /** Models the switch accepts for this session; empty when unknown. */
      models: string[];
      thinkingLevels: string[];
      /** True when the provider takes any model id (no list to validate against). */
      acceptsAnyModel: boolean;
      /** Why the list may be empty or partial (provider probe error, not signed in...). */
      note?: string;
    }
  | { ok: false; sessionName: string; code: SessionModelControlError; error: string };
