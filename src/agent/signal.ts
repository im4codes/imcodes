/**
 * Full CC hook suite setup.
 *
 * Writes hook scripts to ~/.imcodes/ and registers them in ~/.claude/settings.json.
 * All hooks POST directly to the daemon hook server (no file intermediary).
 *
 * Hook event types registered:
 *   Stop         → { event: "idle", session, agentType: "claude-code" }
 *   Notification → { event: "notification", session, title, message }
 *   PreToolUse   → { event: "tool_start", session, tool }
 *   PostToolUse  → { event: "tool_end", session }
 *
 * Hook format required by Claude Code:
 *   "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "..." }] }]
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { activeHookPort } from '../daemon/hook-server.js';

const IMCODES_DIR = path.join(os.homedir(), '.imcodes');
const CC_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// ── Signal file API ────────────────────────────────────────────────────────────

/** Directory where idle signal files are written by hooks and consumed by the daemon. */
export const SIGNAL_DIR = path.join(IMCODES_DIR, 'signals');

interface IdleSignal {
  session: string;
  timestamp: number;
  agentType?: string;
}

/** Write an idle signal file for a session (atomic rename). */
export async function writeIdleSignal(signal: IdleSignal): Promise<void> {
  await fs.mkdir(SIGNAL_DIR, { recursive: true });
  const tmp = path.join(SIGNAL_DIR, `${signal.session}.tmp`);
  const dest = path.join(SIGNAL_DIR, `${signal.session}.signal`);
  await fs.writeFile(tmp, JSON.stringify(signal));
  await fs.rename(tmp, dest);
}

/** Read and consume an idle signal for a session. Returns null if none exists. */
export async function checkIdleSignal(session: string): Promise<IdleSignal | null> {
  const filePath = path.join(SIGNAL_DIR, `${session}.signal`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    await fs.unlink(filePath).catch(() => {});
    return JSON.parse(raw) as IdleSignal;
  } catch {
    return null;
  }
}

// Common preamble for all hook scripts: get deck_ session name or exit.
// Layer 1 (fast): TMUX_PANE must be set (proves we're inside tmux) and we
// query the session that OWNS this pane (-t "$TMUX_PANE") instead of the
// most-recently-attached client. Without -t, a CC started in a non-deck
// terminal while the user is attached to a deck_ session would misroute.
// Layer 2 (precise): verified server-side in hook-server.ts (session must
// exist in store and be a claude-code agent).
const SESSION_PREAMBLE = `\
[ -z "$TMUX_PANE" ] && exit 0
SESSION_NAME=$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || echo "")
[ -z "$SESSION_NAME" ] && exit 0
case "$SESSION_NAME" in
  deck_*) ;;
  *) exit 0 ;;
esac`;

const CURL_BASE = (port: number) =>
  `curl -s -X POST "http://127.0.0.1:${port}/notify" \\\n  -H "Content-Type: application/json"`;

/** Maps CC hook event name → script file name */
const HOOK_SCRIPTS: Record<string, string> = {
  Stop: 'cc_hook_stop.sh',
  Notification: 'cc_hook_notify.sh',
  PreToolUse: 'cc_hook_pretool.sh',
  PostToolUse: 'cc_hook_posttool.sh',
};

function buildStopScript(port: number): string {
  return `#!/bin/bash
# IM.codes CC Stop Hook — notifies daemon when Claude Code session goes idle

INPUT=$(cat)

# Avoid infinite loop when CC continues due to a stop hook
STOP_HOOK_ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stop_hook_active','false'))" 2>/dev/null || echo "false")
[ "$STOP_HOOK_ACTIVE" = "true" ] && exit 0

${SESSION_PREAMBLE}

${CURL_BASE(port)} \\
  -d "{\\"event\\":\\"idle\\",\\"session\\":\\"$SESSION_NAME\\",\\"agentType\\":\\"claude-code\\"}" \\
  --max-time 2 &>/dev/null || true
`;
}

function buildNotifyScript(port: number): string {
  return `#!/bin/bash
# IM.codes CC Notification Hook — forwards CC notifications to daemon

INPUT=$(cat)

${SESSION_PREAMBLE}

TITLE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title',''))" 2>/dev/null || echo "")
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null || echo "")

# Skip empty notifications
[ -z "$TITLE" ] && [ -z "$MESSAGE" ] && exit 0

PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'event':'notification','session':'$SESSION_NAME','title':'$TITLE','message':'$MESSAGE'}))" 2>/dev/null || echo "")
[ -z "$PAYLOAD" ] && exit 0

${CURL_BASE(port)} \\
  -d "$PAYLOAD" \\
  --max-time 2 &>/dev/null || true
`;
}

function buildPreToolScript(port: number): string {
  return `#!/bin/bash
# IM.codes CC PreToolUse Hook — reports active tool with input to daemon

INPUT=$(cat)

${SESSION_PREAMBLE}

PAYLOAD=$(echo "$INPUT" | SESSION_NAME="$SESSION_NAME" python3 -c "
import sys, json, os
data = json.load(sys.stdin)
tool = data.get('tool_name', 'unknown')
tool_input = data.get('tool_input', {})
session = os.environ.get('SESSION_NAME', '')
print(json.dumps({'event':'tool_start','session':session,'tool':tool,'tool_input':tool_input}))
" 2>/dev/null)

[ -z "$PAYLOAD" ] && PAYLOAD="{\\"event\\":\\"tool_start\\",\\"session\\":\\"$SESSION_NAME\\",\\"tool\\":\\"unknown\\"}"

${CURL_BASE(port)} \\
  -d "$PAYLOAD" \\
  --max-time 2 &>/dev/null || true
`;
}

function buildPostToolScript(port: number): string {
  return `#!/bin/bash
# IM.codes CC PostToolUse Hook — reports tool completion to daemon

INPUT=$(cat)

${SESSION_PREAMBLE}

${CURL_BASE(port)} \\
  -d "{\\"event\\":\\"tool_end\\",\\"session\\":\\"$SESSION_NAME\\"}" \\
  --max-time 2 &>/dev/null || true
`;
}

/** Write all hook scripts to ~/.imcodes/ and register them in ~/.claude/settings.json. */
export async function setupCCHooks(): Promise<void> {
  await fs.mkdir(IMCODES_DIR, { recursive: true });
  const port = activeHookPort;

  // ── 1. Write hook scripts ───────────────────────────────────────────────────
  const scripts: Array<{ name: string; content: string }> = [
    { name: HOOK_SCRIPTS['Stop']!, content: buildStopScript(port) },
    { name: HOOK_SCRIPTS['Notification']!, content: buildNotifyScript(port) },
    { name: HOOK_SCRIPTS['PreToolUse']!, content: buildPreToolScript(port) },
    { name: HOOK_SCRIPTS['PostToolUse']!, content: buildPostToolScript(port) },
  ];

  for (const { name, content } of scripts) {
    const scriptPath = path.join(IMCODES_DIR, name);
    await fs.writeFile(scriptPath, content);
    await fs.chmod(scriptPath, 0o755);
  }

  // ── 2. Update ~/.claude/settings.json ──────────────────────────────────────
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CC_SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // file may not exist yet — start fresh
  }

  const hooks = (settings['hooks'] as Record<string, unknown[]> | undefined) ?? {};

  type HookEntry = { matcher?: string; hooks?: Array<{ type: string; command: string }> };

  for (const [eventName, scriptName] of Object.entries(HOOK_SCRIPTS)) {
    const scriptPath = path.join(IMCODES_DIR, scriptName);
    const entries = ((hooks[eventName] as unknown[]) ?? []) as HookEntry[];

    // Remove any legacy flat entries pointing to any imcodes script (wrong format)
    const cleaned = entries.filter((entry) => {
      const flat = entry as unknown as { type?: string; command?: string };
      return !(flat.type === 'command' && typeof flat.command === 'string' && flat.command.includes('imcodes'));
    });

    // Remove outdated correct-format entries for imcodes scripts (port may have changed)
    const withoutOld = cleaned.filter((entry) =>
      !(Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => h.command.includes('imcodes'))),
    );

    // Register in correct format
    withoutOld.push({
      matcher: '',
      hooks: [{ type: 'command', command: scriptPath }],
    });

    hooks[eventName] = withoutOld;
  }

  settings['hooks'] = hooks;

  // Validate before writing
  const json = JSON.stringify(settings, null, 2);
  JSON.parse(json); // throws if invalid

  await fs.mkdir(path.dirname(CC_SETTINGS_PATH), { recursive: true });
  await fs.writeFile(CC_SETTINGS_PATH, json);
}

/** @deprecated Use setupCCHooks() instead */
export const setupCCStopHook = setupCCHooks;
