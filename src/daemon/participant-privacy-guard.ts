import * as fsp from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';
import type { ApprovalRequest, ToolExecutionGuardDecision } from '../agent/transport-provider.js';

export interface SensitivePathCheckOptions {
  homeDir?: string;
  cwd?: string;
  sessionName?: string;
  providerSessionId?: string;
  dispatchId?: number | null;
}

const SINGLE_SENSITIVE_DIRS = new Set([
  '.ssh',
  '.gnupg',
  '.pki',
  '.aws',
  '.kube',
  '.imcodes',
  '.azure',
]);

const TWO_SEGMENT_SENSITIVE_PATHS: readonly (readonly [string, string])[] = [
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['.docker', 'config.json'],
];

const EXACT_SENSITIVE_FILENAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'authorized_keys',
  'known_hosts',
  '.bash_history',
  '.zsh_history',
  '.sh_history',
]);

const PRIVATE_KEY_FILE_RE = /^id_(?:rsa|ed25519|ecdsa|dsa)/i;
const CERT_KEY_EXT_RE = /\.(?:pem|p12|pfx)$/i;
const SYSTEM_SENSITIVE_PATH_RE = /^(?:\/|(?:\.\.\/)+)(?:proc\/[^/]+\/environ|etc\/shadow)(?:\/|$)/i;
const PATH_TARGET_TOOL_RE = /^(?:read|view|edit|write|multiedit|multi_edit|notebookedit|notebook_edit|read_file|write_file|edit_file|file_read|file_write|apply_patch|patch|patch_file|create_file|delete_file|move_file|rename_file|read_many_files|write_to_file|replace_file_content|multi_replace_file_content|str_replace_editor|external_directory)$/i;
const DIR_SCAN_TOOL_RE = /^(?:glob|grep|find|ls|list|search|list_dir|search_files)$/i;
const GLOB_PATTERN_TOOL_RE = /^(?:glob|find|list_dir|search_files|external_directory)$/i;
const SHELL_EXEC_TOOL_RE = /^(?:bash|shell|run_shell_command|exec_command|execute_command|local_shell|terminal|powershell|exec)$/i;
const PATH_INPUT_KEYS = new Set([
  'file_path', 'filepath', 'path', 'target', 'target_file', 'targetfile',
  'target_path', 'targetpath', 'file', 'source', 'src', 'dest', 'destination',
  'directory', 'dir', 'dir_path', 'workdir', 'working_directory', 'cwd',
  'root', 'paths', 'files', 'patterns', 'resources', 'url', 'uri',
  'glob', 'includes', 'notebook_path', 'notebookpath',
]);
const PATCH_INPUT_KEYS = new Set(['patch', 'patch_text', 'patchtext', 'diff']);
const SHELL_INPUT_KEYS = new Set(['command', 'cmd', 'argv', 'args', 'script']);
const CONTENT_INPUT_KEYS = new Set([
  'content', 'new_string', 'old_string', 'newstring', 'oldstring', 'replacement',
  'code', 'text', 'body', 'data', 'markdown', 'html', 'prompt', 'message',
  'description', 'title', 'reason', 'explanation', 'comment', 'query',
  'output', 'stdout', 'stderr',
]);
const MAX_SUBTREE_SCAN_ENTRIES = 10_000;

/** Returns true when a shared actor envelope represents a non-owner participant (tab-share or whole-server share). */
export function isSharedParticipantActor(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return (raw as { effectiveActorRole?: unknown }).effectiveActorRole === 'participant';
}

function stripOuterQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'') || (first === '`' && last === '`')) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function expandHomeVars(raw: string, homeDir: string): { value: string; anchoredToHome: boolean } {
  const forwardHome = toForwardSlashes(homeDir).replace(/\/+$/, '');
  const s = toForwardSlashes(raw);
  if (s === '~') return { value: forwardHome, anchoredToHome: true };
  if (s.startsWith('~/')) return { value: `${forwardHome}${s.slice(1)}`, anchoredToHome: true };

  const replaced = s
    .replace(/\$\{HOME\}/gi, forwardHome)
    .replace(/\$HOME(?=\/|$)/gi, forwardHome)
    .replace(/%USERPROFILE%/gi, forwardHome)
    .replace(/\$USERPROFILE(?=\/|$)/gi, forwardHome);

  const anchoredToHome = replaced !== s
    || replaced === forwardHome
    || replaced.toLowerCase().startsWith(`${forwardHome.toLowerCase()}/`);
  return { value: replaced, anchoredToHome };
}

function stripDrivePrefix(forwardPath: string): string {
  return forwardPath.replace(/^[a-zA-Z]:(?=\/|$)/, '');
}

function matchesNormalizedCandidate(normalized: string, homeNormalized: string): boolean {
  const withoutDrive = stripDrivePrefix(normalized);
  if (SYSTEM_SENSITIVE_PATH_RE.test(withoutDrive)) {
    return true;
  }

  const lowerHome = stripDrivePrefix(homeNormalized).replace(/\/+$/, '').toLowerCase();
  const lowerCandidate = withoutDrive.replace(/\/+$/, '').toLowerCase();
  if (lowerHome && (lowerCandidate === `${lowerHome}/.docker` || lowerCandidate.startsWith(`${lowerHome}/.docker/`))) {
    return true;
  }

  const segments = withoutDrive.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  for (let i = 0; i < segments.length; i += 1) {
    const segLower = segments[i]!.toLowerCase();
    if (SINGLE_SENSITIVE_DIRS.has(segLower)) return true;
    if (i + 1 < segments.length) {
      const nextLower = segments[i + 1]!.toLowerCase();
      for (const [first, second] of TWO_SEGMENT_SENSITIVE_PATHS) {
        if (segLower === first && nextLower === second) return true;
      }
    }
    if (EXACT_SENSITIVE_FILENAMES.has(segLower)) return true;
    if (PRIVATE_KEY_FILE_RE.test(segLower)) return true;
    if (CERT_KEY_EXT_RE.test(segLower)) return true;
  }

  return false;
}

/** Expand `~`, `$HOME`, `${HOME}`, and `%USERPROFILE%` into a filesystem-friendly path. */
export function expandHomeEnvPath(rawPath: string, homeDir: string = osHomedir()): string {
  const trimmed = stripOuterQuotes(rawPath);
  if (!trimmed) return '';
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed
    .replace(/\$\{HOME\}/gi, homeDir)
    .replace(/\$HOME(?=[\\/]|$)/gi, homeDir)
    .replace(/%USERPROFILE%/gi, homeDir)
    .replace(/\$USERPROFILE(?=[\\/]|$)/gi, homeDir);
}

/**
 * Deterministic check whether a path or path-like string targets participant-forbidden
 * credentials, private keys, sensitive system files, or IM.codes/agent secret directories.
 * Does NOT false-positive on normal source files like `src/ssh-helper.ts` or `test/keys.test.ts`.
 */
export function isParticipantSensitivePath(pathOrText: string, options: SensitivePathCheckOptions = {}): boolean {
  const cleaned = stripOuterQuotes(pathOrText);
  if (!cleaned) return false;

  const homeDir = options.homeDir ?? osHomedir();
  const homeForward = path.posix.normalize(toForwardSlashes(homeDir));
  const { value: expandedForward } = expandHomeVars(cleaned, homeDir);

  const normalizedLexical = path.posix.normalize(expandedForward);
  if (matchesNormalizedCandidate(normalizedLexical, homeForward)) {
    return true;
  }

  if (options.cwd && !expandedForward.startsWith('/') && !/^[a-zA-Z]:/.test(expandedForward)) {
    const resolvedFromCwd = path.posix.resolve(toForwardSlashes(options.cwd), expandedForward);
    if (matchesNormalizedCandidate(resolvedFromCwd, homeForward)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve symlinks and ancestor directories where needed, returning true if either the
 * lexical path, symlink target, or canonical real path matches `isParticipantSensitivePath`.
 */
export async function isParticipantSensitiveRealPath(
  rawPath: string,
  options: SensitivePathCheckOptions = {},
): Promise<boolean> {
  if (isParticipantSensitivePath(rawPath, options)) return true;
  const homeDir = options.homeDir ?? osHomedir();
  const expanded = expandHomeEnvPath(rawPath, homeDir);
  if (!expanded) return false;
  // Without an explicit cwd, a relative path cannot be resolved to a real host path
  // reliably; do not bind it to the daemon/test process.cwd().
  if (!options.cwd && !path.isAbsolute(expanded) && !/^[a-zA-Z]:[\\/]/.test(expanded)) {
    return false;
  }
  const resolved = options.cwd && !path.isAbsolute(expanded)
    ? path.resolve(options.cwd, expanded)
    : path.resolve(expanded);
  if (isParticipantSensitivePath(resolved, options)) return true;

  try {
    const real = await fsp.realpath(resolved);
    if (isParticipantSensitivePath(real, options)) return true;
  } catch {
    // Check dangling symlink target if `resolved` itself is a broken symlink.
    try {
      const st = await fsp.lstat(resolved);
      if (st.isSymbolicLink() && typeof (fsp as { readlink?: unknown }).readlink === 'function') {
        const linkTarget = await fsp.readlink(resolved);
        const absLink = path.isAbsolute(linkTarget)
          ? linkTarget
          : path.resolve(path.dirname(resolved), linkTarget);
        if (isParticipantSensitivePath(absLink, options)) return true;
      }
    } catch { /* ignore */ }

    // Walk up ancestors for non-existent create targets (e.g. fs.write/fs.mkdir under symlinked dir).
    let current = path.dirname(resolved);
    while (current) {
      if (isParticipantSensitivePath(current, options)) return true;
      try {
        const realParent = await fsp.realpath(current);
        const rel = path.relative(current, resolved);
        const combined = rel ? path.join(realParent, rel) : realParent;
        if (isParticipantSensitivePath(realParent, options) || isParticipantSensitivePath(combined, options)) {
          return true;
        }
        break;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }

  return false;
}

const MAX_TOOL_WALK_DEPTH = 6;

function collectStringCandidates(value: unknown, out: string[], depth = 0): void {
  if (depth > MAX_TOOL_WALK_DEPTH || value == null) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(trimmed);
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        collectStringCandidates(parsed, out, depth + 1);
      } catch { /* not valid JSON — scan as plain text */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringCandidates(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStringCandidates(entry, out, depth + 1);
    }
  }
}

function tokenizeCandidateString(text: string): string[] {
  const tokens: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return tokens;

  // Run separate passes for double, single, and backtick quotes so nested quotes
  // like `'open("/home/k/.ssh/id_rsa").read()'` yield the inner path token cleanly.
  for (const quotedRe of [/"([^"\r\n]+)"/g, /'([^'\r\n]+)'/g, /`([^`\r\n]+)`/g]) {
    let match: RegExpExecArray | null;
    while ((match = quotedRe.exec(text)) !== null) {
      const inner = (match[1] ?? '').trim();
      if (inner) tokens.push(inner);
    }
  }

  // Split on shell command separators and whitespace while preserving `:`, `\`, `/`, `~`, `$`, `%`, `.`.
  for (const part of text.split(/[\s;|&<>()[\]{},]+/)) {
    const clean = stripOuterQuotes(part);
    if (!clean) continue;
    tokens.push(clean);
    const eqIdx = clean.indexOf('=');
    if (eqIdx > 0 && eqIdx < clean.length - 1) {
      const rhs = stripOuterQuotes(clean.slice(eqIdx + 1));
      if (rhs) tokens.push(rhs);
    }
  }

  if (!/[\s;|&<>]/.test(trimmed)) {
    tokens.push(trimmed);
  }

  return tokens;
}

function normalizePathCandidate(raw: string): string | null {
  const cleaned = stripOuterQuotes(raw);
  if (!cleaned) return null;
  if (cleaned.startsWith('file://')) {
    try {
      const url = new URL(cleaned);
      return decodeURIComponent(url.pathname);
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}

function stripWildcardSuffix(candidate: string): string {
  const wildcardIdx = candidate.search(/[*?[{]/);
  if (wildcardIdx < 0) return candidate;
  const prefix = candidate.slice(0, wildcardIdx);
  const slashIdx = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  return slashIdx >= 0 ? prefix.slice(0, slashIdx + 1) : '';
}

function cwdFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['cwd', 'workdir', 'working_directory', 'dir_path', 'root']) {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim()) {
      return normalizePathCandidate(raw) ?? undefined;
    }
  }
  return undefined;
}

function extractPatchTargets(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const patchMatch = /^\*\*\*\s+(?:Update|Add|Delete|Move to)\s+File:\s*(.+)$/i.exec(line.trim());
    if (patchMatch?.[1]) targets.push(patchMatch[1].trim());
    const diffMatch = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/.exec(line.trim());
    if (diffMatch?.[1] && diffMatch[1] !== '/dev/null') targets.push(diffMatch[1].trim());
  }
  return targets;
}

function collectToolTargets(
  value: unknown,
  pathTargets: string[],
  shellCommands: string[],
  toolName: string,
  depth = 0,
  keyHint?: string,
  allowUnkeyedFallback = false,
): void {
  if (depth > MAX_TOOL_WALK_DEPTH || value == null) return;
  const lowerKey = keyHint?.toLowerCase();
  if (lowerKey && CONTENT_INPUT_KEYS.has(lowerKey)) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        collectToolTargets(JSON.parse(trimmed) as unknown, pathTargets, shellCommands, toolName, depth + 1, keyHint, allowUnkeyedFallback);
        return;
      } catch { /* fall through to explicit key / fallback handling */ }
    }
    if (lowerKey) {
      if (PATCH_INPUT_KEYS.has(lowerKey)) {
        pathTargets.push(...extractPatchTargets(trimmed));
        return;
      }
      if (PATH_INPUT_KEYS.has(lowerKey) || (lowerKey === 'pattern' && GLOB_PATTERN_TOOL_RE.test(toolName))) {
        const normalized = normalizePathCandidate(trimmed);
        if (normalized) pathTargets.push(normalized);
        return;
      }
      if (SHELL_INPUT_KEYS.has(lowerKey)) {
        shellCommands.push(trimmed);
        return;
      }
      return;
    }
    if (allowUnkeyedFallback) {
      if (SHELL_EXEC_TOOL_RE.test(toolName)) {
        shellCommands.push(trimmed);
      } else if (PATH_TARGET_TOOL_RE.test(toolName) || DIR_SCAN_TOOL_RE.test(toolName)) {
        pathTargets.push(...extractPatchTargets(trimmed));
        const normalized = normalizePathCandidate(trimmed);
        if (normalized) pathTargets.push(normalized);
      } else {
        pathTargets.push(...extractPatchTargets(trimmed));
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (lowerKey && SHELL_INPUT_KEYS.has(lowerKey) && value.every((entry) => typeof entry === 'string')) {
      shellCommands.push(value.join(' '));
      return;
    }
    for (const entry of value) {
      collectToolTargets(entry, pathTargets, shellCommands, toolName, depth + 1, keyHint, false);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      collectToolTargets(entry, pathTargets, shellCommands, toolName, depth + 1, key, false);
    }
  }
}

function looksTruncatedPreview(preview: string | undefined): boolean {
  if (!preview) return false;
  const trimmed = preview.trim();
  return trimmed.length >= 295 || trimmed.endsWith('...') || trimmed.endsWith('…');
}

export type ApprovalRequestLike = Pick<ApprovalRequest, 'description' | 'tool' | 'inputPreview'> & {
  input?: unknown;
  cwd?: string;
};

/**
 * Inspect an approval request's tool, description, inputPreview, and optional structured input
 * for any reference to a participant-sensitive path. Returns the matching token/path, or null.
 */
export function findSensitivePathInToolRequest(
  req: ApprovalRequestLike,
  options: SensitivePathCheckOptions = {},
): string | null {
  const opts: SensitivePathCheckOptions = {
    ...options,
    cwd: options.cwd ?? req.cwd ?? cwdFromToolInput(req.input),
  };
  const texts: string[] = [];
  collectStringCandidates(req.tool, texts);
  collectStringCandidates(req.description, texts);
  collectStringCandidates(req.inputPreview, texts);
  collectStringCandidates(req.input, texts);

  for (const text of texts) {
    for (const token of tokenizeCandidateString(text)) {
      const normalized = normalizePathCandidate(token) ?? token;
      if (isParticipantSensitivePath(normalized, opts)) {
        return token;
      }
    }
  }

  return null;
}

export interface ToolAccessCheckInput {
  toolName: string;
  input?: unknown;
  cwd?: string;
  description?: string;
  inputPreview?: string;
  toolUseId?: string;
  providerSessionId?: string;
  dispatchId?: number | null;
}

export type ParticipantToolAccessDecision =
  | { allow: true }
  | { allow: false; reason: string };

interface PreEvaluatedParticipantToolRecord {
  sessionName: string;
  providerSessionId: string;
  dispatchId: number | null;
  turnEpoch: number;
  toolUseId: string;
  toolName: string;
  decision: ParticipantToolAccessDecision;
  recordedAt: number;
}

const MAX_PRE_EVALUATED_DECISIONS = 512;
const PRE_EVALUATED_DECISION_TTL_MS = 10 * 60 * 1000;
const preEvaluatedParticipantToolDecisions = new Map<string, PreEvaluatedParticipantToolRecord>();
const sessionTurnEpochs = new Map<string, number>();

export function getParticipantToolTurnEpoch(sessionName: string): number {
  const trimmed = sessionName.trim();
  if (!trimmed) return 0;
  return sessionTurnEpochs.get(trimmed) ?? 0;
}

function preEvaluatedKey(
  sessionName: string,
  providerSessionId: string,
  dispatchId: number | null,
  toolUseId: string,
): string {
  return `${sessionName}\0${providerSessionId}\0${dispatchId === null ? 'none' : String(dispatchId)}\0${toolUseId}`;
}

function pruneExpiredPreEvaluatedDecisions(now: number): void {
  for (const [key, entry] of preEvaluatedParticipantToolDecisions) {
    if (now - entry.recordedAt > PRE_EVALUATED_DECISION_TTL_MS) {
      preEvaluatedParticipantToolDecisions.delete(key);
    }
  }
}

/**
 * Bind an authoritative pre-execution tool decision (evaluated against full structured `input`)
 * to its active participant session, provider session, dispatch, turn epoch, and toolUseId so
 * downstream redacted approval previews for that exact request do not fail on truncation and
 * delayed stale pre-checks from superseded turns cannot be recorded or reused.
 */
export function recordPreEvaluatedParticipantToolDecision(input: {
  sessionName: string;
  toolUseId: string;
  toolName: string;
  decision: ParticipantToolAccessDecision;
  providerSessionId?: string;
  dispatchId?: number | null;
  expectedTurnEpoch?: number;
}): boolean {
  const sessionName = input.sessionName.trim();
  const toolUseId = input.toolUseId.trim();
  const toolName = input.toolName.trim();
  const providerSessionId = input.providerSessionId?.trim() ?? '';
  const dispatchId = input.dispatchId ?? null;
  if (!sessionName || !toolUseId || !toolName) return false;
  const currentEpoch = getParticipantToolTurnEpoch(sessionName);
  if (input.expectedTurnEpoch !== undefined && input.expectedTurnEpoch !== currentEpoch) {
    return false;
  }
  const now = Date.now();
  pruneExpiredPreEvaluatedDecisions(now);
  const key = preEvaluatedKey(sessionName, providerSessionId, dispatchId, toolUseId);
  if (preEvaluatedParticipantToolDecisions.has(key)) {
    preEvaluatedParticipantToolDecisions.delete(key);
  }
  while (preEvaluatedParticipantToolDecisions.size >= MAX_PRE_EVALUATED_DECISIONS) {
    const oldestKey = preEvaluatedParticipantToolDecisions.keys().next().value;
    if (!oldestKey) break;
    preEvaluatedParticipantToolDecisions.delete(oldestKey);
  }
  preEvaluatedParticipantToolDecisions.set(key, {
    sessionName,
    providerSessionId,
    dispatchId,
    turnEpoch: currentEpoch,
    toolUseId,
    toolName,
    decision: input.decision,
    recordedAt: now,
  });
  return true;
}

export function lookupPreEvaluatedParticipantToolDecision(input: {
  sessionName?: string;
  providerSessionId?: string;
  dispatchId?: number | null;
  toolUseId?: string;
  toolName: string;
}): ParticipantToolAccessDecision | undefined {
  const sessionName = input.sessionName?.trim();
  const toolUseId = input.toolUseId?.trim();
  const toolName = input.toolName.trim();
  const providerSessionId = input.providerSessionId?.trim() ?? '';
  const dispatchId = input.dispatchId ?? null;
  if (!sessionName || !toolUseId || !toolName) return undefined;
  const key = preEvaluatedKey(sessionName, providerSessionId, dispatchId, toolUseId);
  const entry = preEvaluatedParticipantToolDecisions.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.recordedAt > PRE_EVALUATED_DECISION_TTL_MS) {
    preEvaluatedParticipantToolDecisions.delete(key);
    return undefined;
  }
  if (
    entry.turnEpoch !== getParticipantToolTurnEpoch(sessionName)
    || entry.providerSessionId !== providerSessionId
    || entry.dispatchId !== dispatchId
    || entry.toolName !== toolName
  ) {
    return undefined;
  }
  return entry.decision;
}

export function clearPreEvaluatedParticipantToolDecisions(sessionName: string): number {
  const trimmed = sessionName.trim();
  if (!trimmed) return 0;
  const nextEpoch = (sessionTurnEpochs.get(trimmed) ?? 0) + 1;
  sessionTurnEpochs.set(trimmed, nextEpoch);
  for (const [key, entry] of preEvaluatedParticipantToolDecisions) {
    if (entry.sessionName === trimmed) {
      preEvaluatedParticipantToolDecisions.delete(key);
    }
  }
  return nextEpoch;
}

/**
 * Authoritative pre-execution privacy evaluator for shared-participant turns.
 * Resolves full structured tool targets and shell command tokens canonically
 * against `cwd` (including symlinks) and fails closed when a sensitive or
 * file-access tool lacks a verifiable target.
 */
export async function evaluateParticipantToolAccess(
  request: ToolAccessCheckInput,
  options: SensitivePathCheckOptions = {},
): Promise<ParticipantToolAccessDecision> {
  const effectiveCwd = request.cwd ?? cwdFromToolInput(request.input) ?? options.cwd;
  const checkOpts: SensitivePathCheckOptions = {
    homeDir: options.homeDir,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  };

  if (effectiveCwd && await isParticipantSensitiveRealPath(effectiveCwd, { homeDir: checkOpts.homeDir })) {
    return { allow: false, reason: 'Sensitive path policy: working directory is protected' };
  }

  if (request.input === undefined) {
    const preEvaluated = lookupPreEvaluatedParticipantToolDecision({
      sessionName: options.sessionName,
      providerSessionId: request.providerSessionId ?? options.providerSessionId,
      dispatchId: request.dispatchId !== undefined ? request.dispatchId : options.dispatchId,
      toolUseId: request.toolUseId,
      toolName: request.toolName,
    });
    if (preEvaluated) {
      return preEvaluated;
    }
  }

  const pathTargets: string[] = [];
  const shellCommands: string[] = [];
  const freeTexts: string[] = [];

  if (request.input !== undefined) {
    collectToolTargets(request.input, pathTargets, shellCommands, request.toolName, 0, undefined, true);
  }
  if (request.inputPreview !== undefined && request.input === undefined) {
    if (looksTruncatedPreview(request.inputPreview)
      && (PATH_TARGET_TOOL_RE.test(request.toolName) || DIR_SCAN_TOOL_RE.test(request.toolName) || SHELL_EXEC_TOOL_RE.test(request.toolName))) {
      return { allow: false, reason: `Sensitive path policy: incomplete target preview for ${request.toolName}` };
    }
    collectToolTargets(request.inputPreview, pathTargets, shellCommands, request.toolName, 0, undefined, true);
    if (request.description) {
      freeTexts.push(request.description);
    }
  } else if (request.input === undefined && request.description) {
    freeTexts.push(request.description);
  }

  // Fail closed when a path-targeting, dir-scan, or shell approval provides no extractable real target.
  // Human-readable `description` may add denials, but must never satisfy a missing structured target.
  if (PATH_TARGET_TOOL_RE.test(request.toolName) && pathTargets.length === 0 && shellCommands.length === 0) {
    return { allow: false, reason: `Sensitive path policy: missing target path for ${request.toolName}` };
  }
  if (SHELL_EXEC_TOOL_RE.test(request.toolName) && shellCommands.length === 0 && pathTargets.length === 0) {
    return { allow: false, reason: `Sensitive path policy: missing command for ${request.toolName}` };
  }
  if (DIR_SCAN_TOOL_RE.test(request.toolName) && request.input === undefined && pathTargets.length === 0 && shellCommands.length === 0) {
    return { allow: false, reason: `Sensitive path policy: missing scan target for ${request.toolName}` };
  }

  // Fast synchronous lexical check across all structured paths and shell/free-text tokens
  // before touching the filesystem, so obvious sensitive paths reject immediately.
  for (const rawTarget of pathTargets) {
    if (isParticipantSensitivePath(rawTarget, checkOpts)) {
      return { allow: false, reason: `Sensitive path policy: access denied for ${request.toolName}` };
    }
  }
  const tokenCandidates: string[] = [];
  for (const cmd of shellCommands) {
    tokenCandidates.push(...tokenizeCandidateString(cmd));
  }
  for (const text of freeTexts) {
    tokenCandidates.push(...tokenizeCandidateString(text));
  }
  const seenTokens: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of tokenCandidates) {
    const token = normalizePathCandidate(rawToken);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (isParticipantSensitivePath(token, checkOpts)) {
      return { allow: false, reason: `Sensitive path policy: access denied for ${request.toolName}` };
    }
    seenTokens.push(token);
  }

  // Canonical check on structured path targets (following symlinks & .. relative to cwd).
  for (const rawTarget of pathTargets) {
    const prefix = stripWildcardSuffix(rawTarget);
    if (prefix && await isParticipantSensitiveRealPath(prefix, checkOpts)) {
      return { allow: false, reason: `Sensitive path policy: access denied for ${request.toolName}` };
    }
    if (await isParticipantSensitiveRealPath(rawTarget, checkOpts)) {
      return { allow: false, reason: `Sensitive path policy: access denied for ${request.toolName}` };
    }
  }

  // Canonical check on shell command & free-text tokens against realpath.
  for (const token of seenTokens) {
    const prefix = stripWildcardSuffix(token);
    if (prefix && await isParticipantSensitiveRealPath(prefix, checkOpts)) {
      return { allow: false, reason: `Sensitive path policy: access denied for ${request.toolName}` };
    }
    if (await isParticipantSensitiveRealPath(token, checkOpts)) {
      return { allow: false, reason: `Sensitive path policy: access denied for ${request.toolName}` };
    }
  }

  return { allow: true };
}

/**
 * Bounded fail-closed subtree validation before a shared participant deletes or moves
 * a directory. Ordinary single files resolve in O(1); directories are walked without
 * following directory symlinks and fail closed on any sensitive child, symlink target
 * pointing to a sensitive path, I/O error, or entry count bound overflow.
 */
export async function assertParticipantSubtreeSafe(
  rootPath: string,
  options: SensitivePathCheckOptions & { maxEntries?: number; projectedDestinationRoot?: string } = {},
): Promise<boolean> {
  if (await isParticipantSensitiveRealPath(rootPath, options)) return false;
  if (options.projectedDestinationRoot && isParticipantSensitivePath(options.projectedDestinationRoot, options)) {
    return false;
  }

  let rootStats: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    rootStats = await fsp.lstat(rootPath);
  } catch {
    return false;
  }

  if (rootStats.isSymbolicLink()) {
    return !(await isParticipantSensitiveRealPath(rootPath, options));
  }
  if (!rootStats.isDirectory()) {
    return true;
  }

  const maxEntries = options.maxEntries ?? MAX_SUBTREE_SCAN_ENTRIES;
  const queue: string[] = [rootPath];
  let visited = 0;

  while (queue.length > 0) {
    const currentDir = queue.shift()!;
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) return false;
      const childPath = path.join(currentDir, entry.name);
      if (isParticipantSensitivePath(childPath, options)) return false;
      if (options.projectedDestinationRoot) {
        const rel = path.relative(rootPath, childPath);
        const projectedDestChild = rel ? path.join(options.projectedDestinationRoot, rel) : options.projectedDestinationRoot;
        if (isParticipantSensitivePath(projectedDestChild, options)) return false;
      }
      if (entry.isSymbolicLink()) {
        if (await isParticipantSensitiveRealPath(childPath, options)) return false;
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(childPath);
      }
    }
  }

  return true;
}
