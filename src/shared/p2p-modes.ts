/** P2P Quick Discussion mode configuration. */

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

/** Look up a mode by key. Returns undefined if not found. */
export function getP2pMode(key: string): P2pMode | undefined {
  return BUILT_IN_MODES.find((m) => m.key === key);
}
