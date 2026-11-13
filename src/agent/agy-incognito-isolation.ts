import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AGY_CLI_FLAG } from '../../shared/agy-agent.js';

export interface AgyIncognitoEnv {
  readonly homeDir: string;
  readonly logFile: string;
  readonly env: Record<string, string>;
  readonly acpFlags: string[];
  readonly streamFlags: string[];
  cleanup(): Promise<void>;
  cleanupSync(): void;
}

const AUTH_RELATIVE_PATHS = [
  path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  path.join('.gemini', 'oauth_creds.json'),
  path.join('.gemini', 'google_accounts.json'),
] as const;

const activeIncognitoHomes = new Set<string>();
let exitHookRegistered = false;

function registerExitCleanupHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    for (const dir of activeIncognitoHomes) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort process-exit cleanup.
      }
    }
    activeIncognitoHomes.clear();
  });
}

/**
 * Resolve the non-incognito home directory from caller envs, falling back to
 * OS homedir, while skipping any directory already created for AG incognito.
 */
export function resolveAgySourceHome(...envs: Array<Record<string, string | undefined> | undefined>): string {
  for (const env of envs) {
    for (const key of ['HOME', 'USERPROFILE'] as const) {
      const candidate = env?.[key]?.trim();
      if (candidate && !activeIncognitoHomes.has(path.resolve(candidate))) {
        return candidate;
      }
    }
  }
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

/**
 * Provision an isolated ephemeral `HOME` / `GEMINI_CLI_HOME` directory for an
 * Antigravity incognito session. Copies only minimal standalone auth token
 * files (no symlinks, no `brain/`, no `conversations/`, no DBs, no `settings.json`)
 * and writes an empty `.gemini/config/mcp_config.json` so `imcodes-memory` and
 * user MCPs are disabled.
 */
export function createAgyIncognitoEnvSync(sourceHome?: string): AgyIncognitoEnv {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'imcodes-agy-incog-'));
  try { chmodSync(homeDir, 0o700); } catch { /* non-POSIX */ }
  activeIncognitoHomes.add(path.resolve(homeDir));
  registerExitCleanupHook();

  const geminiDir = path.join(homeDir, '.gemini');
  const agyCliDir = path.join(geminiDir, 'antigravity-cli');
  const configDir = path.join(geminiDir, 'config');
  mkdirSync(agyCliDir, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir, 'mcp_config.json'), `${JSON.stringify({ mcpServers: {} })}\n`, { mode: 0o600 });

  const resolvedSource = sourceHome?.trim() ? path.resolve(sourceHome.trim()) : undefined;
  if (resolvedSource && resolvedSource !== path.resolve(homeDir)) {
    for (const rel of AUTH_RELATIVE_PATHS) {
      const src = path.join(resolvedSource, rel);
      if (!existsSync(src)) continue;
      const dst = path.join(homeDir, rel);
      mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      copyFileSync(src, dst);
      try { chmodSync(dst, 0o600); } catch { /* non-POSIX */ }
    }
  }

  const logFile = path.join(homeDir, 'agy.log');
  const env: Record<string, string> = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    GEMINI_CLI_HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
  };
  const acpFlags = [AGY_CLI_FLAG.DISABLE_TELEMETRY, AGY_CLI_FLAG.LOG_FILE, logFile];
  const streamFlags = [AGY_CLI_FLAG.LOG_FILE, logFile];
  let cleaned = false;

  const cleanupSync = (): void => {
    if (cleaned) return;
    cleaned = true;
    activeIncognitoHomes.delete(path.resolve(homeDir));
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    activeIncognitoHomes.delete(path.resolve(homeDir));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  };

  return { homeDir, logFile, env, acpFlags, streamFlags, cleanup, cleanupSync };
}
