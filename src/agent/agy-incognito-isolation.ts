import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AGY_CLI_FLAG } from '../../shared/agy-agent.js';

export interface AgyIncognitoEnv {
  readonly homeDir: string;
  readonly logFile: string;
  readonly env: Record<string, string>;
  readonly acpFlags: string[];
  cleanup(): Promise<void>;
  cleanupSync(): void;
}

const AUTH_RELATIVE_PATHS = [
  path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  path.join('.gemini', 'oauth_creds.json'),
  path.join('.gemini', 'google_accounts.json'),
] as const;

const AGY_INCOGNITO_DIR_PREFIX = 'imcodes-agy-incog-';
const OWNER_META_FILENAME = '.imcodes-owner.json';

interface AgyIncognitoOwnerMeta {
  version: 1;
  pid: number;
  startTicks?: string;
  createdAt: number;
}

const activeIncognitoHomes = new Set<string>();
let exitHookRegistered = false;

function registerExitCleanupHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    for (const dir of [...activeIncognitoHomes]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort process-exit cleanup.
      }
      if (!existsSync(dir)) {
        activeIncognitoHomes.delete(dir);
      }
    }
  });
}

function readLinuxProcessStartTicks(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(') ');
    if (rparen < 0) return undefined;
    const fields = stat.slice(rparen + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks && /^\d+$/.test(startTicks) ? startTicks : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

function isOwnerAlive(meta: AgyIncognitoOwnerMeta): boolean {
  if (!isPidAlive(meta.pid)) return false;
  if (meta.startTicks) {
    const liveTicks = readLinuxProcessStartTicks(meta.pid);
    if (liveTicks && liveTicks !== meta.startTicks) {
      return false;
    }
  }
  return true;
}

function readOwnerMeta(dirPath: string): AgyIncognitoOwnerMeta | null {
  const metaPath = path.join(dirPath, OWNER_META_FILENAME);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<AgyIncognitoOwnerMeta>;
    if (
      parsed
      && parsed.version === 1
      && typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.createdAt === 'number'
    ) {
      return parsed as AgyIncognitoOwnerMeta;
    }
  } catch {
    // Malformed/unreadable owner metadata is treated as unowned rather than deleted blindly.
  }
  return null;
}

/**
 * Reclaim orphaned ephemeral AG incognito directories whose owning process has
 * died (e.g., daemon/process SIGKILL crash recovery). Directories without valid
 * `.imcodes-owner.json` or owned by a live process are never touched.
 */
export function reclaimOrphanedAgyIncognitoHomesSync(baseTempDir = tmpdir()): number {
  let entries;
  try {
    entries = readdirSync(baseTempDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let reclaimed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(AGY_INCOGNITO_DIR_PREFIX)) continue;
    const dirPath = path.join(baseTempDir, entry.name);
    const resolved = path.resolve(dirPath);
    if (activeIncognitoHomes.has(resolved)) continue;
    const meta = readOwnerMeta(dirPath);
    if (!meta) continue;
    if (isOwnerAlive(meta)) continue;
    try {
      rmSync(dirPath, { recursive: true, force: true });
      if (!existsSync(dirPath)) reclaimed += 1;
    } catch {
      // Best-effort orphan reclamation; retries on next sweep.
    }
  }
  return reclaimed;
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
  const baseTempDir = tmpdir();
  reclaimOrphanedAgyIncognitoHomesSync(baseTempDir);

  const homeDir = mkdtempSync(path.join(baseTempDir, AGY_INCOGNITO_DIR_PREFIX));
  try { chmodSync(homeDir, 0o700); } catch { /* non-POSIX */ }
  const resolvedHomeDir = path.resolve(homeDir);
  activeIncognitoHomes.add(resolvedHomeDir);
  registerExitCleanupHook();

  const ownerMeta: AgyIncognitoOwnerMeta = {
    version: 1,
    pid: process.pid,
    ...(readLinuxProcessStartTicks(process.pid) ? { startTicks: readLinuxProcessStartTicks(process.pid) } : {}),
    createdAt: Date.now(),
  };
  writeFileSync(path.join(homeDir, OWNER_META_FILENAME), `${JSON.stringify(ownerMeta)}\n`, { mode: 0o600 });

  const geminiDir = path.join(homeDir, '.gemini');
  const agyCliDir = path.join(geminiDir, 'antigravity-cli');
  const configDir = path.join(geminiDir, 'config');
  mkdirSync(agyCliDir, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir, 'mcp_config.json'), `${JSON.stringify({ mcpServers: {} })}\n`, { mode: 0o600 });

  const resolvedSource = sourceHome?.trim() ? path.resolve(sourceHome.trim()) : undefined;
  if (resolvedSource && resolvedSource !== resolvedHomeDir) {
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
  let cleaned = false;
  let inFlightCleanup: Promise<void> | null = null;

  const finalizeCleanupState = (): void => {
    if (!existsSync(homeDir)) {
      cleaned = true;
      activeIncognitoHomes.delete(resolvedHomeDir);
    } else {
      cleaned = false;
    }
  };

  const cleanupSync = (): void => {
    if (cleaned && !existsSync(homeDir)) return;
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; failed removal keeps cleaned=false for subsequent retry.
    }
    finalizeCleanupState();
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned && !existsSync(homeDir)) return;
    if (inFlightCleanup) {
      await inFlightCleanup;
      if (cleaned && !existsSync(homeDir)) return;
    }
    inFlightCleanup = (async () => {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
      finalizeCleanupState();
    })();
    try {
      await inFlightCleanup;
    } finally {
      inFlightCleanup = null;
    }
  };

  return { homeDir, logFile, env, acpFlags, cleanup, cleanupSync };
}
