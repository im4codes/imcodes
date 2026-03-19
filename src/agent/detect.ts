/**
 * Port of cc_detect.py — multi-sample status detection for CC, Codex, OpenCode.
 *
 * Detection order: signal file (instant) → multi-sample polling (fallback).
 * Status: 'idle' | 'streaming' | 'thinking' | 'tool_running' | 'permission' | 'unknown'
 */

export type AgentStatus =
  | 'idle'
  | 'streaming'
  | 'thinking'
  | 'tool_running'
  | 'permission'
  | 'unknown';

export type AgentType = 'claude-code' | 'codex' | 'opencode' | 'shell' | 'script' | 'gemini';

// ─── Claude Code patterns ─────────────────────────────────────────────────────

const CC_IDLE_PATTERNS = [
  /❯\s*$/m,                            // ❯ prompt
  /✓\s*$/m,                            // completion check
];

const CC_SPINNER_CHARS = [
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', // braille
];

// CC uses various Unicode decorative chars as pulsing spinners (✻ ✽ ❋ etc.)
// Match any non-ASCII symbol followed by a capitalized -ing word on the same line
const CC_SPINNER_LINE = /[^\x00-\x7F]\s+[A-Z][a-z]+ing/;

// Any capitalized word ending in -ing = Claude Code spinner status (Thinking, Discombobulating, etc.)
const CC_THINKING_PATTERNS = [
  /\b[A-Z][a-z]+ing\b/,
];

const CC_TOOL_PATTERNS = [
  /\bRunning\b/i,
  /\bExecuting\b/i,
  /ToolUse/,
  /Bash\(|Read\(|Write\(|Edit\(/,
];

const CC_PERMISSION_PATTERNS = [
  /Allow|Deny/,
  /\[Y\/n\]/i,
  /Do you want to/i,
];

// ─── Codex patterns ────────────────────────────────────────────────────────────

const CODEX_IDLE_PATTERNS = [
  /^\s*>\s*$/m,                        // line that is ONLY ">" — Codex prompt
  /^\s*›\s*$/m,                        // line that is ONLY "›" — alternate prompt
];

const CODEX_SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

const CODEX_THINKING_PATTERNS = [
  /\bthinking\b/i,
  /\breasoning\b/i,
  /\bworking\b/i,
  /\b[A-Z][a-z]+ing\b/,  // same generic pattern as CC
];

const CODEX_TOOL_PATTERNS = [
  /shell\(/i,
  /file\(/i,
];

// ─── OpenCode patterns ─────────────────────────────────────────────────────────

const OC_IDLE_PATTERNS = [
  /λ\s*$/m,                            // λ prompt
  />\s*$/m,                            // > prompt (fallback)
];

const OC_SPINNER_CHARS = ['|', '/', '-', '\\'];

const OC_THINKING_PATTERNS = [
  /\bthinking\b/i,
];

const OC_TOOL_PATTERNS = [
  /\brun\b/i,
  /\btool\b/i,
];

// ─── Gemini CLI patterns ───────────────────────────────────────────────────────

const GEMINI_IDLE_PATTERNS = [
  /^\s*>\s*$/m,                        // line that is ONLY ">" — the REPL prompt
  /^\s*❯\s*$/m,                        // line that is ONLY "❯" — alternate prompt
];

const GEMINI_SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const GEMINI_THINKING_PATTERNS = [
  /\bThinking\b/i,
  /\bGenerating\b/i,
  /esc to cancel/i,            // "(esc to cancel, 2m 44s)" — clear working indicator
];

const GEMINI_TOOL_PATTERNS = [
  /\bRunning\b/i,
  /\bExecuting\b/i,
  /tool_use/i,
  // Gemini CLI displays tool calls as ">tool_name args ✓/✗" or "··· N more"
  /^\s*>\s*\w+.*[✓✗]/m,
  /···\s*\d+\s*more/,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasSpinner(lines: string[], spinners: string[]): boolean {
  // Match spinner chars only when they appear at line boundaries or surrounded by spaces
  // to avoid false positives from hyphens in words like "my-project"
  const lastFew = lines.slice(-5).join('\n');
  return spinners.some((s) => {
    // For single ASCII chars that could appear in words, require word boundary context
    if (s.length === 1 && /[-/\\|]/.test(s)) {
      const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'm').test(lastFew);
    }
    return lastFew.includes(s);
  });
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Detect agent status from a captured pane snapshot. */
export function detectStatus(
  lines: string[],
  agentType: AgentType
): AgentStatus {
  const text = lines.join('\n');
  const tail = lines.slice(-10).join('\n');

  switch (agentType) {
    case 'claude-code': {
      if (matchesAny(tail, CC_PERMISSION_PATTERNS)) return 'permission';
      const hasClassicSpinner = hasSpinner(lines, CC_SPINNER_CHARS);
      const hasStarSpinner = CC_SPINNER_LINE.test(tail);
      if (matchesAny(tail, CC_IDLE_PATTERNS) && !hasClassicSpinner && !hasStarSpinner)
        return 'idle';
      if (hasClassicSpinner || hasStarSpinner) {
        // Check tail for tool vs thinking — using full text would match stale output
        if (matchesAny(tail, CC_TOOL_PATTERNS)) return 'tool_running';
        if (matchesAny(tail, CC_THINKING_PATTERNS)) return 'thinking';
        return 'streaming';
      }
      if (matchesAny(tail, CC_TOOL_PATTERNS)) return 'tool_running';
      break;
    }

    case 'codex': {
      const codexHasSpinner = hasSpinner(lines, CODEX_SPINNER_CHARS) || CC_SPINNER_LINE.test(tail);
      if (matchesAny(tail, CODEX_IDLE_PATTERNS) && !codexHasSpinner)
        return 'idle';
      if (codexHasSpinner) {
        if (matchesAny(tail, CODEX_TOOL_PATTERNS)) return 'tool_running';
        if (matchesAny(tail, CODEX_THINKING_PATTERNS)) return 'thinking';
        return 'streaming';
      }
      if (matchesAny(tail, CODEX_TOOL_PATTERNS)) return 'tool_running';
      // No idle prompt visible and no spinner caught → assume working
      // (Codex working text flickers too fast for polling to reliably capture)
      if (!matchesAny(tail, CODEX_IDLE_PATTERNS)) return 'thinking';
      return 'thinking';
    }

    case 'opencode':
      if (matchesAny(tail, OC_IDLE_PATTERNS) && !hasSpinner(lines, OC_SPINNER_CHARS))
        return 'idle';
      if (matchesAny(text, OC_TOOL_PATTERNS)) return 'tool_running';
      if (hasSpinner(lines, OC_SPINNER_CHARS)) {
        if (matchesAny(text, OC_THINKING_PATTERNS)) return 'thinking';
        return 'streaming';
      }
      break;

    case 'gemini': {
      const geminiHasSpinner = hasSpinner(lines, GEMINI_SPINNER_CHARS);
      if (matchesAny(tail, GEMINI_IDLE_PATTERNS) && !geminiHasSpinner)
        return 'idle';
      // Use tail (not full text) to avoid matching stale output from previous turns
      if (matchesAny(tail, GEMINI_THINKING_PATTERNS)) return 'thinking';
      if (matchesAny(tail, GEMINI_TOOL_PATTERNS)) return 'tool_running';
      if (geminiHasSpinner) return 'streaming';
      // No idle prompt visible and no spinner caught → assume working
      // (Gemini tool output flickers too fast for polling to reliably capture)
      if (!matchesAny(tail, GEMINI_IDLE_PATTERNS)) return 'thinking';
      break;
    }

    case 'shell':
      // Shell idle: last non-empty line ends with a common prompt char
      if (/[$%›>#]\s*$/.test(tail.trimEnd())) return 'idle';
      break;
  }

  // No active signals (no spinner, no tool output) → assume idle
  return 'idle';
}

export interface MultiSampleOptions {
  samples?: number;       // default 3
  intervalMs?: number;    // default 500ms between samples
}

/**
 * Multi-sample detection: poll N times and return the most common status.
 * Handles timing jitter — a single 'unknown' doesn't override a stable 'idle'.
 */
export async function detectStatusMulti(
  captureLines: () => Promise<string[]>,
  agentType: AgentType,
  opts?: MultiSampleOptions
): Promise<AgentStatus> {
  const samples = opts?.samples ?? 3;
  const intervalMs = opts?.intervalMs ?? 500;

  const results: AgentStatus[] = [];

  for (let i = 0; i < samples; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const lines = await captureLines();
    results.push(detectStatus(lines, agentType));
  }

  // Count frequencies
  const freq = new Map<AgentStatus, number>();
  for (const s of results) freq.set(s, (freq.get(s) ?? 0) + 1);

  // Most common wins; ties broken by priority: active states beat idle (conservative — don't declare idle unless certain)
  const priority: AgentStatus[] = [
    'permission', 'tool_running', 'thinking', 'streaming', 'idle', 'unknown',
  ];

  let best: AgentStatus = 'unknown';
  let bestCount = 0;

  for (const status of priority) {
    const count = freq.get(status) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = status;
    }
  }

  return best;
}
