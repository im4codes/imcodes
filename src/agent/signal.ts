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
 *
 * Platform support:
 *   Unix:    generates .sh scripts (bash + curl)
 *   Windows: generates .mjs scripts (Node.js + fetch)
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { activeHookPort } from '../daemon/hook-server.js';

const IMCODES_DIR = path.join(os.homedir(), '.imcodes');
const CC_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const IS_WINDOWS = process.platform === 'win32';

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

// ── Unix (bash) hook scripts ──────────────────────────────────────────────────

// Common preamble for all hook scripts: get deck_ session name or exit.
// Cross-platform: prefer $IMCODES_SESSION (injected by session-manager at launch),
// fall back to tmux $TMUX_PANE for backward compatibility.
// Layer 2 (precise): verified server-side in hook-server.ts (session must
// exist in store and be a claude-code agent).
const SESSION_PREAMBLE = `\
if [ -n "$IMCODES_SESSION" ]; then
  SESSION_NAME="$IMCODES_SESSION"
elif [ -n "$TMUX_PANE" ]; then
  SESSION_NAME=$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || echo "")
else
  exit 0
fi
[ -z "$SESSION_NAME" ] && exit 0
case "$SESSION_NAME" in
  deck_*) ;;
  *) exit 0 ;;
esac`;

const CURL_BASE = (port: number) =>
  `curl -s -X POST "http://127.0.0.1:${port}/notify" \\\n  -H "Content-Type: application/json"`;

function buildStopScript(port: number): string {
  return `#!/bin/bash
# IM.codes CC Stop Hook — notifies daemon when Claude Code session goes idle

INPUT=$(cat)

# Avoid infinite loop when CC continues due to a stop hook
STOP_HOOK_ACTIVE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).stop_hook_active||'false')}catch{console.log('false')}})" 2>/dev/null || echo "false")
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

TITLE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).title||'')}catch{console.log('')}})" 2>/dev/null || echo "")
MESSAGE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).message||'')}catch{console.log('')}})" 2>/dev/null || echo "")

# Skip empty notifications
[ -z "$TITLE" ] && [ -z "$MESSAGE" ] && exit 0

PAYLOAD=$(node -e "console.log(JSON.stringify({event:'notification',session:'$SESSION_NAME',title:'$TITLE',message:'$MESSAGE'}))" 2>/dev/null || echo "")
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

PAYLOAD=$(echo "$INPUT" | SESSION_NAME="$SESSION_NAME" node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
try{const o=JSON.parse(d);const s=process.env.SESSION_NAME||'';
console.log(JSON.stringify({event:'tool_start',session:s,tool:o.tool_name||'unknown',tool_input:o.tool_input||{}}))}
catch{console.log(JSON.stringify({event:'tool_start',session:process.env.SESSION_NAME||'',tool:'unknown'}))}})
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

// ── Windows (Node.js) hook scripts ────────────────────────────────────────────

// Common session detection for Windows .mjs scripts.
// CC sets IMCODES_SESSION env var at launch. No tmux fallback needed on Windows.
const WIN_SESSION_PREAMBLE = `const SESSION_NAME = process.env.IMCODES_SESSION || '';
if (!SESSION_NAME || !SESSION_NAME.startsWith('deck_')) process.exit(0);`;

const WIN_STDIN_READ = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const INPUT = JSON.parse(Buffer.concat(chunks).toString() || '{}');`;

const WIN_POST = (port: number) =>
  `async function post(body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2000);
  try { await fetch('http://127.0.0.1:${port}/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: ac.signal,
  }); } catch {} finally { clearTimeout(t); }
}`;

function buildStopScriptWin(port: number): string {
  return `#!/usr/bin/env node
// IM.codes CC Stop Hook (Windows) — notifies daemon when Claude Code goes idle
${WIN_SESSION_PREAMBLE}
${WIN_POST(port)}
(async () => {
  ${WIN_STDIN_READ}
  if (INPUT.stop_hook_active) process.exit(0);
  await post({ event: 'idle', session: SESSION_NAME, agentType: 'claude-code' });
})();
`;
}

function buildNotifyScriptWin(port: number): string {
  return `#!/usr/bin/env node
// IM.codes CC Notification Hook (Windows) — forwards notifications to daemon
${WIN_SESSION_PREAMBLE}
${WIN_POST(port)}
(async () => {
  ${WIN_STDIN_READ}
  const title = INPUT.title || '';
  const message = INPUT.message || '';
  if (!title && !message) process.exit(0);
  await post({ event: 'notification', session: SESSION_NAME, title, message });
})();
`;
}

function buildPreToolScriptWin(port: number): string {
  return `#!/usr/bin/env node
// IM.codes CC PreToolUse Hook (Windows) — reports active tool to daemon
${WIN_SESSION_PREAMBLE}
${WIN_POST(port)}
(async () => {
  ${WIN_STDIN_READ}
  await post({ event: 'tool_start', session: SESSION_NAME, tool: INPUT.tool_name || 'unknown', tool_input: INPUT.tool_input || {} });
})();
`;
}

function buildPostToolScriptWin(port: number): string {
  return `#!/usr/bin/env node
// IM.codes CC PostToolUse Hook (Windows) — reports tool completion to daemon
${WIN_SESSION_PREAMBLE}
${WIN_POST(port)}
(async () => {
  ${WIN_STDIN_READ}
  await post({ event: 'tool_end', session: SESSION_NAME });
})();
`;
}

// ── Hook setup ────────────────────────────────────────────────────────────────

/** Maps CC hook event name → script file name (platform-dependent extension) */
function hookScripts(): Record<string, string> {
  const ext = IS_WINDOWS ? '.mjs' : '.sh';
  return {
    Stop: `cc_hook_stop${ext}`,
    Notification: `cc_hook_notify${ext}`,
    PreToolUse: `cc_hook_pretool${ext}`,
    PostToolUse: `cc_hook_posttool${ext}`,
  };
}

/** Build all hook scripts for the current platform. */
function buildScripts(port: number): Array<{ name: string; content: string }> {
  const names = hookScripts();
  if (IS_WINDOWS) {
    return [
      { name: names['Stop']!, content: buildStopScriptWin(port) },
      { name: names['Notification']!, content: buildNotifyScriptWin(port) },
      { name: names['PreToolUse']!, content: buildPreToolScriptWin(port) },
      { name: names['PostToolUse']!, content: buildPostToolScriptWin(port) },
    ];
  }
  return [
    { name: names['Stop']!, content: buildStopScript(port) },
    { name: names['Notification']!, content: buildNotifyScript(port) },
    { name: names['PreToolUse']!, content: buildPreToolScript(port) },
    { name: names['PostToolUse']!, content: buildPostToolScript(port) },
  ];
}

/** Write all hook scripts to ~/.imcodes/ and register them in ~/.claude/settings.json. */
export async function setupCCHooks(): Promise<void> {
  await fs.mkdir(IMCODES_DIR, { recursive: true });
  const port = activeHookPort;
  const scripts = buildScripts(port);
  const names = hookScripts();

  // ── 1. Write hook scripts ───────────────────────────────────────────────────
  for (const { name, content } of scripts) {
    const scriptPath = path.join(IMCODES_DIR, name);
    await fs.writeFile(scriptPath, content);
    await fs.chmod(scriptPath, 0o755).catch(() => {}); // chmod may fail on Windows, that's fine
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

  for (const [eventName, scriptName] of Object.entries(names)) {
    const scriptPath = path.join(IMCODES_DIR, scriptName);
    // On Windows, CC needs "node <path>" as the command since .mjs isn't directly executable
    const command = IS_WINDOWS ? `node "${scriptPath}"` : scriptPath;
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
      hooks: [{ type: 'command', command }],
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
