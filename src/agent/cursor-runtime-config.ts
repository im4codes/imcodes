import * as childProcess from 'node:child_process';
import {
  hasPendingCursorStagedUpdate,
  resolveCursorLaunchPlan,
  resolveCursorPathForSdk,
} from './transport-paths.js';
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
  /** True only when returning an unprobed cold empty default instead of a real CLI probe result. */
  isColdFallback?: boolean;
}

let cached: { expiresAt: number; value: CursorRuntimeConfig } | null = null;
let inFlightProbe: Promise<CursorRuntimeConfig> | null = null;

export type CursorRuntimeConfigOptions = boolean | {
  force?: boolean;
  /**
   * When false, never spawn cursor-agent. Return cached data when present,
   * otherwise a safe empty config. Passive UI/session-list refreshes must not
   * wake a heavyweight CLI probe on daemon startup.
   */
  probe?: boolean;
};

function normalizeOptions(options: CursorRuntimeConfigOptions): { force: boolean; probe: boolean } {
  if (typeof options === 'boolean') return { force: options, probe: true };
  return {
    force: options.force === true,
    probe: options.probe !== false,
  };
}

function emptyRuntimeConfig(): CursorRuntimeConfig {
  return {
    availableModels: [],
    isAuthenticated: false,
    isColdFallback: true,
  };
}

/** Strip ANSI escape codes that the cursor CLI emits when stdout is a TTY.
 *  Works on a best-effort basis — we only need clean lines for parsing. */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

const LIST_MODELS_IGNORED_LINE_RE = /^(?:available\s+models\b|no\s+models\b|loading\b|tip:|error:|usage:)/i;
const LIST_MODELS_DESC_RE = /^\s*([a-z0-9][a-zA-Z0-9._:/[\]-]*)\s+-\s+.*$/i;
const LIST_MODELS_BARE_RE = /^\s*([a-z0-9][a-zA-Z0-9._:/[\]-]*)(?:\s+(?:\((?:default|current)(?:\s*,\s*(?:default|current))*\)\s*)+|\s*)$/i;
const LIST_MODELS_DEFAULT_FLAG_RE = /\((?:[^)]*,)?\s*default\s*(?:,[^)]*)?\)/i;

function parseListModelsOutput(raw: string): { availableModels: string[]; defaultModel?: string } {
  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/);
  const models: string[] = [];
  let defaultModel: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || LIST_MODELS_IGNORED_LINE_RE.test(trimmed)) continue;
    const match = LIST_MODELS_DESC_RE.exec(line) ?? LIST_MODELS_BARE_RE.exec(line);
    if (!match) continue;
    const id = match[1];
    if (!id || models.includes(id)) continue;
    models.push(id);
    if (LIST_MODELS_DEFAULT_FLAG_RE.test(line) && !defaultModel) defaultModel = id;
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
    const child = execFile(
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
    child?.stdin?.end?.();
  });
}

/** Fetch the current Cursor runtime config (available models + auth state).
 *  Cached for {@link CACHE_TTL_MS} unless `force` is true. Never throws —
 *  returns a safe default when the CLI is missing or errors. */
export async function getCursorRuntimeConfig(options: CursorRuntimeConfigOptions = false): Promise<CursorRuntimeConfig> {
  const { force, probe } = normalizeOptions(options);
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (!probe) return cached?.value ?? emptyRuntimeConfig();
  // Share a single in-flight probe across concurrent callers. The two
  // `cursor-agent` exec calls take up to PROBE_TIMEOUT_MS (10s) each — without
  // this dedupe, every cache-miss caller (session-list, command-handler,
  // session-manager) would start its own pair of execs in parallel.
  if (inFlightProbe) return inFlightProbe;
  inFlightProbe = (async () => {
    try {
      let plan = resolveCursorLaunchPlan(resolveCursorPathForSdk(CURSOR_BIN));
      if (hasPendingCursorStagedUpdate(plan) && plan.promoteStep) {
        try {
          await execFileStdout(plan.promoteStep.executable, [...plan.promoteStep.prependArgs, '--version']);
        } catch (err) {
          logger.debug({ err }, 'cursor-agent staged promote step failed during runtime config probe');
        }
        plan = resolveCursorLaunchPlan(resolveCursorPathForSdk(CURSOR_BIN));
      }
      const resolved = plan.direct;
      if (!resolved) {
        logger.warn('cursor-agent has no active non-.new executable entrypoint; returning empty runtime config');
        return {
          availableModels: [],
          isAuthenticated: false,
        };
      }
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
      cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    } finally {
      inFlightProbe = null;
    }
  })();
  return inFlightProbe;
}

/** Exposed for tests. */
export const __cursorRuntimeConfigInternals = {
  parseListModelsOutput,
  parseStatusOutput,
  clearCache: () => {
    cached = null;
    inFlightProbe = null;
  },
};
