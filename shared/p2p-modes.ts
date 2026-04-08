/** P2P Quick Discussion mode configuration. */

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
  /** User-defined extra prompt appended to every participant's system prompt. */
  extraPrompt?: string;
  /** Per-hop timeout in minutes. Default: 5. */
  hopTimeoutMinutes?: number;
}


export interface P2pConfigSelection {
  config: P2pSavedConfig;
  rounds: number;
  modeOverride: string;
}

export function buildEffectiveP2pConfig(config: P2pSavedConfig, modeOverride: string): P2pSavedConfig {
  if (modeOverride === P2P_CONFIG_MODE) return config;
  const overriddenSessions: P2pSavedConfig['sessions'] = {};
  for (const [session, entry] of Object.entries(config.sessions)) {
    overriddenSessions[session] = entry.enabled && entry.mode !== 'skip'
      ? { ...entry, mode: modeOverride }
      : { ...entry };
  }
  return { ...config, sessions: overriddenSessions };
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
    rounds: getComboRoundCount(modeOverride) ?? rounds,
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
  { key: 'audit>plan',                     pipeline: ['audit', 'plan'] },
  { key: 'review>plan',                    pipeline: ['review', 'plan'] },
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

/** Get the mode config for a specific round in a pipeline. Falls back to last element if round exceeds pipeline length. */
export function getModeForRound(mode: string, round: number): P2pMode | undefined {
  const pipeline = parseModePipeline(mode);
  const idx = Math.min(round - 1, pipeline.length - 1);
  return getP2pMode(pipeline[idx]);
}

/** Get the recommended round count for a mode (pipeline length for combos, undefined for single modes). */
export function getComboRoundCount(mode: string): number | undefined {
  const pipeline = parseModePipeline(mode);
  return pipeline.length > 1 ? pipeline.length : undefined;
}
