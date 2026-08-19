/**
 * Codex service tiers, as the model catalog names them.
 *
 * Codex calls `priority` "Fast" in its own UI — 1.5x speed for increased plan
 * usage — and its TUI can toggle it per thread. The tier lives on the thread,
 * so a session that was switched to Fast anywhere (the Codex TUI, the ChatGPT
 * Codex app) stays on it every time IM.codes resumes that thread, with nothing
 * in this product able to say otherwise. Naming it here is what lets the daemon
 * report it and the viewer turn it back.
 */
export const CODEX_SERVICE_TIER = {
  /** Codex labels this "Fast": 1.5x speed, increased plan usage. */
  FAST: 'priority',
  /** The account's ordinary tier. */
  DEFAULT: 'default',
} as const;

export type CodexServiceTier = typeof CODEX_SERVICE_TIER[keyof typeof CODEX_SERVICE_TIER];

/** The command a viewer sends to leave Fast mode for the current session. */
export const CODEX_FAST_OFF_COMMAND = '/fast off' as const;
/** The matching opt-in, so the control is a switch rather than a one-way door. */
export const CODEX_FAST_ON_COMMAND = '/fast on' as const;

const FAST_COMMAND_PATTERN = /^\/fast\s+(on|off)$/i;

/**
 * Classifies a complete `/fast on|off` command. Bare `/fast` is deliberately not
 * matched: that is Codex's own toggle, and a viewer typing it means the Codex
 * command, not this one.
 */
export function classifyCodexFastCommand(text: string): CodexServiceTier | null {
  const match = FAST_COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  return match[1]!.toLowerCase() === 'on' ? CODEX_SERVICE_TIER.FAST : CODEX_SERVICE_TIER.DEFAULT;
}

/** Whether a reported tier is the one that spends plan usage faster. */
export function isCodexFastServiceTier(tier: string | null | undefined): boolean {
  return tier === CODEX_SERVICE_TIER.FAST;
}
