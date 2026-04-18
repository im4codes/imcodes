import * as childProcess from 'node:child_process';
import { resolveExecutableForSpawn } from './transport-paths.js';
import logger from '../util/logger.js';

const CURSOR_BIN = 'cursor-agent';
const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface CursorRuntimeConfig {
  /** Ordered list of model ids exposed by `cursor-agent --list-models`. */
  availableModels: string[];
  /** Default model id reported by the CLI (the one marked `(default)`), if any. */
  defaultModel?: string;
  /** Logged-in user email/identity reported by `cursor-agent status`. */
  loggedInAs?: string;
  /** True when the CLI reported an authenticated state. */
  isAuthenticated: boolean;
}

let cached: { expiresAt: number; value: CursorRuntimeConfig } | null = null;

/** Strip ANSI escape codes that the cursor CLI emits when stdout is a TTY.
 *  Works on a best-effort basis — we only need clean lines for parsing. */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function parseListModelsOutput(raw: string): { availableModels: string[]; defaultModel?: string } {
  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/);
  const models: string[] = [];
  let defaultModel: string | undefined;
  const entryRe = /^\s*([a-z0-9][a-zA-Z0-9._-]*)\s+-\s+.*$/;
  for (const line of lines) {
    const match = entryRe.exec(line);
    if (!match) continue;
    const id = match[1];
    if (!id || models.includes(id)) continue;
    models.push(id);
    if (/\(default\)/i.test(line) && !defaultModel) defaultModel = id;
  }
  return { availableModels: models, ...(defaultModel ? { defaultModel } : {}) };
}

function parseStatusOutput(raw: string): { isAuthenticated: boolean; loggedInAs?: string } {
  const text = stripAnsi(raw);
  if (/not\s+logged\s+in|sign\s*in|log\s+in|logged\s+out|unauth/i.test(text)) {
    return { isAuthenticated: false };
  }
  const emailMatch = text.match(/logged\s+in\s+as\s+([^\s]+@[^\s]+)/i);
  if (emailMatch) return { isAuthenticated: true, loggedInAs: emailMatch[1] };
  if (/logged\s+in|authenticated|signed\s+in|status:\s*ok/i.test(text)) return { isAuthenticated: true };
  return { isAuthenticated: false };
}

async function execFileStdout(file: string, args: string[]): Promise<string> {
  const execFile = childProcess.execFile;
  return await new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        // cursor-agent prints models to stdout but sometimes the "Loading..."
        // preamble and list both come on stderr under a TTY. Concatenate to be
        // safe — parsers only read well-formed lines.
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        resolve(`${out}\n${errOut}`);
      },
    );
  });
}

/** Fetch the current Cursor runtime config (available models + auth state).
 *  Cached for {@link CACHE_TTL_MS} unless `force` is true. Never throws —
 *  returns a safe default when the CLI is missing or errors. */
export async function getCursorRuntimeConfig(force = false): Promise<CursorRuntimeConfig> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;

  const resolved = resolveExecutableForSpawn(CURSOR_BIN);
  let modelsOut = '';
  try {
    modelsOut = await execFileStdout(resolved.executable, [...resolved.prependArgs, '--list-models']);
  } catch (err) {
    logger.warn({ err }, 'cursor-agent --list-models probe failed');
  }
  let statusOut = '';
  try {
    statusOut = await execFileStdout(resolved.executable, [...resolved.prependArgs, 'status']);
  } catch (err) {
    logger.debug({ err }, 'cursor-agent status probe failed');
  }

  const { availableModels, defaultModel } = parseListModelsOutput(modelsOut);
  const auth = parseStatusOutput(statusOut);
  const value: CursorRuntimeConfig = {
    availableModels,
    ...(defaultModel ? { defaultModel } : {}),
    ...(auth.loggedInAs ? { loggedInAs: auth.loggedInAs } : {}),
    isAuthenticated: auth.isAuthenticated,
  };
  cached = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
}

/** Exposed for tests. */
export const __cursorRuntimeConfigInternals = {
  parseListModelsOutput,
  parseStatusOutput,
  clearCache: () => {
    cached = null;
  },
};
