/**
 * Build a minimal explicit environment for spawning agent tmux sessions.
 * Only pass through safe, non-secret env vars. Never pass secrets to child processes.
 *
 * Agents are spawned with ONLY these env vars — any secrets from the daemon's
 * environment are explicitly excluded.
 */

import { claudeAuthUdsEnv } from './claude-auth-uds.js';
import { IMCODES_DAEMON_SESSION_NAME_ENV } from '../../shared/memory-mcp-env.js';
import { IMCODES_SESSION_ENV, IMCODES_SESSION_LABEL_ENV } from '../../shared/imcodes-send.js';

/** Explicit Claude provider inputs allowed in a session-scoped SDK launch. */
const CLAUDE_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

/** Non-secret runtime identity/context that must survive SDK launches. */
const SAFE_CLAUDE_RUNTIME_ENV_KEYS = [
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_SESSION_ENV,
  IMCODES_SESSION_LABEL_ENV,
] as const;

/** Safe env vars that agents always need */
const ALWAYS_ALLOWED = [
  'PATH',
  'HOME',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
];

/** Env var patterns that are explicitly blocked (secrets/credentials) */
const BLOCKED_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /key/i,
  /credential/i,
  /api_/i,
  /auth/i,
  /^deck/i,
  /^jwt/i,
];

/**
 * Build a minimal environment for an agent tmux session.
 *
 * @param agentSpecificVars  Agent-specific vars to include (e.g., ANTHROPIC_API_KEY for CC).
 *   These must be explicitly opted-in — they are NOT automatically inherited.
 * @returns Environment object safe to pass to `newSession({ env: ... })`.
 */
export function buildAgentEnv(agentSpecificVars: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const source = process.env;

  // Passthrough only explicitly allowed vars
  for (const key of ALWAYS_ALLOWED) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Add agent-specific vars (caller is responsible for providing correct keys/values)
  for (const [k, v] of Object.entries(agentSpecificVars)) {
    if (isBlocked(k)) {
      // Log warning and skip — prevents accidental secret leakage via this path
      console.warn(`[env-isolation] Blocked env var "${k}" — pass via agent config, not env`);
      continue;
    }
    env[k] = v;
  }

  return env;
}

/**
 * Get the agent-specific env vars for a given agent type.
 * Only includes the vars explicitly needed by that agent.
 */
export function getAgentEnvVars(agentType: 'claude-code' | 'codex' | 'opencode'): string[] {
  switch (agentType) {
    case 'claude-code':
      return [...CLAUDE_PROVIDER_ENV_KEYS];
    case 'codex':
      return ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
    case 'opencode':
      return ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  }
}

/**
 * Build agent env from process.env, extracting only the agent-specific API key vars.
 * The caller must ensure these vars are set in process.env before calling this.
 */
export function buildAgentEnvFromProcess(
  agentType: 'claude-code' | 'codex' | 'opencode',
): Record<string, string> {
  const agentVars: Record<string, string> = {};
  for (const key of getAgentEnvVars(agentType)) {
    const val = process.env[key];
    if (val) agentVars[key] = val;
  }
  return agentType === 'claude-code'
    ? buildClaudeAgentEnv(agentVars)
    : buildAgentEnv(agentVars);
}

/**
 * Build the Claude child environment while preserving only an approved local
 * UDS auth context. API keys, OAuth credential files and arbitrary sockets are
 * never projected by this helper.
 */
export function buildClaudeAgentEnv(extra: Record<string, string> = {}): Record<string, string> {
  // `extra` is already the session/provider route, not process.env. Preserve
  // only Claude's explicit provider variables here: the generic isolation
  // helper intentionally blocks key/token-shaped names, while applying it
  // directly would silently drop the configured Claude credentials. Do not
  // widen this to all of extra, since Anthropic-compatible presets may also
  // carry OPENAI_* or unrelated provider credentials.
  const claudeEnv: Record<string, string> = {};
  for (const key of CLAUDE_PROVIDER_ENV_KEYS) {
    const value = extra[key]?.trim();
    if (value) claudeEnv[key] = value;
  }
  const runtimeEnv: Record<string, string> = {};
  for (const key of SAFE_CLAUDE_RUNTIME_ENV_KEYS) {
    const value = extra[key]?.trim();
    if (value) runtimeEnv[key] = value;
  }
  // mise exports are non-secret toolchain/runtime selection, not provider
  // credentials. Keep only the explicit MISE_* namespace from the session
  // route; never pass arbitrary extra keys through this boundary.
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('MISE_') && value.trim()) runtimeEnv[key] = value;
  }
  const safe = buildAgentEnv(runtimeEnv);
  Object.assign(safe, claudeEnv);
  Object.assign(safe, claudeAuthUdsEnv({ ...process.env, ...extra }));
  return safe;
}

function isBlocked(key: string): boolean {
  // Allow explicitly needed keys if they match the ALWAYS_ALLOWED list
  if (ALWAYS_ALLOWED.includes(key)) return false;
  return BLOCKED_PATTERNS.some((p) => p.test(key));
}
