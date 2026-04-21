/**
 * Port of cc_detect.py — multi-sample status detection for CC, Codex, OpenCode.
 *
 * Detection order: signal file (instant) → multi-sample polling (fallback).
 * Status: 'idle' | 'streaming' | 'thinking' | 'tool_running' | 'permission' | 'unknown'
 */

import {
  PROCESS_SESSION_AGENT_TYPES,
  TRANSPORT_SESSION_AGENT_TYPES,
  type SessionAgentType,
} from '../../shared/agent-types.js';

export type AgentStatus =
  | 'idle'
  | 'streaming'
  | 'thinking'
  | 'tool_running'
  | 'permission'
  | 'error'
  | 'unknown';

/** Process-backed agents — controlled via tmux sessions */
export type ProcessAgent = typeof PROCESS_SESSION_AGENT_TYPES[number];

/** Transport-backed agents — controlled via network protocols */
export type TransportAgent = typeof TRANSPORT_SESSION_AGENT_TYPES[number];

/** All agent types */
export type AgentType = SessionAgentType;

/** Set of all transport agent type strings */
export const TRANSPORT_AGENTS = new Set<TransportAgent>(TRANSPORT_SESSION_AGENT_TYPES);

/** Set of all process agent type strings */
export const PROCESS_AGENTS = new Set<ProcessAgent>(PROCESS_SESSION_AGENT_TYPES);

/** Check if an agent type is transport-backed */
export function isTransportAgent(agentType: string): agentType is TransportAgent {
  return TRANSPORT_AGENTS.has(agentType as TransportAgent);
}

/** Check if an agent type is process-backed */
export function isProcessAgent(agentType: string): agentType is ProcessAgent {
  return !isTransportAgent(agentType);
}

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
  /Type your message or @/m,           // Gemini CLI input prompt (newer versions)
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

/** Check if any of the last few non-empty lines starts with a braille spinner character (col 0).
 *  This is the definitive working signal for Gemini CLI — the spinner always appears at the leftmost position. */
function hasLeadingBrailleSpinner(lines: string[]): boolean {
  const tail = lines.slice(-8);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line || !line.trim()) continue;
    // Braille pattern dots: U+2800..U+28FF
    const firstChar = line.charAt(0);
    if (firstChar >= '\u2800' && firstChar <= '\u28FF') return true;
    // Only check last few non-empty lines
    break;
  }
  return false;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Detect agent status from a captured pane snapshot. */
export function detectStatus(
  lines: string[],
  agentType: AgentType,
  /** Optional: content of the line where the cursor is. For codex, cursor on "›" line = idle. */
  cursorLine?: string,
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
      // Cursor on ">" or "›" line = codex is at input prompt = idle
      if (cursorLine !== undefined && /^\s*[>›]/.test(cursorLine) && !codexHasSpinner)
        return 'idle';
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
      // Braille spinner at column 0 is the definitive working signal for Gemini CLI.
      // Check the last few non-empty lines for a leading braille character.
      const geminiLeadingSpinner = hasLeadingBrailleSpinner(lines);
      const geminiHasSpinner = geminiLeadingSpinner || hasSpinner(lines, GEMINI_SPINNER_CHARS);
      // Scan ALL lines for idle prompt — Gemini's ">" prompt can appear anywhere
      // on screen (not just the last line) after long output.
      if (matchesAny(text, GEMINI_IDLE_PATTERNS) && !geminiHasSpinner)
        return 'idle';
      if (matchesAny(tail, GEMINI_THINKING_PATTERNS)) return 'thinking';
      if (matchesAny(tail, GEMINI_TOOL_PATTERNS)) return 'tool_running';
      if (geminiLeadingSpinner) return 'streaming'; // high-confidence: spinner at col 0
      if (geminiHasSpinner) return 'streaming';
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

/**
 * Unified async idle detection: capturePane + getCursorLine + detectStatus.
 * Use this instead of calling detectStatus directly when accurate idle
 * detection is needed (especially for codex where cursor position matters).
 */
export async function detectStatusAsync(
  session: string,
  agentType: AgentType,
): Promise<AgentStatus> {
  const { capturePane, getCursorLine } = await import('./tmux.js');
  const lines = await capturePane(session);
  let cursorLine: string | undefined;
  try { cursorLine = await getCursorLine(session); } catch { /* ignore */ }
  return detectStatus(lines, agentType, cursorLine);
}

// ─── session-manager.ts tmux/driver audit (for SessionRuntime refactor) ───────
//
// ## 1. Direct tmux function call sites
//
// Line   1  import: newSession, killSession, sessionExists, isPaneAlive,
//            respawnPane, listSessions, sendKeys, sendKey, capturePane,
//            showBuffer, getPaneId, getPaneCwd, getPaneStartCommand,
//            cleanupOrphanFifos  — all from './tmux.js'
//
// initOnStartup() [L182]:
//   cleanupOrphanFifos()                          — startup FIFO cleanup
//
// stopProject() [L152]:
//   killSession(s.name)                           — teardown
//
// teardownProject() [L171]:
//   killSession(s.name)                           — teardown without store removal
//
// restoreFromStore() [L218]:
//   tmuxListSessions()                            — enumerate live tmux sessions
//   isPaneAlive(s.name)                           — remain-on-exit health check
//   getPaneCwd(name)                              — infer projectDir for orphan
//   getPaneId(name)                               — infer paneId for orphan
//   getPaneStartCommand(name) via helpers         — infer agent type / UUID
//
// respawnSession() [L442]:
//   respawnPane(record.name, cmd)                 — restart dead pane in-place
//
// launchSession() [L524]:
//   sessionExists(name)                           — guard: skip if already live
//   newSession(name, launchCmd, { cwd, env })     — create tmux session + process
//   getPaneId(name)                               — read paneId after create
//   capturePane(name)  via postLaunch closure     — TUI scrape during setup
//   sendKey(name, key) via postLaunch closure     — send keystrokes during setup
//
// getSessionOps() [L699]:
//   capturePane(name)  returned closure           — used by status poller
//   sendKeys(name, keys) returned closure         — used by response collector
//   showBuffer()       returned closure           — tmux scroll buffer read
//
// extractSessionUuidFromPane() [L187]:
//   getPaneStartCommand(sessionName)              — parse pane cmd for UUID
//
// ## 2. AgentDriver method call sites
//
// getDriver(type) [L124]:
//   Constructs ClaudeCodeDriver | CodexDriver | OpenCodeDriver |
//   ShellDriver | GeminiDriver; throws for transport agents.
//
// launchSession() [L524]:
//   driver.buildLaunchCommand(name, opts)         — build tmux new-session cmd
//   driver.buildResumeCommand(name, opts)         — build resume variant
//   driver.postLaunch?(capturePane, sendKey)      — auto-dismiss TUI prompts
//   (driver as OpenCodeDriver).ensurePermissions  — write .opencode/config.json
//
// respawnSession() [L442]:
//   driver.buildResumeCommand(record.name, opts)  — build respawn cmd
//   driver.buildLaunchCommand(record.name, opts)  — fallback if no resume
//
// ## 3. State assumptions that presuppose process-backed behavior
//
// a. paneId field: set after newSession/respawnPane [launchSession L626].
//    Meaningless for transport agents (no tmux pane).
//
// b. sessionExists() guard [launchSession L540]: checks tmux session existence.
//    Transport agents have no tmux session to check.
//
// c. ccSessionId / codexSessionId / geminiSessionId resolution blocks
//    [launchSession L545–605]: all agent-specific UUID paths assume process model.
//
// d. isPaneAlive() [restoreFromStore L285]: remain-on-exit pane health check.
//    No equivalent for transport agents.
//
// e. inferAgentTypeFromPane() [L203]: reads pane start command to guess type.
//    Only valid for tmux-spawned processes.
//
// f. extractSessionUuidFromPane() [L187]: parses --session-id / --resume from
//    pane cmd. Transport agents don't have pane commands.
//
// g. startStructuredWatcher() [L44]: chooses JSONL/rollout/gemini watcher by
//    agentType. All branches watch local disk files written by processes.
//    Transport agents deliver events over the network, not local JSONL.
//
// h. setupCCStopHook / setupCodexNotify / setupOpenCodePlugin [launchSession
//    L530–538]: process-level hook/plugin setup; N/A for transport agents.
//
// i. getSessionOps() [L699]: returns capturePane/sendKeys/showBuffer closures
//    bound to a tmux session name. Transport agents need a different ops shape.
//
// ## Summary: operations to abstract behind SessionRuntime
//
//   create / kill / exists / isAlive    tmux: newSession / killSession / sessionExists / isPaneAlive
//   respawn                             tmux: respawnPane
//   sendInput                           tmux: sendKeys / sendKey
//   captureOutput                       tmux: capturePane / showBuffer
//   getPaneId / getPaneCwd / getPaneStartCommand
//   startStructuredWatcher / stopStructuredWatcher
//   buildLaunchCommand / buildResumeCommand / postLaunch   (AgentDriver)
