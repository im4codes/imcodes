/** P2P Quick Discussion mode configuration. */
import type { P2pAdvancedPresetKey, P2pAdvancedRound, P2pContextReducerConfig } from './p2p-advanced.js';
import type { P2pWorkflowDraft, P2pWorkflowLaunchEnvelope } from './p2p-workflow-types.js';

/** The "config" meta-mode — each session uses its own saved default mode. */
export const P2P_CONFIG_MODE = 'config' as const;

/** Per-session P2P configuration — stored in user preferences. */
export interface P2pSessionEntry {
  enabled: boolean;
  mode: string; // 'audit' | 'review' | 'brainstorm' | 'discuss' | 'skip'
}

export type P2pSessionConfig = Record<string, P2pSessionEntry>;

export interface P2pSavedConfig {
  sessions: P2pSessionConfig;
  rounds: number;
  /** Monotonic client-side save timestamp used for reconciliation. */
  updatedAt?: number;
  /** User-defined extra prompt appended to every participant's system prompt. */
  extraPrompt?: string;
  /** Per-hop timeout in minutes. Default: 8. */
  hopTimeoutMinutes?: number;
  /** Built-in advanced workflow preset key. */
  advancedPresetKey?: P2pAdvancedPresetKey;
  /** Advanced round overrides / full custom workflow definition. */
  advancedRounds?: P2pAdvancedRound[];
  /** Whole-run timeout for advanced workflows in minutes. */
  advancedRunTimeoutMinutes?: number;
  /** Optional context compression/helper config for advanced workflows. */
  contextReducer?: P2pContextReducerConfig;
  /**
   * Versioned advanced workflow draft for smart P2P workflow v1+.
   * **Legacy single-draft slot.** Retained for backwards compatibility with
   * configs saved before the workflow-library refactor (R3 v2 PR-ι). New
   * code should prefer `workflowLibrary` + `activeWorkflowId`. On load,
   * `migrateLegacyWorkflowDraft` (in `shared/p2p-workflow-library.ts`) lifts
   * a present `workflowDraft` into the library when no library exists yet.
   */
  workflowDraft?: P2pWorkflowDraft;
  /** Optional saved launch envelope for scheduled/supervised advanced workflow launch. */
  workflowLaunchEnvelope?: P2pWorkflowLaunchEnvelope;
  /**
   * R3 v2 PR-ι — Multi-workflow library. Each entry is an independently
   * editable `P2pWorkflowDraft` with its own id + title. Users can name,
   * duplicate, and delete entries through the `P2pConfigPanel` advanced
   * tab. The currently active workflow (used by P2P launches) is selected
   * via `activeWorkflowId`. Library size is capped by
   * `P2P_WORKFLOW_LIBRARY_MAX_ENTRIES` to keep the saved-config payload
   * bounded.
   */
  workflowLibrary?: P2pWorkflowDraft[];
  /**
   * R3 v2 PR-ι — Identifier (matching `P2pWorkflowDraft.id`) of the
   * currently active workflow in `workflowLibrary`. When unset, the first
   * library entry (or the legacy `workflowDraft`) is treated as active.
   * Reading is centralised through `getActiveWorkflowFromConfig` so the
   * resolution rules cannot drift between UI and launch envelope code.
   */
  activeWorkflowId?: string;
  /**
   * R3 PR-α follow-up — UI-managed allowlist of executable absolute paths
   * (or `PATH`-relative basenames) that script nodes in this config's
   * advanced workflow are permitted to spawn. Maintained in
   * `P2pConfigPanel` → "Allowed executables" and round-tripped through
   * the launch envelope (`P2pWorkflowLaunchEnvelope.allowedExecutables`).
   *
   * Empty list means script bind rejects every executable with
   * `script_executable_denied`. Per-entry constraints (visible-ASCII,
   * ≤256 bytes, ≤64 entries) live in `validateP2pWorkflowLaunchEnvelope`.
   */
  allowedExecutables?: string[];
}


export interface P2pConfigSelection {
  config: P2pSavedConfig;
  rounds: number;
  modeOverride: string;
}

export interface P2pMemberEligibilityOptions {
  /** Main session that owns this Team config. It is the host, never a member. */
  scopeSession?: string | null;
  /** Optional persisted/UI role for callers that already have session metadata. */
  role?: string | null;
}

export function isP2pBrainSessionName(sessionName: string): boolean {
  return !sessionName.startsWith('deck_sub_') && /^deck_.+_brain$/.test(sessionName);
}

export function isP2pMemberEligibleSession(
  sessionName: string,
  options: P2pMemberEligibilityOptions = {},
): boolean {
  const trimmed = sessionName.trim();
  if (!trimmed) return false;
  if (options.scopeSession && trimmed === options.scopeSession) return false;
  if (options.role === 'brain') return false;
  if (isP2pBrainSessionName(trimmed)) return false;
  return true;
}

export function sanitizeP2pSessionConfig(
  config: P2pSessionConfig | undefined,
  options: P2pMemberEligibilityOptions = {},
): P2pSessionConfig {
  if (!config) return {};
  const sanitized: P2pSessionConfig = {};
  for (const [sessionName, entry] of Object.entries(config)) {
    if (!isP2pMemberEligibleSession(sessionName, options)) continue;
    sanitized[sessionName] = entry;
  }
  return sanitized;
}

export function sanitizeP2pSavedConfig(
  config: P2pSavedConfig,
  options: P2pMemberEligibilityOptions = {},
): P2pSavedConfig {
  return {
    ...config,
    sessions: sanitizeP2pSessionConfig(config.sessions, options),
  };
}

export function getEnabledP2pMemberNames(
  config: P2pSessionConfig | undefined,
  options: P2pMemberEligibilityOptions = {},
): string[] {
  return Object.entries(sanitizeP2pSessionConfig(config, options))
    .filter(([, entry]) => entry && entry.enabled === true && entry.mode !== 'skip')
    .map(([name]) => name);
}

export function isP2pSessionEntry(value: unknown): value is P2pSessionEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as { enabled?: unknown; mode?: unknown };
  return typeof record.enabled === 'boolean' && typeof record.mode === 'string';
}

export function isP2pSavedConfig(value: unknown): value is P2pSavedConfig {
  if (!value || typeof value !== 'object') return false;
  const record = value as {
    sessions?: unknown;
    rounds?: unknown;
    updatedAt?: unknown;
    extraPrompt?: unknown;
    hopTimeoutMinutes?: unknown;
    advancedPresetKey?: unknown;
    advancedRounds?: unknown;
    advancedRunTimeoutMinutes?: unknown;
    contextReducer?: unknown;
    workflowDraft?: unknown;
    workflowLaunchEnvelope?: unknown;
  };
  if (!record.sessions || typeof record.sessions !== 'object' || Array.isArray(record.sessions)) return false;
  if (typeof record.rounds !== 'number' || !Number.isFinite(record.rounds)) return false;
  if (record.updatedAt != null && (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt))) return false;
  if (record.extraPrompt != null && typeof record.extraPrompt !== 'string') return false;
  if (record.hopTimeoutMinutes != null && (typeof record.hopTimeoutMinutes !== 'number' || !Number.isFinite(record.hopTimeoutMinutes))) return false;
  if (record.advancedPresetKey != null && typeof record.advancedPresetKey !== 'string') return false;
  if (record.advancedRounds != null && !Array.isArray(record.advancedRounds)) return false;
  if (record.advancedRunTimeoutMinutes != null && (typeof record.advancedRunTimeoutMinutes !== 'number' || !Number.isFinite(record.advancedRunTimeoutMinutes))) return false;
  if (record.contextReducer != null && typeof record.contextReducer !== 'object') return false;
  if (record.workflowDraft != null && (typeof record.workflowDraft !== 'object' || Array.isArray(record.workflowDraft))) return false;
  if (record.workflowLaunchEnvelope != null && (typeof record.workflowLaunchEnvelope !== 'object' || Array.isArray(record.workflowLaunchEnvelope))) return false;
  // R3 v2 PR-ι — workflow library shape check. Per-entry validation
  // (schemaVersion, id, nodes/edges shape) is performed when each entry is
  // surfaced through `validateP2pWorkflowDraft` / launch envelope build.
  const libraryRaw = (record as { workflowLibrary?: unknown }).workflowLibrary;
  if (libraryRaw != null) {
    if (!Array.isArray(libraryRaw)) return false;
    if (libraryRaw.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) return false;
  }
  const activeIdRaw = (record as { activeWorkflowId?: unknown }).activeWorkflowId;
  if (activeIdRaw != null && typeof activeIdRaw !== 'string') return false;
  // R3 PR-α follow-up — UI-managed allowedExecutables. We perform only a
  // shape check here; per-entry validation lives in
  // `validateP2pWorkflowLaunchEnvelope` so the same rules apply on launch.
  const allowedRaw = (record as { allowedExecutables?: unknown }).allowedExecutables;
  if (allowedRaw != null) {
    if (!Array.isArray(allowedRaw)) return false;
    if (allowedRaw.some((entry) => typeof entry !== 'string')) return false;
  }
  return Object.values(record.sessions as Record<string, unknown>).every(isP2pSessionEntry);
}

export function buildEffectiveP2pConfig(config: P2pSavedConfig, modeOverride: string): P2pSavedConfig {
  const sanitizedConfig = sanitizeP2pSavedConfig(config);
  if (modeOverride === P2P_CONFIG_MODE) return sanitizedConfig;
  const overriddenSessions: P2pSavedConfig['sessions'] = {};
  for (const [session, entry] of Object.entries(sanitizedConfig.sessions)) {
    overriddenSessions[session] = entry.enabled && entry.mode !== 'skip'
      ? { ...entry, mode: modeOverride }
      : { ...entry };
  }
  return { ...sanitizedConfig, sessions: overriddenSessions };
}

export function buildP2pConfigSelection(
  config: P2pSavedConfig,
  modeOverride: string,
  rounds = config.rounds ?? 1,
): P2pConfigSelection {
  const effectiveMode = isComboMode(modeOverride)
    ? (parseModePipeline(modeOverride)[0] ?? modeOverride)
    : modeOverride;
  return {
    config: buildEffectiveP2pConfig(config, effectiveMode),
    rounds,
    modeOverride,
  };
}

/** Round-aware prompt wrapper — prepended to the mode's base prompt. */
export function roundPrompt(round: number, totalRounds: number, modeKey?: string): string {
  if (totalRounds <= 1) return '';
  const phaseLabel = modeKey ? ` — ${modeKey.charAt(0).toUpperCase() + modeKey.slice(1)} Phase` : '';
  if (round === 1) {
    return `[Round ${round}/${totalRounds}${phaseLabel} — Initial Analysis]\nProvide your initial analysis based on the original request.\n\n`;
  }
  return `[Round ${round}/${totalRounds}${phaseLabel} — Deepening]\nReview ALL previous rounds\' findings above. Focus on what was MISSED, challenge conclusions you disagree with, and deepen areas that need more investigation. Do NOT repeat prior conclusions — only add new value.\n\n`;
}

export interface P2pMode {
  /** Stable English key — used in tokens, protocol, DB. Never localized. */
  key: string;
  /** System prompt injected for this mode. */
  prompt: string;
  /** Whether the agent must produce a structured callback. */
  callbackRequired: boolean;
  /** Default timeout per hop in milliseconds. */
  defaultTimeoutMs: number;
  /** How to present results (e.g. 'findings-first', 'summary-first'). */
  resultStyle: 'findings-first' | 'summary-first' | 'free-form';
  /** Max chars to carry from one hop's output into the next hop's context. */
  maxOutputChars: number;
  /** Mode-specific instruction for the final summary. Replaces the generic "synthesize" instruction. */
  summaryPrompt: string;
}

/** Shared baseline prompt for all P2P participants. */
export const P2P_BASELINE_PROMPT =
  'You are a staff-level engineer participating in a multi-agent technical discussion. ' +
  'Prioritize correctness over speed or politeness. ' +
  'Base claims on evidence from the discussion file and referenced files only. ' +
  'If something is uncertain, say so explicitly instead of guessing. ' +
  'Challenge prior conclusions when they are weak, incomplete, or wrong. ' +
  'For each major conclusion, make the evidence, assumptions, risks, and confidence level clear. ' +
  'Do not invent code behavior, test results, or implementation details.';

export const BUILT_IN_MODES: P2pMode[] = [
  {
    key: 'audit',
    prompt: 'You are a code auditor. Review the provided context for security vulnerabilities, logic errors, and potential risks. Be thorough and cite specific code locations.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'findings-first',
    maxOutputChars: 12_000,
    summaryPrompt:
      'Write a complete **Audit Report** that consolidates all findings across rounds. Structure it as:\n' +
      '1. **Executive Summary** — one-paragraph overall risk assessment\n' +
      '2. **Critical Findings** — security vulnerabilities and logic errors, each with: description, affected code location, severity (Critical/High/Medium/Low), exploitation scenario, and recommended fix\n' +
      '3. **Additional Findings** — code quality issues, potential risks, and edge cases\n' +
      '4. **Positive Observations** — things done well that should be preserved\n' +
      '5. **Recommended Actions** — prioritized list of fixes with effort estimates\n' +
      'Be specific: cite file paths, line numbers, and concrete code snippets for every finding.',
  },
  {
    key: 'review',
    prompt: 'You are a code reviewer. Evaluate the provided context for code quality, maintainability, performance, and adherence to best practices. Suggest concrete improvements.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'findings-first',
    maxOutputChars: 12_000,
    summaryPrompt:
      'Write a complete **Code Review Report** that consolidates all feedback across rounds. Structure it as:\n' +
      '1. **Summary** — overall code quality assessment and readiness verdict (approve / request changes / needs major rework)\n' +
      '2. **Must Fix** — blocking issues that must be resolved: bugs, performance problems, security concerns, broken contracts\n' +
      '3. **Should Fix** — non-blocking but important: naming, structure, missing error handling, test gaps\n' +
      '4. **Consider** — optional improvements: refactoring opportunities, alternative approaches, documentation\n' +
      '5. **Strengths** — well-designed aspects worth highlighting\n' +
      'For each item: cite the specific file and code, explain the problem, and provide a concrete fix or code suggestion.',
  },
  {
    key: 'plan',
    prompt: 'You are a technical architect. Design an implementation plan for the provided context. Use the user request and the discussion evidence to produce a complete, detailed execution plan. Break down the work into clear steps, identify dependencies and risks, define concrete acceptance and validation criteria, and suggest the optimal execution order. Be specific about files, interfaces, data flow, and how the work will be verified.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'findings-first',
    maxOutputChars: 12_000,
    summaryPrompt:
      'Write a complete **Implementation Plan** that synthesizes the user request and all discussion evidence into an actionable blueprint. Structure it as:\n' +
      '1. **Goal and Scope** — what must be delivered, what is in scope, and what is explicitly out of scope\n' +
      '2. **Current Context** — the relevant existing behavior, constraints, and discussion conclusions that drive the plan\n' +
      '3. **Architecture Overview** — key components, data flow, interfaces, and state transitions involved\n' +
      '4. **Implementation Phases** — ordered list of phases, each with:\n' +
      '   - Specific tasks with file paths, function/type/interface changes, and sequencing\n' +
      '   - Dependencies and prerequisites\n' +
      '   - Edge cases, failure handling, and rollout notes when relevant\n' +
      '5. **Acceptance and Validation** — explicit acceptance criteria plus concrete verification steps and tests for each major behavior\n' +
      '6. **Risk Assessment** — identified risks with mitigation strategies\n' +
      '7. **Open Questions** — unresolved decisions that need stakeholder input\n' +
      'End with the exact heading "repair task checklist" and an ordered, executable checklist that the follow-up execution stage can complete item by item. Each checklist item must name the file/component area, intended change, dependencies, and validation evidence. ' +
      'Be precise: name files, functions, types, data structures, and test coverage. The final plan must be detailed enough for direct implementation and QA handoff.',
  },
  {
    key: 'brainstorm',
    prompt: 'You are a creative collaborator. Explore the provided context from multiple angles. Generate diverse ideas, alternative approaches, and unexpected connections. Think broadly.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'free-form',
    maxOutputChars: 12_000,
    summaryPrompt:
      'Write a complete **Ideas & Approaches Summary** that organizes all ideas generated across rounds. Structure it as:\n' +
      '1. **Top Recommendations** — the 3-5 strongest ideas, each with: description, key advantage, feasibility assessment, and rough effort estimate\n' +
      '2. **Alternative Approaches** — other viable options grouped by theme, with pros/cons for each\n' +
      '3. **Creative Angles** — unconventional ideas worth exploring further, even if not immediately actionable\n' +
      '4. **Discarded Ideas** — approaches considered and rejected, with reasons (so they aren\'t revisited)\n' +
      '5. **Suggested Next Steps** — concrete actions to evaluate or prototype the top recommendations',
  },
  {
    key: 'discuss',
    prompt: 'You are a technical advisor. Analyze the provided context by weighing trade-offs, comparing alternatives, and identifying risks and benefits. Provide a balanced perspective.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'summary-first',
    maxOutputChars: 12_000,
    summaryPrompt:
      'Write a complete **Discussion Conclusion** that synthesizes all perspectives across rounds. Structure it as:\n' +
      '1. **Consensus** — positions where all participants agreed, with supporting reasoning\n' +
      '2. **Key Trade-offs** — the main trade-offs evaluated, with analysis of each option\n' +
      '3. **Recommendation** — the recommended path forward with clear justification\n' +
      '4. **Dissenting Views** — important disagreements that remain, with the strongest argument for each side\n' +
      '5. **Decision Criteria** — what factors should drive the final decision if the recommendation is not accepted\n' +
      '6. **Action Items** — concrete next steps to move forward',
  },
];

/** All valid P2P mode keys as a const tuple — use for Zod enum validation. */
export const P2P_MODE_KEYS = BUILT_IN_MODES.map((m) => m.key) as unknown as readonly [string, ...string[]];

/** Look up a mode by key. Returns undefined if not found. */
export function getP2pMode(key: string): P2pMode | undefined {
  return BUILT_IN_MODES.find((m) => m.key === key);
}

// ── Combo mode pipeline ──────────────────────────────────────────────────

/** Separator used in combo mode strings, e.g. "brainstorm>discuss>plan". */
export const COMBO_SEPARATOR = '>' as const;

/** Preset combo pipelines — common multi-phase workflows. */
export interface P2pComboPreset {
  /** Stable key used in protocol/storage, e.g. "brainstorm>discuss>plan". */
  key: string;
  /** Ordered mode keys, one per round. */
  pipeline: string[];
}

export const COMBO_PRESETS: P2pComboPreset[] = [
  { key: 'brainstorm>discuss>plan',         pipeline: ['brainstorm', 'discuss', 'plan'] },
  { key: 'audit>review>plan',              pipeline: ['audit', 'review', 'plan'] },
];

/** Parse a mode string into a per-round pipeline. Single mode → single-element array. */
export function parseModePipeline(mode: string): string[] {
  if (mode.includes(COMBO_SEPARATOR)) {
    return mode.split(COMBO_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  }
  return [mode];
}

/** Check if a mode string is a combo pipeline. */
export function isComboMode(mode: string): boolean {
  return mode.includes(COMBO_SEPARATOR);
}

/** A user-selectable combo must contain at least two real P2P phases. The
 * `config` meta-mode is intentionally excluded because it delegates mode
 * choice per participant and therefore cannot define a deterministic flow. */
export function isValidP2pComboPipeline(mode: string): boolean {
  const pipeline = parseModePipeline(mode);
  return pipeline.length > 1
    && pipeline.every((entry) => entry !== P2P_CONFIG_MODE && getP2pMode(entry) !== undefined);
}

/** Get the mode config for a specific round in a pipeline. Falls back to last element if round exceeds pipeline length. */
export function getModeForRound(mode: string, round: number): P2pMode | undefined {
  const pipeline = parseModePipeline(mode);
  const idx = Math.min(round - 1, pipeline.length - 1);
  return getP2pMode(pipeline[idx]);
}

/** Get the mode key for a legacy execution step, wrapping combo pipelines for each user-selected cycle. */
export function getLegacyModeKeyForExecutionRound(mode: string, round: number): string {
  const pipeline = parseModePipeline(mode);
  if (pipeline.length === 0) return mode;
  const normalizedRound = Math.max(1, Math.floor(round || 1));
  return pipeline[(normalizedRound - 1) % pipeline.length] ?? mode;
}

/** Get the mode config for a legacy execution step, wrapping combo pipelines for each user-selected cycle. */
export function getLegacyModeForExecutionRound(mode: string, round: number): P2pMode | undefined {
  return getP2pMode(getLegacyModeKeyForExecutionRound(mode, round));
}

/** Convert user-selected full-flow cycles into legacy executor step count. */
export function getLegacyExecutionRoundCount(mode: string, cycles = 1): number {
  const pipelineLength = Math.max(1, parseModePipeline(mode).length);
  const normalizedCycles = Math.max(1, Math.floor(cycles || 1));
  return pipelineLength * normalizedCycles;
}

/** Get the recommended round count for a mode (pipeline length for combos, undefined for single modes). */
export function getComboRoundCount(mode: string): number | undefined {
  const pipeline = parseModePipeline(mode);
  return pipeline.length > 1 ? pipeline.length : undefined;
}
