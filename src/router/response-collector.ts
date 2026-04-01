/**
 * Detect agent idle → diff screen → clean output → send OutboundMessage to CF Worker.
 * CF Worker handler handles platform-specific message splitting and formatting.
 */
import { capturePane } from '../agent/tmux.js';
import { getAllBindings } from './message-router.js';
import logger from '../util/logger.js';

export type OutboundSender = (msg: OutboundPayload) => Promise<void>;

export interface OutboundPayload {
  platform: string;
  botId: string;
  channelId: string;
  content: string;
  replyToId?: string;
  formatting?: 'plain' | 'markdown' | 'code';
}

// ── Auto-fix session registry ─────────────────────────────────────────────────

export type AutoFixIdleHandler = (sessionName: string, output: string) => Promise<void>;

/** Sessions registered for auto-fix mode. Idle triggers the handler instead of channel dispatch. */
const autoFixSessions = new Map<string, AutoFixIdleHandler>();

/** Register a session as auto-fix mode — idle will call handler instead of sending to channels. */
export function registerAutoFixSession(sessionName: string, handler: AutoFixIdleHandler): void {
  autoFixSessions.set(sessionName, handler);
}

/** Unregister auto-fix mode for a session (call when pipeline completes/fails). */
export function unregisterAutoFixSession(sessionName: string): void {
  autoFixSessions.delete(sessionName);
}

// ── Screen diff tracking ──────────────────────────────────────────────────────

const lastScreens = new Map<string, string>();

/**
 * Capture the current screen of a session and return the diff since last capture.
 * Returns null if nothing has changed.
 */
export async function captureAndDiff(sessionName: string): Promise<string | null> {
  let current: string;
  try {
    current = (await capturePane(sessionName)).join('\n');
  } catch (err) {
    logger.debug({ sessionName, err }, 'capturePane failed');
    return null;
  }

  const previous = lastScreens.get(sessionName) ?? '';
  if (current === previous) return null;

  lastScreens.set(sessionName, current);
  return diffScreens(previous, current);
}

/**
 * On agent idle, capture output since last idle → clean → dispatch to all bound channels.
 */
export async function onAgentIdle(
  sessionName: string,
  projectName: string,
  sendOutbound: OutboundSender,
): Promise<void> {
  const diff = await captureAndDiff(sessionName);
  if (!diff || diff.trim().length === 0) {
    logger.debug({ sessionName }, 'No diff on idle — skipping outbound');
    return;
  }

  const cleaned = cleanOutput(diff);
  if (!cleaned) return;

  // Auto-fix mode: route to state machine instead of channel dispatch
  const autoFixHandler = autoFixSessions.get(sessionName);
  if (autoFixHandler) {
    try {
      await autoFixHandler(sessionName, cleaned);
    } catch (err) {
      logger.error({ sessionName, err }, 'Auto-fix idle handler failed');
    }
    return;
  }

  // Find all channels bound to this project
  const bindings = getAllBindings().filter((b) => b.projectName === projectName);
  if (bindings.length === 0) {
    logger.debug({ projectName }, 'No channel bindings for project — not sending response');
    return;
  }

  for (const binding of bindings) {
    try {
      await sendOutbound({
        platform: binding.platform,
        botId: binding.botId,
        channelId: binding.channelId,
        content: cleaned,
        formatting: detectFormatting(cleaned),
      });
    } catch (err) {
      logger.error({ platform: binding.platform, channelId: binding.channelId, err }, 'sendOutbound failed');
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute a textual diff between two screen snapshots.
 * Returns the new/changed lines in the current snapshot.
 */
function diffScreens(previous: string, current: string): string {
  const prevLines = previous.split('\n');
  const currLines = current.split('\n');

  // If current is shorter (screen was cleared/reset), return the full current
  if (currLines.length < prevLines.length) {
    return current;
  }

  // Find where the new content starts (first diverging line from the end)
  let diffStart = 0;
  for (let i = 0; i < prevLines.length && i < currLines.length; i++) {
    if (prevLines[i] !== currLines[i]) {
      diffStart = i;
      break;
    }
    diffStart = i + 1;
  }

  const newLines = currLines.slice(diffStart);
  return newLines.join('\n');
}

/**
 * Clean tmux pane output:
 * - Remove ANSI escape codes
 * - Remove trailing whitespace per line
 * - Collapse runs of blank lines to one
 * - Trim overall
 */
function cleanOutput(raw: string): string {
  // Strip ANSI escape sequences
  const stripped = raw.replace(/\x1b\[[0-9;]*[mGKHFJABCDEFhlr]/g, '');

  const lines = stripped
    .split('\n')
    .map((l) => l.trimEnd());

  // Collapse multiple blank lines
  const collapsed: string[] = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line === '') {
      blankCount++;
      if (blankCount <= 1) collapsed.push(line);
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }

  return collapsed.join('\n').trim();
}

/**
 * Detect whether output is code/markdown or plain text.
 * Simple heuristic: contains code fences → code; contains markdown headers → markdown.
 */
function detectFormatting(text: string): 'plain' | 'markdown' | 'code' {
  if (text.includes('```')) return 'code';
  if (/^#{1,3} /m.test(text)) return 'markdown';
  return 'plain';
}

/**
 * Clear the screen tracking for a session (e.g., on session restart).
 */
export function clearScreenState(sessionName: string): void {
  lastScreens.delete(sessionName);
}
