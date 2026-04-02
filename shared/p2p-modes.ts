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
}

/** Round-aware prompt wrapper — prepended to the mode's base prompt. */
export function roundPrompt(round: number, totalRounds: number): string {
  if (totalRounds <= 1) return '';
  if (round === 1) {
    return `[Round ${round}/${totalRounds} — Initial Analysis]\nProvide your initial analysis based on the original request.\n\n`;
  }
  return `[Round ${round}/${totalRounds} — Deepening]\nReview ALL previous rounds\' findings above. Focus on what was MISSED, challenge conclusions you disagree with, and deepen areas that need more investigation. Do NOT repeat prior conclusions — only add new value.\n\n`;
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
  },
  {
    key: 'review',
    prompt: 'You are a code reviewer. Evaluate the provided context for code quality, maintainability, performance, and adherence to best practices. Suggest concrete improvements.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'findings-first',
    maxOutputChars: 12_000,
  },
  {
    key: 'brainstorm',
    prompt: 'You are a creative collaborator. Explore the provided context from multiple angles. Generate diverse ideas, alternative approaches, and unexpected connections. Think broadly.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'free-form',
    maxOutputChars: 12_000,
  },
  {
    key: 'discuss',
    prompt: 'You are a technical advisor. Analyze the provided context by weighing trade-offs, comparing alternatives, and identifying risks and benefits. Provide a balanced perspective.',
    callbackRequired: true,
    defaultTimeoutMs: 300_000,
    resultStyle: 'summary-first',
    maxOutputChars: 12_000,
  },
];

/** All valid P2P mode keys as a const tuple — use for Zod enum validation. */
export const P2P_MODE_KEYS = BUILT_IN_MODES.map((m) => m.key) as unknown as readonly [string, ...string[]];

/** Look up a mode by key. Returns undefined if not found. */
export function getP2pMode(key: string): P2pMode | undefined {
  return BUILT_IN_MODES.find((m) => m.key === key);
}
