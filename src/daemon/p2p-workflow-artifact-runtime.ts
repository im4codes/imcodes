import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import type { P2pArtifactConvention } from '../../shared/p2p-workflow-constants.js';
import {
  P2P_WORKFLOW_ARTIFACT_MAX_DEPTH,
  P2P_WORKFLOW_ARTIFACT_MAX_FILES,
  P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES,
  P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES,
} from '../../shared/p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import { validateP2pArtifactRelativePath } from '../../shared/p2p-workflow-artifacts.js';
import type { P2pArtifactContract } from '../../shared/p2p-workflow-types.js';

export type P2pArtifactRuntimePhase = 'freeze' | 'create' | 'validate' | 'baseline';

export interface P2pArtifactRuntimePathOptions {
  repoRoot: string;
  relativePath: string;
  phase?: P2pArtifactRuntimePhase;
  symlinkPolicy?: 'reject_all' | 'allow_existing_under_root';
  artifactRoot?: string;
}

export type P2pArtifactRuntimePathResult =
  | {
    ok: true;
    absolutePath: string;
    repoRootRealPath: string;
    nearestExistingAncestor: string;
    nearestExistingAncestorRealPath: string;
    diagnostics: P2pWorkflowDiagnostic[];
  }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

export async function validateP2pArtifactRuntimePath(
  options: P2pArtifactRuntimePathOptions,
): Promise<P2pArtifactRuntimePathResult> {
  const lexical = validateP2pArtifactRelativePath(options.relativePath, 'artifact.path');
  if (!lexical.ok) return lexical;

  const phase = options.phase ?? 'create';
  const symlinkPolicy = options.symlinkPolicy ?? 'reject_all';
  const repoRootRealPath = await realpath(options.repoRoot).catch(() => null);
  if (!repoRootRealPath) {
    return invalidArtifactPath('repoRoot');
  }

  let artifactRootRealPath: string | null = null;
  if (options.artifactRoot) {
    artifactRootRealPath = await realpath(options.artifactRoot).catch(() => null);
    if (!artifactRootRealPath || !isPathInside(repoRootRealPath, artifactRootRealPath)) {
      return invalidArtifactPath('artifactRoot', 'Artifact root escapes repo root.');
    }
  }

  const segments = lexical.path.split('/');
  let current = options.repoRoot;
  let nearestExistingAncestor = options.repoRoot;
  let nearestExistingAncestorRealPath = repoRootRealPath;

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) break;

    if (stat.isSymbolicLink()) {
      if (phase === 'freeze' || phase === 'create' || symlinkPolicy !== 'allow_existing_under_root') {
        return invalidArtifactPath(segments.slice(0, index + 1).join('/'), 'Symlink component is not allowed for this artifact phase.');
      }
    }

    const currentRealPath = await realpath(current).catch(() => null);
    if (!currentRealPath || !isPathInside(repoRootRealPath, currentRealPath)) {
      return invalidArtifactPath(segments.slice(0, index + 1).join('/'), 'Artifact realpath escapes repo root.');
    }
    if (artifactRootRealPath && !isPathInside(artifactRootRealPath, currentRealPath) && !isPathInside(currentRealPath, artifactRootRealPath)) {
      return invalidArtifactPath(segments.slice(0, index + 1).join('/'), 'Artifact realpath escapes declared artifact root.');
    }
    nearestExistingAncestor = current;
    nearestExistingAncestorRealPath = currentRealPath;
  }

  if (!isPathInside(repoRootRealPath, nearestExistingAncestorRealPath)) {
    return invalidArtifactPath(options.relativePath, 'Nearest existing ancestor escapes repo root.');
  }

  const absolutePath = path.join(options.repoRoot, lexical.path);
  const finalRealPath = await realpath(absolutePath).catch(() => null);
  if (finalRealPath && !isPathInside(repoRootRealPath, finalRealPath)) {
    return invalidArtifactPath(options.relativePath, 'Final artifact realpath escapes repo root.');
  }
  if (finalRealPath && artifactRootRealPath && !isPathInside(artifactRootRealPath, finalRealPath)) {
    return invalidArtifactPath(options.relativePath, 'Final artifact realpath escapes declared artifact root.');
  }

  return {
    ok: true,
    absolutePath,
    repoRootRealPath,
    nearestExistingAncestor,
    nearestExistingAncestorRealPath,
    diagnostics: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Identity freeze (tasks 6.3 / 6.4)
// ──────────────────────────────────────────────────────────────────────────

export interface P2pArtifactFreezeArgs {
  contract: P2pArtifactContract;
  repoRoot: string;
  runId: string;
  inferredSlug?: string;
  /**
   * Optional absolute or repo-relative path the contract author declared as
   * the OpenSpec change root. When omitted the runtime falls back to the
   * sanitized `inferredSlug`.
   */
  openspecChangePath?: string;
}

export interface P2pFrozenArtifactIdentity {
  convention: P2pArtifactConvention;
  openspecChangeSlug?: string;
  openspecChangePath?: string;
  openspecArtifactPaths: string[];
  frozenAt: string;
  collisionResolved: boolean;
  diagnostics: P2pWorkflowDiagnostic[];
}

const COLLISION_SUFFIX_CAP = 100;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

const frozenIdentities = new Map<string, P2pFrozenArtifactIdentity>();

export function getFrozenP2pArtifactIdentity(runId: string): P2pFrozenArtifactIdentity | undefined {
  return frozenIdentities.get(runId);
}

export function __resetP2pArtifactIdentitiesForTests(): void {
  frozenIdentities.clear();
}

/**
 * R3 v1b follow-up — Artifact identity persistence.
 *
 * The previous implementation kept `frozenIdentities` in a module-level
 * Map only. A daemon restart mid-run wiped that map, so the next freeze
 * attempt produced a fresh slug-N suffix and broke the spec invariant
 * "identity preserved across retry/re-entry". We now write each frozen
 * identity to `~/.imcodes/runs/<runId>/identity.json` (atomic
 * `<file>.tmp` → rename) and rehydrate the map on daemon startup via
 * {@link loadPersistedFrozenP2pArtifactIdentities}.
 *
 * The on-disk format is intentionally a thin wrapper:
 *   `{ schemaVersion: 1, identity: P2pFrozenArtifactIdentity }`
 * so future fields can be added without breaking older daemons.
 */
const PERSISTED_IDENTITY_SCHEMA_VERSION = 1 as const;
export const P2P_RUN_STATE_DIR_ENV = 'IMCODES_P2P_RUN_STATE_DIR';

/**
 * R3 v2 PR-ζ (B4) — Resolve the run-state dir, with path containment.
 *
 * Returns `~/.imcodes/runs` by default. When `IMCODES_P2P_RUN_STATE_DIR`
 * env override is set, it MUST resolve under the user's home directory
 * OR the OS temp directory; any other prefix is silently rejected (with
 * a `logger.warn`-equivalent stderr write — this module is import-time
 * sensitive, so we keep it dependency-free) and the override is ignored.
 */
function resolveRunStateDir(): string {
  const defaultDir = path.join(homedir(), '.imcodes', 'runs');
  const override = process.env[P2P_RUN_STATE_DIR_ENV];
  if (!override || override.trim().length === 0) return defaultDir;
  const candidate = path.resolve(override.trim());
  const safeRoots = [path.resolve(homedir()), path.resolve(tmpdir())];
  const within = safeRoots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
  if (!within) {
    // Use process.stderr to avoid pulling logger into this module (artifact
    // runtime is import-time small; a console call is acceptable here).
    try {
      process.stderr.write(`P2P: ${P2P_RUN_STATE_DIR_ENV}=${override} rejected (must be under HOME or TMP); falling back to ${defaultDir}\n`);
    } catch { /* ignore */ }
    return defaultDir;
  }
  return candidate;
}

function persistedIdentityPath(runId: string): string {
  return path.join(resolveRunStateDir(), runId, 'identity.json');
}

async function persistFrozenIdentity(runId: string, identity: P2pFrozenArtifactIdentity): Promise<void> {
  const filePath = persistedIdentityPath(runId);
  const dir = path.dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
    // R3 v2 PR-ζ (B2) — tmp filename includes pid + monotonic timestamp +
    // random suffix so two concurrent `recordFrozenIdentity` calls for
    // the SAME `runId` never write to the same tmp path. Without this
    // the writeFile sequences could interleave, producing a corrupted
    // JSON that survives `rename(tmp, filePath)` and pollutes future
    // rehydrate. Random suffix protects against same-millisecond clashes.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    const payload = JSON.stringify({ schemaVersion: PERSISTED_IDENTITY_SCHEMA_VERSION, identity }, null, 2);
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, filePath);
  } catch {
    // Persistence is best-effort; daemon retry will simply re-attempt
    // freeze. The in-memory identity is still set for the current
    // process. Surface via debug-level logging in the caller if needed.
  }
}

/**
 * Set + persist in one call. Persistence runs fire-and-forget (no await
 * blocking the caller) but the in-memory map is updated synchronously so
 * the very next call to `getFrozenP2pArtifactIdentity` sees the new
 * value. Used everywhere `frozenIdentities.set` was previously called.
 */
function recordFrozenIdentity(runId: string, identity: P2pFrozenArtifactIdentity): void {
  frozenIdentities.set(runId, identity);
  // Fire and forget — persistence is best-effort and doesn't gate the
  // current process's freeze decision.
  void persistFrozenIdentity(runId, identity);
}

/**
 * R3 v2 PR-ζ (A2 / O4) — Clear in-memory + on-disk identity for `runId`.
 * Called by the orchestrator's terminal cleanup hook (60s after run
 * transition), so completed/failed/cancelled runs no longer leak
 * `~/.imcodes/runs/<runId>/` directories on disk OR `frozenIdentities`
 * entries in memory.
 *
 * Best-effort: any IO failure is swallowed — the next daemon startup's
 * rehydrate will re-validate / TTL-evict whatever survived.
 */
export async function clearPersistedFrozenP2pArtifactIdentity(runId: string): Promise<void> {
  frozenIdentities.delete(runId);
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return; // refuse path-traversal-shaped ids
  const dir = path.join(resolveRunStateDir(), runId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Scan `~/.imcodes/runs/*` and rehydrate the in-memory `frozenIdentities`
 * map. Should be invoked once at daemon startup BEFORE any P2P launch is
 * accepted so an in-flight run picked up after restart finds its existing
 * frozen identity instead of producing a fresh slug suffix. Best-effort:
 * malformed entries are skipped silently. Returns the number of
 * identities loaded.
 */
/**
 * R3 v2 PR-ζ (A2 / A3 / A4 / B3 / O5) — Hardened rehydrate.
 *
 * Five new defenses on top of v1b's basic shape check:
 *   1. **Symlink rejection**: top-level `<runId>/` entries that resolve via
 *      symlink are skipped (defends against attacker-placed link to
 *      `/etc/...` etc).
 *   2. **Path re-validation**: every `openspecArtifactPaths` entry runs
 *      through `validateP2pArtifactRelativePath` against `repoRoot` (when
 *      provided). Entries failing validation are dropped.
 *   3. **Count cap**: caps total loaded identities at 500. Excess entries
 *      are skipped with a single warning so a runaway daemon-state dir
 *      doesn't choke startup.
 *   4. **TTL eviction**: entries with `mtime` older than 7d are unlinked
 *      synchronously (best-effort) so daemon-state dir self-prunes.
 *   5. **`.tmp` orphan cleanup**: any `*.tmp` siblings of `identity.json`
 *      get unlinked at startup so failed atomic writes don't leak.
 *
 * `args.repoRoot` (optional, DEC-O5) — when supplied, identities whose
 * `openspecChangePath` is NOT inside `repoRoot` are dropped with a
 * `legacy_identity_repo_root_mismatch` log line. Allows daemon to safely
 * pick up sessions across project switches.
 */
export interface LoadPersistedIdentitiesArgs {
  repoRoot?: string;
}
const PERSISTED_IDENTITY_MAX_COUNT = 500 as const;
const PERSISTED_IDENTITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadPersistedFrozenP2pArtifactIdentities(args: LoadPersistedIdentitiesArgs = {}): Promise<number> {
  const dir = resolveRunStateDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let loaded = 0;
  let countCapped = false;
  for (const entry of entries) {
    if (loaded >= PERSISTED_IDENTITY_MAX_COUNT) {
      countCapped = true;
      break;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(entry)) continue;
    const entryDir = path.join(dir, entry);
    // Defense 1 — reject symlinked top-level entries.
    let entryStat;
    try { entryStat = await lstat(entryDir); } catch { continue; }
    if (entryStat.isSymbolicLink()) {
      try { process.stderr.write(`P2P: skipping symlink run-state entry ${entryDir}\n`); } catch { /* ignore */ }
      continue;
    }
    if (!entryStat.isDirectory()) continue;
    // Defense 5 — sweep .tmp siblings.
    try {
      const siblings = await readdir(entryDir);
      for (const sibling of siblings) {
        if (sibling.endsWith('.tmp')) {
          await unlink(path.join(entryDir, sibling)).catch(() => {});
        }
      }
    } catch { /* ignore */ }
    const filePath = path.join(entryDir, 'identity.json');
    let fileStat;
    try { fileStat = await lstat(filePath); } catch { continue; }
    // Defense 4 — TTL eviction.
    if (Date.now() - fileStat.mtimeMs > PERSISTED_IDENTITY_MAX_AGE_MS) {
      await rm(entryDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const obj = parsed as { schemaVersion?: unknown; identity?: P2pFrozenArtifactIdentity };
      if (obj.schemaVersion !== PERSISTED_IDENTITY_SCHEMA_VERSION) continue;
      if (!obj.identity || typeof obj.identity !== 'object') continue;
      if (!Array.isArray(obj.identity.openspecArtifactPaths)) continue;
      // Defense 2 — re-validate every declared path.
      let allPathsValid = true;
      if (args.repoRoot) {
        for (const declared of obj.identity.openspecArtifactPaths) {
          if (typeof declared !== 'string') { allPathsValid = false; break; }
          const lex = validateP2pArtifactRelativePath(declared, 'identity.openspecArtifactPaths');
          if (!lex.ok) { allPathsValid = false; break; }
        }
      }
      if (!allPathsValid) {
        try { process.stderr.write(`P2P: dropping persisted identity ${entry} — invalid declared path\n`); } catch { /* ignore */ }
        continue;
      }
      // Defense O5 — repoRoot containment for openspecChangePath.
      if (args.repoRoot && obj.identity.openspecChangePath) {
        const lex = validateP2pArtifactRelativePath(obj.identity.openspecChangePath, 'identity.openspecChangePath');
        if (!lex.ok) {
          try { process.stderr.write(`P2P: legacy_identity_repo_root_mismatch ${entry} — openspecChangePath rejected\n`); } catch { /* ignore */ }
          continue;
        }
      }
      frozenIdentities.set(entry, obj.identity);
      loaded += 1;
    } catch {
      // Skip malformed entry; daemon will re-freeze on next launch.
    }
  }
  if (countCapped) {
    try { process.stderr.write(`P2P: loadPersistedFrozenP2pArtifactIdentities count cap reached (${PERSISTED_IDENTITY_MAX_COUNT}); remaining entries skipped\n`); } catch { /* ignore */ }
  }
  return loaded;
}

export async function freezeP2pArtifactIdentity(args: P2pArtifactFreezeArgs): Promise<P2pFrozenArtifactIdentity> {
  const existing = frozenIdentities.get(args.runId);
  if (existing) return existing;

  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const { contract, repoRoot, runId } = args;

  if (contract.convention === 'explicit_paths') {
    const validatedPaths: string[] = [];
    for (const [index, declaredPath] of contract.paths.entries()) {
      const result = await validateP2pArtifactRuntimePath({
        repoRoot,
        relativePath: declaredPath,
        phase: 'freeze',
        symlinkPolicy: contract.symlinkPolicy,
      });
      if (!result.ok) {
        const identity: P2pFrozenArtifactIdentity = {
          convention: contract.convention,
          openspecArtifactPaths: [],
          frozenAt: new Date().toISOString(),
          collisionResolved: false,
          diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            fieldPath: diagnostic.fieldPath ?? `artifact.paths[${index}]`,
          })),
        };
        recordFrozenIdentity(runId, identity);
        return identity;
      }
      validatedPaths.push(declaredPath);
    }
    const identity: P2pFrozenArtifactIdentity = {
      convention: contract.convention,
      openspecArtifactPaths: validatedPaths,
      frozenAt: new Date().toISOString(),
      collisionResolved: false,
      diagnostics,
    };
    recordFrozenIdentity(runId, identity);
    return identity;
  }

  if (contract.convention === 'openspec_convention') {
    const baseSlug = deriveOpenspecSlug(args);
    if (!baseSlug) {
      const identity: P2pFrozenArtifactIdentity = {
        convention: contract.convention,
        openspecArtifactPaths: [],
        frozenAt: new Date().toISOString(),
        collisionResolved: false,
        diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', {
          fieldPath: 'artifact.openspecChangePath',
          summary: 'OpenSpec convention requires a derivable change slug.',
        })],
      };
      recordFrozenIdentity(runId, identity);
      return identity;
    }

    const freezeResult = await freezeOpenspecChangeDirectory({
      repoRoot,
      baseSlug,
      symlinkPolicy: contract.symlinkPolicy,
    });
    if (!freezeResult.ok) {
      const identity: P2pFrozenArtifactIdentity = {
        convention: contract.convention,
        openspecArtifactPaths: [],
        frozenAt: new Date().toISOString(),
        collisionResolved: false,
        diagnostics: freezeResult.diagnostics,
      };
      recordFrozenIdentity(runId, identity);
      return identity;
    }

    if (freezeResult.collisionResolved) {
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_identity_collision_resolved', 'bind', {
        fieldPath: 'artifact.openspecChangeSlug',
        summary: `Slug "${baseSlug}" collided; resolved as "${freezeResult.slug}".`,
      }));
    }

    const declaredArtifacts = contract.paths.length > 0 ? contract.paths : [];
    const artifactRoot = `openspec/changes/${freezeResult.slug}`;
    const openspecArtifactPaths = declaredArtifacts.length > 0
      ? declaredArtifacts.map((rel) => joinUnderArtifactRoot(artifactRoot, rel))
      : [artifactRoot];

    const identity: P2pFrozenArtifactIdentity = {
      convention: contract.convention,
      openspecChangeSlug: freezeResult.slug,
      openspecChangePath: artifactRoot,
      openspecArtifactPaths,
      frozenAt: new Date().toISOString(),
      collisionResolved: freezeResult.collisionResolved,
      diagnostics,
    };
    recordFrozenIdentity(runId, identity);
    return identity;
  }

  // convention: 'none' — nothing to freeze; reuse the input contract paths
  const identity: P2pFrozenArtifactIdentity = {
    convention: contract.convention,
    openspecArtifactPaths: [...contract.paths],
    frozenAt: new Date().toISOString(),
    collisionResolved: false,
    diagnostics,
  };
  recordFrozenIdentity(runId, identity);
  return identity;
}

function deriveOpenspecSlug(args: P2pArtifactFreezeArgs): string | null {
  const explicitPath = args.openspecChangePath ?? args.contract.paths.find((value) => value.startsWith('openspec/changes/'));
  if (explicitPath) {
    const segments = explicitPath.split('/').filter(Boolean);
    const idx = segments.findIndex((segment) => segment === 'changes');
    if (idx >= 0 && segments[idx + 1]) {
      const candidate = sanitizeSlug(segments[idx + 1]);
      if (candidate) return candidate;
    }
  }
  if (args.inferredSlug) {
    const candidate = sanitizeSlug(args.inferredSlug);
    if (candidate) return candidate;
  }
  return null;
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

interface OpenspecFreezeResult {
  ok: true;
  slug: string;
  absolutePath: string;
  collisionResolved: boolean;
}

interface OpenspecFreezeFailure {
  ok: false;
  diagnostics: P2pWorkflowDiagnostic[];
}

async function freezeOpenspecChangeDirectory(args: {
  repoRoot: string;
  baseSlug: string;
  symlinkPolicy?: 'reject_all' | 'allow_existing_under_root';
}): Promise<OpenspecFreezeResult | OpenspecFreezeFailure> {
  if (!SLUG_PATTERN.test(args.baseSlug)) {
    return {
      ok: false,
      diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', {
        fieldPath: 'artifact.openspecChangeSlug',
        summary: `Slug "${args.baseSlug}" did not normalize to [a-z0-9-]+.`,
      })],
    };
  }

  // Make sure openspec/changes/ exists (recursive) before atomic mkdir.
  const changesParent = path.join(args.repoRoot, 'openspec', 'changes');
  await mkdir(changesParent, { recursive: true });

  for (let attempt = 0; attempt < COLLISION_SUFFIX_CAP; attempt += 1) {
    const candidate = attempt === 0 ? args.baseSlug : `${args.baseSlug}-${attempt + 1}`;
    const relativePath = `openspec/changes/${candidate}`;
    const lexical = validateP2pArtifactRelativePath(relativePath, 'artifact.openspecChangePath');
    if (!lexical.ok) return { ok: false, diagnostics: lexical.diagnostics };

    const validation = await validateP2pArtifactRuntimePath({
      repoRoot: args.repoRoot,
      relativePath,
      phase: 'freeze',
      symlinkPolicy: args.symlinkPolicy,
    });
    if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };

    const absolutePath = path.join(args.repoRoot, relativePath);
    try {
      await mkdir(absolutePath, { recursive: false });
      return {
        ok: true,
        slug: candidate,
        absolutePath,
        collisionResolved: attempt > 0,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      return {
        ok: false,
        diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', {
          fieldPath: 'artifact.openspecChangePath',
          summary: `mkdir failed: ${code ?? 'unknown'}.`,
        })],
      };
    }
  }

  return {
    ok: false,
    diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', {
      fieldPath: 'artifact.openspecChangeSlug',
      summary: `Could not allocate a non-colliding slug after ${COLLISION_SUFFIX_CAP} attempts.`,
    })],
  };
}

function joinUnderArtifactRoot(root: string, relative: string): string {
  if (relative.startsWith(`${root}/`) || relative === root) return relative;
  return `${root}/${relative}`.replace(/\/+/g, '/');
}

// ──────────────────────────────────────────────────────────────────────────
// New-file sandbox (task 6.5 / 6.6)
// ──────────────────────────────────────────────────────────────────────────

export interface P2pCreateArtifactPathOptions {
  repoRoot: string;
  relativePath: string;
  phase?: P2pArtifactRuntimePhase;
  symlinkPolicy?: 'reject_all' | 'allow_existing_under_root';
  artifactRoot?: string;
}

export type P2pCreateArtifactPathResult =
  | { ok: true; absolutePath: string; finalRealPath: string; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

/**
 * Create a placeholder file or directory under the artifact sandbox. The
 * relative path may end with a trailing `/` to indicate a directory create.
 *
 * The full sandbox algorithm:
 *   1. lexical-validate the relative path
 *   2. find nearest existing ancestor + lstat each segment (via
 *      `validateP2pArtifactRuntimePath` with the phase-specific symlink policy)
 *   3. `mkdir(parent, { recursive: true })` then `writeFile('')` (file)
 *      or `mkdir(path)` (directory)
 *   4. post-create realpath verify final path under repoRoot AND artifactRoot
 */
export async function createP2pArtifactPath(
  options: P2pCreateArtifactPathOptions,
): Promise<P2pCreateArtifactPathResult> {
  const phase = options.phase ?? 'create';
  const isDirectory = options.relativePath.endsWith('/');
  const trimmedRelativePath = isDirectory
    ? options.relativePath.replace(/\/+$/, '')
    : options.relativePath;

  if (trimmedRelativePath !== options.relativePath && trimmedRelativePath === '') {
    return { ok: false, diagnostics: invalidArtifactPath('artifact.path', 'Empty path after trimming trailing slash.').diagnostics };
  }

  const validation = await validateP2pArtifactRuntimePath({
    repoRoot: options.repoRoot,
    relativePath: trimmedRelativePath,
    phase,
    symlinkPolicy: options.symlinkPolicy,
    artifactRoot: options.artifactRoot,
  });
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };

  const absolutePath = validation.absolutePath;

  try {
    if (isDirectory) {
      await mkdir(absolutePath, { recursive: true });
    } else {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '', { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return; // honor preexisting placeholder
        throw error;
      });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return { ok: false, diagnostics: invalidArtifactPath(trimmedRelativePath, `Artifact create failed: ${code}.`).diagnostics };
  }

  const finalRealPath = await realpath(absolutePath).catch(() => null);
  if (!finalRealPath || !isPathInside(validation.repoRootRealPath, finalRealPath)) {
    return { ok: false, diagnostics: invalidArtifactPath(trimmedRelativePath, 'Created artifact realpath escapes repo root.').diagnostics };
  }
  if (options.artifactRoot) {
    const artifactRootRealPath = await realpath(options.artifactRoot).catch(() => null);
    if (!artifactRootRealPath || !isPathInside(artifactRootRealPath, finalRealPath)) {
      return { ok: false, diagnostics: invalidArtifactPath(trimmedRelativePath, 'Created artifact realpath escapes declared artifact root.').diagnostics };
    }
  }

  return { ok: true, absolutePath, finalRealPath, diagnostics: [] };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-file baselines + caps (tasks 6.7 / 6.8)
// ──────────────────────────────────────────────────────────────────────────

export interface P2pArtifactBaselineFile {
  relativePath: string;
  size: number;
  sha256: string;
  type: 'file' | 'directory';
}

export interface P2pArtifactBaseline {
  rootPath: string;
  files: P2pArtifactBaselineFile[];
  capturedAt: string;
  truncated: boolean;
}

export interface P2pArtifactBaselineCaptureArgs {
  rootPath: string;
  repoRoot: string;
  phase: 'baseline' | 'validate';
  symlinkPolicy?: 'reject_all' | 'allow_existing_under_root';
}

export interface P2pArtifactBaselineCaptureResult {
  baseline: P2pArtifactBaseline;
  diagnostics: P2pWorkflowDiagnostic[];
}

/**
 * Capture a per-file baseline rooted at `rootPath` (repo-relative). Caps are
 * enforced via `P2P_WORKFLOW_ARTIFACT_MAX_*`. When a cap is exceeded the walker
 * stops, sets `truncated: true`, and emits an `artifact_baseline_too_large`
 * diagnostic. Per-file overflow (>8 MiB) is skipped with a per-file diagnostic
 * but the walk continues.
 */
export async function captureP2pArtifactBaseline(
  args: P2pArtifactBaselineCaptureArgs,
): Promise<P2pArtifactBaselineCaptureResult> {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const baseline: P2pArtifactBaseline = {
    rootPath: args.rootPath,
    files: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  };

  const validation = await validateP2pArtifactRuntimePath({
    repoRoot: args.repoRoot,
    relativePath: args.rootPath,
    phase: args.phase,
    symlinkPolicy: args.symlinkPolicy,
  });
  if (!validation.ok) {
    return { baseline, diagnostics: validation.diagnostics };
  }

  const rootAbsolute = validation.absolutePath;
  const rootStat = await lstat(rootAbsolute).catch(() => null);
  if (!rootStat) {
    // Empty baseline is allowed — used for "no files yet" pre-state.
    return { baseline, diagnostics };
  }

  const queue: Array<{ absolute: string; relative: string }> = [];
  if (rootStat.isDirectory()) {
    queue.push({ absolute: rootAbsolute, relative: '' });
  } else if (rootStat.isFile()) {
    const fileEntry = await captureFileEntry(rootAbsolute, args.rootPath, args, diagnostics);
    if (fileEntry) baseline.files.push(fileEntry);
    return { baseline, diagnostics };
  } else if (rootStat.isSymbolicLink() && args.symlinkPolicy !== 'allow_existing_under_root') {
    diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', {
      fieldPath: args.rootPath,
      summary: 'Symlink baseline root rejected for this phase.',
    }));
    return { baseline, diagnostics };
  } else {
    return { baseline, diagnostics };
  }

  let totalBytes = 0;
  while (queue.length > 0) {
    const item = queue.shift()!;
    let entries: Array<{ name: string }>;
    try {
      entries = (await readdir(item.absolute, { withFileTypes: true })) as Array<{ name: string }>;
    } catch {
      continue;
    }
    // Sort entries to keep traversal deterministic.
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    for (const entry of entries) {
      const entryName = String(entry.name);
      const childRelative = item.relative ? `${item.relative}/${entryName}` : entryName;
      const childAbsolute = path.join(item.absolute, entryName);
      const fullRelative = `${args.rootPath}/${childRelative}`;

      // Depth cap (slash-count from rootPath = depth of the child relative
      // to the root). depth==0 == direct children; cap at MAX_DEPTH.
      const childDepth = childRelative.split('/').length;
      if (childDepth > P2P_WORKFLOW_ARTIFACT_MAX_DEPTH) {
        baseline.truncated = true;
        diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
          fieldPath: fullRelative,
          summary: `Baseline depth exceeds cap (${childDepth}/${P2P_WORKFLOW_ARTIFACT_MAX_DEPTH}).`,
        }));
        return { baseline, diagnostics };
      }

      let stat;
      try {
        stat = await lstat(childAbsolute);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        if (args.symlinkPolicy !== 'allow_existing_under_root') {
          // Skip symlinks (don't include in baseline).
          continue;
        }
        const resolved = await realpath(childAbsolute).catch(() => null);
        if (!resolved || !isPathInside(validation.repoRootRealPath, resolved)) continue;
      }

      if (stat.isDirectory()) {
        if (baseline.files.length >= P2P_WORKFLOW_ARTIFACT_MAX_FILES) {
          baseline.truncated = true;
          diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
            fieldPath: args.rootPath,
            summary: `Baseline file count exceeds cap (${P2P_WORKFLOW_ARTIFACT_MAX_FILES}).`,
          }));
          return { baseline, diagnostics };
        }
        baseline.files.push({
          relativePath: fullRelative,
          size: 0,
          sha256: '',
          type: 'directory',
        });
        queue.push({ absolute: childAbsolute, relative: childRelative });
        continue;
      }

      if (!stat.isFile()) continue;

      // File-count cap.
      if (baseline.files.length >= P2P_WORKFLOW_ARTIFACT_MAX_FILES) {
        baseline.truncated = true;
        diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
          fieldPath: args.rootPath,
          summary: `Baseline file count exceeds cap (${P2P_WORKFLOW_ARTIFACT_MAX_FILES}).`,
        }));
        return { baseline, diagnostics };
      }

      // Per-file size cap.
      if (stat.size > P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES) {
        diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
          fieldPath: fullRelative,
          summary: `File exceeds per-file cap (${stat.size}/${P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES}).`,
        }));
        continue;
      }

      // Total-bytes cap (predictive — refuse to read if it would push us over).
      if (totalBytes + stat.size > P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES) {
        baseline.truncated = true;
        diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
          fieldPath: args.rootPath,
          summary: `Baseline total bytes would exceed cap (${totalBytes + stat.size}/${P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES}).`,
        }));
        return { baseline, diagnostics };
      }

      let contents: Buffer;
      try {
        contents = await readFile(childAbsolute);
      } catch {
        continue;
      }

      const sha256 = createHash('sha256').update(contents).digest('hex');
      baseline.files.push({
        relativePath: fullRelative,
        size: stat.size,
        sha256,
        type: 'file',
      });
      totalBytes += stat.size;
    }
  }

  // Sort files for stable equality / hash.
  baseline.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { baseline, diagnostics };
}

async function captureFileEntry(
  absolute: string,
  relativePath: string,
  args: P2pArtifactBaselineCaptureArgs,
  diagnostics: P2pWorkflowDiagnostic[],
): Promise<P2pArtifactBaselineFile | null> {
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() && args.symlinkPolicy !== 'allow_existing_under_root') return null;
  if (!stat.isFile()) return null;

  if (stat.size > P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
      fieldPath: relativePath,
      summary: `File exceeds per-file cap (${stat.size}/${P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES}).`,
    }));
    return null;
  }

  let contents: Buffer;
  try {
    contents = await readFile(absolute);
  } catch {
    return null;
  }
  const sha256 = createHash('sha256').update(contents).digest('hex');
  return { relativePath, size: stat.size, sha256, type: 'file' };
}

/**
 * Compare baselines for equality, EXCLUDING `capturedAt` (the timestamp is
 * intentionally excluded from contract success per task 6.7 / spec).
 */
export function p2pArtifactBaselinesEqual(a: P2pArtifactBaseline, b: P2pArtifactBaseline): boolean {
  if (a.rootPath !== b.rootPath) return false;
  if (a.truncated !== b.truncated) return false;
  if (a.files.length !== b.files.length) return false;
  const left = [...a.files].sort((x, y) => x.relativePath.localeCompare(y.relativePath));
  const right = [...b.files].sort((x, y) => x.relativePath.localeCompare(y.relativePath));
  for (let i = 0; i < left.length; i += 1) {
    const lf = left[i];
    const rf = right[i];
    if (lf.relativePath !== rf.relativePath) return false;
    if (lf.size !== rf.size) return false;
    if (lf.sha256 !== rf.sha256) return false;
    if (lf.type !== rf.type) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Baseline delta verification (task 6.9 — forbid the dir-listing heuristic)
// ──────────────────────────────────────────────────────────────────────────

export interface P2pArtifactBaselineDeltaResult {
  ok: boolean;
  diagnostics: P2pWorkflowDiagnostic[];
}

/**
 * Verify that every declared `relativePath` in `declaredFiles` either:
 *   - exists in `after.files` AND has a different sha256 than the same path
 *     in `before.files`, OR
 *   - is added (was absent in `before` and present in `after`).
 *
 * Files NOT in the declared set are ignored — broad directory listing changes
 * never satisfy a contract per spec §"Artifact Baselines and Validation".
 *
 * NOTE: this helper deliberately does NOT use `before.files.length !==
 * after.files.length` as a success criterion (that would let a sibling change
 * masquerade as a declared-file change), and the surrounding daemon code
 * deliberately does NOT use `broad directory listing` (forbidden by reverse-regression
 * guard #5).
 */
export function verifyP2pArtifactBaselineDelta(
  before: P2pArtifactBaseline,
  after: P2pArtifactBaseline,
  declaredFiles: Array<{ relativePath: string }>,
): P2pArtifactBaselineDeltaResult {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const beforeByPath = new Map(before.files.map((file) => [file.relativePath, file] as const));
  const afterByPath = new Map(after.files.map((file) => [file.relativePath, file] as const));

  let ok = declaredFiles.length > 0;
  for (const declared of declaredFiles) {
    const afterFile = afterByPath.get(declared.relativePath);
    if (!afterFile) {
      ok = false;
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_contract_not_satisfied', 'execute', {
        fieldPath: declared.relativePath,
        summary: 'Declared artifact path missing after run.',
      }));
      continue;
    }
    const beforeFile = beforeByPath.get(declared.relativePath);
    if (beforeFile && beforeFile.sha256 === afterFile.sha256) {
      ok = false;
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', {
        fieldPath: declared.relativePath,
        summary: 'Declared artifact path unchanged (sha256 identical).',
      }));
    }
  }
  return { ok, diagnostics };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function invalidArtifactPath(fieldPath: string, summary?: string): P2pArtifactRuntimePathResult {
  return {
    ok: false,
    diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', { fieldPath, summary })],
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
