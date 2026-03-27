/**
 * Setup idle notify hooks for Codex and OpenCode agents.
 * Both POST directly to the daemon hook server (127.0.0.1:51913/notify).
 *
 * - Codex:    config.toml [notify] "agent-turn-complete" = curl script
 * - OpenCode: .opencode/plugin/idle-notify.ts  session.idle → fetch
 */

import { promises as fs } from 'fs';
import path from 'path';
import { activeHookPort } from '../daemon/hook-server.js';

// ─── Codex ────────────────────────────────────────────────────────────────────

/**
 * Append Codex notify config to <projectDir>/config.toml.
 * The session name is baked in at setup time (each session has its own config).
 */
export async function setupCodexNotify(
  projectDir: string,
  sessionName: string,
): Promise<void> {
  const configPath = path.join(projectDir, 'config.toml');

  let existing = '';
  try { existing = await fs.readFile(configPath, 'utf-8'); } catch { /* ok */ }

  if (existing.includes('agent-turn-complete')) return; // already set up

  const notifyBlock = `
[notify]
"agent-turn-complete" = """
curl -s -X POST "http://127.0.0.1:${activeHookPort}/notify" \\
  -H "Content-Type: application/json" \\
  -d '{"event":"idle","session":"${sessionName}","agentType":"codex"}' \\
  --max-time 2 &>/dev/null || true
"""
`;
  await fs.appendFile(configPath, notifyBlock);
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────

/**
 * Write .opencode/plugin/idle-notify.ts to <projectDir>.
 * OpenCode loads plugins from this directory automatically.
 */
export async function setupOpenCodePlugin(
  projectDir: string,
  sessionName: string,
): Promise<void> {
  const pluginDir = path.join(projectDir, '.opencode', 'plugin');
  await fs.mkdir(pluginDir, { recursive: true });

  const pluginPath = path.join(pluginDir, 'idle-notify.ts');
  const pluginContent = `// IM.codes idle notify plugin for OpenCode
export default {
  name: 'idle-notify',
  events: {
    'session.idle': async () => {
      await fetch('http://127.0.0.1:${activeHookPort}/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'idle', session: '${sessionName}', agentType: 'opencode' }),
      }).catch(() => { /* daemon may not be running */ });
    },
  },
};
`;
  await fs.writeFile(pluginPath, pluginContent);
}
