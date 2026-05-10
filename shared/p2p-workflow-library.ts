/**
 * R3 v2 PR-ι — Workflow library helpers.
 *
 * The `P2pSavedConfig` data model now carries a multi-entry workflow
 * library (`workflowLibrary: P2pWorkflowDraft[]`) plus an
 * `activeWorkflowId` selector. Both fields are optional so legacy configs
 * (single `workflowDraft` only) continue to load — the resolution rules
 * for "which workflow does the launch path see?" live here so they cannot
 * drift between the UI (`P2pConfigPanel`) and the launch envelope builder
 * (`buildP2pWorkflowLaunchEnvelopeFromConfig`).
 *
 * Resolution order (most → least preferred):
 *   1. `workflowLibrary` entry whose `id` matches `activeWorkflowId`
 *   2. First entry of `workflowLibrary` (when set but no active match)
 *   3. Legacy `workflowDraft` field (pre-PR-ι configs)
 *   4. `null` (no workflow configured)
 *
 * Migration is one-way and idempotent: if a config has a legacy
 * `workflowDraft` but no `workflowLibrary`, `migrateLegacyWorkflowDraft`
 * lifts the draft into a single-entry library and points
 * `activeWorkflowId` at it. Saving the migrated config persists the new
 * shape; the legacy field is preserved so older clients don't lose data
 * mid-rollout.
 */

import {
  P2P_WORKFLOW_LIBRARY_MAX_ENTRIES,
  P2P_WORKFLOW_TITLE_MAX_BYTES,
} from './p2p-workflow-constants.js';
import type { P2pSavedConfig } from './p2p-modes.js';
import type { P2pWorkflowDraft } from './p2p-workflow-types.js';

/**
 * Re-exported caps so call sites import them from one place.
 */
export { P2P_WORKFLOW_LIBRARY_MAX_ENTRIES, P2P_WORKFLOW_TITLE_MAX_BYTES };

/**
 * Default title applied to a brand-new draft when the user has not yet
 * named it. Surfaced through i18n in the UI; this raw English string is
 * the storage-side fallback so the launch envelope and reverse-regression
 * suite never see an empty title.
 */
export const P2P_WORKFLOW_DEFAULT_TITLE = 'Untitled workflow';

/**
 * Generate a stable, sufficiently-unique draft id. We avoid `crypto.randomUUID`
 * because this module is also imported by the daemon's CommonJS-flavoured
 * test harness; a millis+random prefix is sufficient for an in-config id
 * (which is namespaced to the user's saved config — not a global identifier).
 */
export function generateWorkflowDraftId(): string {
  const millis = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `wf_${millis}_${rand}`;
}

/**
 * Truncate a candidate title to the configured byte budget, with a clean
 * UTF-8 cut (never leaving a partial surrogate). Empty / whitespace-only
 * input falls back to the default title.
 */
export function clampWorkflowTitle(input: unknown): string {
  if (typeof input !== 'string') return P2P_WORKFLOW_DEFAULT_TITLE;
  const trimmed = input.trim();
  if (trimmed.length === 0) return P2P_WORKFLOW_DEFAULT_TITLE;
  // Fast path: ASCII-only titles below the cap need no encoding round-trip.
  if (trimmed.length <= P2P_WORKFLOW_TITLE_MAX_BYTES) {
    const encoded = new TextEncoder().encode(trimmed);
    if (encoded.byteLength <= P2P_WORKFLOW_TITLE_MAX_BYTES) return trimmed;
  }
  // Slow path: trim characters until under budget. We use the spread
  // iterator so multi-byte characters are removed atomically.
  const chars = [...trimmed];
  while (chars.length > 0) {
    const candidate = chars.join('');
    if (new TextEncoder().encode(candidate).byteLength <= P2P_WORKFLOW_TITLE_MAX_BYTES) {
      return candidate;
    }
    chars.pop();
  }
  return P2P_WORKFLOW_DEFAULT_TITLE;
}

/**
 * Defensive deep-clone helper. Workflow drafts are JSON-serialisable so a
 * structuredClone-via-JSON round-trip is sufficient. We avoid the global
 * `structuredClone` so this module compiles under both Node and the
 * browser bundle without polyfill assumptions.
 */
function cloneDraft(draft: P2pWorkflowDraft): P2pWorkflowDraft {
  return JSON.parse(JSON.stringify(draft)) as P2pWorkflowDraft;
}

/**
 * Normalize a candidate `workflowLibrary` array — drop entries that are
 * obviously malformed, dedupe ids (later entries win), enforce the entry
 * cap, and clamp every title. Returns a shallow new array that is safe to
 * write back into a `P2pSavedConfig` without mutating the caller's input.
 */
export function normalizeWorkflowLibrary(input: unknown): P2pWorkflowDraft[] {
  if (!Array.isArray(input)) return [];
  const seen = new Map<string, P2pWorkflowDraft>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Partial<P2pWorkflowDraft> & { id?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue;
    if (typeof candidate.schemaVersion !== 'number') continue;
    if (!Array.isArray(candidate.nodes)) continue;
    if (!Array.isArray(candidate.edges)) continue;
    const cloned = cloneDraft(candidate as P2pWorkflowDraft);
    cloned.title = clampWorkflowTitle(cloned.title);
    seen.set(cloned.id, cloned);
  }
  return [...seen.values()].slice(0, P2P_WORKFLOW_LIBRARY_MAX_ENTRIES);
}

/**
 * Lift a legacy `workflowDraft` into a single-entry library when the
 * config has no `workflowLibrary` yet. Idempotent — does nothing when a
 * library is already present (even if empty, which signals an
 * intentionally-cleared library).
 *
 * Returns a NEW config object with the migrated shape; the input is left
 * untouched so callers can decide whether to persist the migration.
 */
export function migrateLegacyWorkflowDraft(config: P2pSavedConfig): P2pSavedConfig {
  if (config.workflowLibrary !== undefined) return config;
  if (!config.workflowDraft) return config;
  const lifted: P2pWorkflowDraft = {
    ...cloneDraft(config.workflowDraft),
    title: clampWorkflowTitle(config.workflowDraft.title),
  };
  return {
    ...config,
    workflowLibrary: [lifted],
    activeWorkflowId: lifted.id,
  };
}

/**
 * Single-source-of-truth resolution for "which workflow draft is currently
 * active?" — used by both UI rendering and the launch envelope builder so
 * the two paths cannot diverge.
 *
 * Returns `null` when the config has no workflow at all.
 */
export function getActiveWorkflowFromConfig(config: P2pSavedConfig): P2pWorkflowDraft | null {
  const library = config.workflowLibrary;
  if (Array.isArray(library) && library.length > 0) {
    if (config.activeWorkflowId) {
      const match = library.find((entry) => entry.id === config.activeWorkflowId);
      if (match) return match;
    }
    return library[0] ?? null;
  }
  return config.workflowDraft ?? null;
}

/**
 * Replace the active workflow in a config with `next`, allocating a fresh
 * library when the config has none yet. Returns a new config — the input
 * is not mutated.
 */
export function replaceActiveWorkflowInConfig(
  config: P2pSavedConfig,
  next: P2pWorkflowDraft,
): P2pSavedConfig {
  const cloned = cloneDraft(next);
  cloned.title = clampWorkflowTitle(cloned.title);
  const baseLibrary = Array.isArray(config.workflowLibrary)
    ? config.workflowLibrary
    : (config.workflowDraft ? [config.workflowDraft] : []);
  const activeId = config.activeWorkflowId
    ?? (baseLibrary[0]?.id ?? cloned.id);
  let placed = false;
  const nextLibrary = baseLibrary.map((entry) => {
    if (entry.id === activeId) {
      placed = true;
      return { ...cloned, id: entry.id };
    }
    return entry;
  });
  if (!placed) {
    nextLibrary.push(cloned);
  }
  return {
    ...config,
    workflowLibrary: normalizeWorkflowLibrary(nextLibrary),
    activeWorkflowId: placed ? activeId : cloned.id,
  };
}

/**
 * Add a new draft to the library, returning the updated config. When the
 * library would exceed `P2P_WORKFLOW_LIBRARY_MAX_ENTRIES` the input is
 * returned unchanged so callers can surface a UI error.
 */
export function addWorkflowToLibrary(
  config: P2pSavedConfig,
  draft: P2pWorkflowDraft,
  options: { activate?: boolean } = {},
): P2pSavedConfig {
  const library = Array.isArray(config.workflowLibrary)
    ? [...config.workflowLibrary]
    : (config.workflowDraft ? [config.workflowDraft] : []);
  if (library.length >= P2P_WORKFLOW_LIBRARY_MAX_ENTRIES) return config;
  const cloned = cloneDraft(draft);
  cloned.title = clampWorkflowTitle(cloned.title);
  // Ensure the new id is unique — bump with a suffix on collision.
  let candidateId = cloned.id;
  if (!candidateId || library.some((entry) => entry.id === candidateId)) {
    candidateId = generateWorkflowDraftId();
    while (library.some((entry) => entry.id === candidateId)) {
      candidateId = generateWorkflowDraftId();
    }
  }
  cloned.id = candidateId;
  library.push(cloned);
  return {
    ...config,
    workflowLibrary: normalizeWorkflowLibrary(library),
    activeWorkflowId: options.activate ? cloned.id : (config.activeWorkflowId ?? cloned.id),
  };
}

/**
 * Remove a workflow from the library. If the removed entry was active,
 * promote the first remaining entry as the new active id (or unset when
 * the library is now empty).
 */
export function removeWorkflowFromLibrary(
  config: P2pSavedConfig,
  workflowId: string,
): P2pSavedConfig {
  const library = Array.isArray(config.workflowLibrary)
    ? config.workflowLibrary.filter((entry) => entry.id !== workflowId)
    : [];
  const wasActive = config.activeWorkflowId === workflowId;
  return {
    ...config,
    workflowLibrary: normalizeWorkflowLibrary(library),
    activeWorkflowId: wasActive ? (library[0]?.id ?? undefined) : config.activeWorkflowId,
  };
}

/**
 * Duplicate an existing draft into the library with a fresh id and a
 * title suffix (" (copy)"). When the library is at capacity the input is
 * returned unchanged.
 */
export function duplicateWorkflowInLibrary(
  config: P2pSavedConfig,
  workflowId: string,
  copySuffix: string,
): P2pSavedConfig {
  const library = Array.isArray(config.workflowLibrary)
    ? config.workflowLibrary
    : (config.workflowDraft ? [config.workflowDraft] : []);
  const source = library.find((entry) => entry.id === workflowId);
  if (!source) return config;
  if (library.length >= P2P_WORKFLOW_LIBRARY_MAX_ENTRIES) return config;
  const copy = cloneDraft(source);
  copy.id = generateWorkflowDraftId();
  copy.title = clampWorkflowTitle(`${source.title ?? P2P_WORKFLOW_DEFAULT_TITLE}${copySuffix}`);
  return addWorkflowToLibrary(config, copy, { activate: true });
}
