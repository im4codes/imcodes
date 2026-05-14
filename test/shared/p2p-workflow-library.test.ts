/**
 * Tests for `shared/p2p-workflow-library.ts` — workflow library helpers
 * introduced by R3 v2 PR-ι. Locks the resolution rules for active
 * workflow / legacy migration / library mutators so the UI and the
 * launch-envelope builder cannot drift.
 */

import { describe, expect, it } from 'vitest';
import {
  P2P_WORKFLOW_DEFAULT_TITLE,
  P2P_WORKFLOW_LIBRARY_MAX_ENTRIES,
  P2P_WORKFLOW_TITLE_MAX_BYTES,
  addWorkflowToLibrary,
  clampWorkflowTitle,
  duplicateWorkflowInLibrary,
  generateWorkflowDraftId,
  getActiveWorkflowFromConfig,
  migrateLegacyWorkflowDraft,
  normalizeWorkflowLibrary,
  removeWorkflowFromLibrary,
  replaceActiveWorkflowInConfig,
} from '../../shared/p2p-workflow-library.js';
import { P2P_WORKFLOW_SCHEMA_VERSION } from '../../shared/p2p-workflow-constants.js';
import type { P2pSavedConfig } from '../../shared/p2p-modes.js';
import type { P2pWorkflowDraft } from '../../shared/p2p-workflow-types.js';

function makeDraft(id: string, title = `Draft ${id}`): P2pWorkflowDraft {
  return {
    schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    id,
    title,
    nodes: [
      { id: 'n1', title: 'Start', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
    ],
    edges: [],
    rootNodeId: 'n1',
  };
}

function makeConfig(overrides: Partial<P2pSavedConfig> = {}): P2pSavedConfig {
  return { sessions: {}, rounds: 1, ...overrides };
}

describe('clampWorkflowTitle', () => {
  it('returns the default for non-string / empty / whitespace input', () => {
    expect(clampWorkflowTitle(undefined)).toBe(P2P_WORKFLOW_DEFAULT_TITLE);
    expect(clampWorkflowTitle(null)).toBe(P2P_WORKFLOW_DEFAULT_TITLE);
    expect(clampWorkflowTitle(42)).toBe(P2P_WORKFLOW_DEFAULT_TITLE);
    expect(clampWorkflowTitle('   ')).toBe(P2P_WORKFLOW_DEFAULT_TITLE);
  });

  it('passes short ASCII titles through unchanged', () => {
    expect(clampWorkflowTitle('Audit + plan')).toBe('Audit + plan');
  });

  it('clamps over-budget multi-byte titles to the byte cap', () => {
    const huge = '工作流'.repeat(200);
    const clamped = clampWorkflowTitle(huge);
    expect(new TextEncoder().encode(clamped).byteLength).toBeLessThanOrEqual(P2P_WORKFLOW_TITLE_MAX_BYTES);
  });
});

describe('generateWorkflowDraftId', () => {
  it('produces ids with the wf_ prefix and is unique on consecutive calls', () => {
    const a = generateWorkflowDraftId();
    const b = generateWorkflowDraftId();
    expect(a.startsWith('wf_')).toBe(true);
    expect(b.startsWith('wf_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('normalizeWorkflowLibrary', () => {
  it('returns [] for non-array input', () => {
    expect(normalizeWorkflowLibrary(undefined)).toEqual([]);
    expect(normalizeWorkflowLibrary({})).toEqual([]);
    expect(normalizeWorkflowLibrary('hi')).toEqual([]);
  });

  it('drops malformed entries (missing id / schemaVersion / nodes / edges)', () => {
    const valid = makeDraft('a');
    const result = normalizeWorkflowLibrary([
      valid,
      null,
      { id: '' },
      { id: 'x', schemaVersion: 1 },
      { id: 'y', schemaVersion: 1, nodes: [] },
    ]);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('dedupes by id with last-wins semantics', () => {
    const first = makeDraft('a', 'first');
    const second = makeDraft('a', 'second');
    const result = normalizeWorkflowLibrary([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('second');
  });

  it('truncates the library to the max-entries cap', () => {
    const drafts = Array.from({ length: P2P_WORKFLOW_LIBRARY_MAX_ENTRIES + 5 }, (_, i) => makeDraft(`d${i}`));
    const result = normalizeWorkflowLibrary(drafts);
    expect(result).toHaveLength(P2P_WORKFLOW_LIBRARY_MAX_ENTRIES);
  });

  it('clamps each entry title', () => {
    const draft = makeDraft('a', 'x'.repeat(P2P_WORKFLOW_TITLE_MAX_BYTES + 100));
    const [out] = normalizeWorkflowLibrary([draft]);
    expect(new TextEncoder().encode(out.title!).byteLength).toBeLessThanOrEqual(P2P_WORKFLOW_TITLE_MAX_BYTES);
  });
});

describe('migrateLegacyWorkflowDraft', () => {
  it('lifts a legacy single workflowDraft into a single-entry library', () => {
    const draft = makeDraft('legacy', 'Legacy');
    const config = makeConfig({ workflowDraft: draft });
    const migrated = migrateLegacyWorkflowDraft(config);
    expect(migrated.workflowLibrary?.[0]?.id).toBe('legacy');
    expect(migrated.activeWorkflowId).toBe('legacy');
    // Legacy field is preserved (not destroyed) so older clients still see it.
    expect(migrated.workflowDraft?.id).toBe('legacy');
  });

  it('is a no-op when the library is already present', () => {
    const draft = makeDraft('a');
    const config = makeConfig({ workflowDraft: draft, workflowLibrary: [makeDraft('b')] });
    const migrated = migrateLegacyWorkflowDraft(config);
    expect(migrated).toBe(config);
  });

  it('is a no-op when no legacy draft exists', () => {
    const config = makeConfig();
    expect(migrateLegacyWorkflowDraft(config)).toBe(config);
  });
});

describe('getActiveWorkflowFromConfig', () => {
  it('returns the matching library entry by activeWorkflowId', () => {
    const a = makeDraft('a');
    const b = makeDraft('b');
    const cfg = makeConfig({ workflowLibrary: [a, b], activeWorkflowId: 'b' });
    expect(getActiveWorkflowFromConfig(cfg)?.id).toBe('b');
  });

  it('falls back to the first library entry when activeWorkflowId is missing', () => {
    const a = makeDraft('a');
    const b = makeDraft('b');
    const cfg = makeConfig({ workflowLibrary: [a, b] });
    expect(getActiveWorkflowFromConfig(cfg)?.id).toBe('a');
  });

  it('falls back to the first library entry when activeWorkflowId does not match', () => {
    const a = makeDraft('a');
    const b = makeDraft('b');
    const cfg = makeConfig({ workflowLibrary: [a, b], activeWorkflowId: 'gone' });
    expect(getActiveWorkflowFromConfig(cfg)?.id).toBe('a');
  });

  it('falls back to the legacy workflowDraft when no library exists', () => {
    const draft = makeDraft('legacy');
    const cfg = makeConfig({ workflowDraft: draft });
    expect(getActiveWorkflowFromConfig(cfg)?.id).toBe('legacy');
  });

  it('returns null when no workflow is configured at all', () => {
    expect(getActiveWorkflowFromConfig(makeConfig())).toBeNull();
  });
});

describe('addWorkflowToLibrary', () => {
  it('appends a new draft and activates it when requested', () => {
    const a = makeDraft('a');
    const cfg = makeConfig({ workflowLibrary: [a], activeWorkflowId: 'a' });
    const fresh = makeDraft('b');
    const next = addWorkflowToLibrary(cfg, fresh, { activate: true });
    expect(next.workflowLibrary?.map((e) => e.id)).toEqual(['a', 'b']);
    expect(next.activeWorkflowId).toBe('b');
  });

  it('keeps the existing active id when activate=false', () => {
    const a = makeDraft('a');
    const cfg = makeConfig({ workflowLibrary: [a], activeWorkflowId: 'a' });
    const fresh = makeDraft('b');
    const next = addWorkflowToLibrary(cfg, fresh);
    expect(next.activeWorkflowId).toBe('a');
  });

  it('rebuilds the id when the candidate id is already in use', () => {
    const a = makeDraft('a');
    const cfg = makeConfig({ workflowLibrary: [a], activeWorkflowId: 'a' });
    const collision = makeDraft('a', 'collision');
    const next = addWorkflowToLibrary(cfg, collision);
    expect(next.workflowLibrary).toHaveLength(2);
    expect(next.workflowLibrary?.[1]?.id).not.toBe('a');
  });

  it('returns the input unchanged when the library is already at the cap', () => {
    const drafts = Array.from({ length: P2P_WORKFLOW_LIBRARY_MAX_ENTRIES }, (_, i) => makeDraft(`d${i}`));
    const cfg = makeConfig({ workflowLibrary: drafts, activeWorkflowId: 'd0' });
    const next = addWorkflowToLibrary(cfg, makeDraft('overflow'));
    expect(next).toBe(cfg);
  });
});

describe('removeWorkflowFromLibrary', () => {
  it('drops the matching entry', () => {
    const a = makeDraft('a');
    const b = makeDraft('b');
    const cfg = makeConfig({ workflowLibrary: [a, b], activeWorkflowId: 'a' });
    const next = removeWorkflowFromLibrary(cfg, 'a');
    expect(next.workflowLibrary?.map((e) => e.id)).toEqual(['b']);
  });

  it('promotes the first remaining entry when the active one is removed', () => {
    const a = makeDraft('a');
    const b = makeDraft('b');
    const cfg = makeConfig({ workflowLibrary: [a, b], activeWorkflowId: 'a' });
    const next = removeWorkflowFromLibrary(cfg, 'a');
    expect(next.activeWorkflowId).toBe('b');
  });

  it('clears activeWorkflowId when the library becomes empty', () => {
    const a = makeDraft('a');
    const cfg = makeConfig({ workflowLibrary: [a], activeWorkflowId: 'a' });
    const next = removeWorkflowFromLibrary(cfg, 'a');
    expect(next.workflowLibrary).toEqual([]);
    expect(next.activeWorkflowId).toBeUndefined();
  });
});

describe('duplicateWorkflowInLibrary', () => {
  it('duplicates with a fresh id, suffixed title, and activates the copy', () => {
    const a = makeDraft('a', 'Workflow A');
    const cfg = makeConfig({ workflowLibrary: [a], activeWorkflowId: 'a' });
    const next = duplicateWorkflowInLibrary(cfg, 'a', ' (copy)');
    expect(next.workflowLibrary).toHaveLength(2);
    const copy = next.workflowLibrary![1];
    expect(copy.id).not.toBe('a');
    expect(copy.title).toBe('Workflow A (copy)');
    expect(next.activeWorkflowId).toBe(copy.id);
  });

  it('returns the input unchanged when the source workflow does not exist', () => {
    const cfg = makeConfig({ workflowLibrary: [makeDraft('a')], activeWorkflowId: 'a' });
    expect(duplicateWorkflowInLibrary(cfg, 'gone', ' (copy)')).toBe(cfg);
  });

  it('returns the input unchanged when the library is at the cap', () => {
    const drafts = Array.from({ length: P2P_WORKFLOW_LIBRARY_MAX_ENTRIES }, (_, i) => makeDraft(`d${i}`));
    const cfg = makeConfig({ workflowLibrary: drafts, activeWorkflowId: 'd0' });
    const next = duplicateWorkflowInLibrary(cfg, 'd0', ' (copy)');
    expect(next).toBe(cfg);
  });
});

describe('replaceActiveWorkflowInConfig', () => {
  it('replaces the matching active entry without touching other entries', () => {
    const a = makeDraft('a', 'A');
    const b = makeDraft('b', 'B');
    const cfg = makeConfig({ workflowLibrary: [a, b], activeWorkflowId: 'a' });
    const updated = makeDraft('a', 'A2');
    const next = replaceActiveWorkflowInConfig(cfg, updated);
    expect(next.workflowLibrary?.map((e) => e.title)).toEqual(['A2', 'B']);
    expect(next.activeWorkflowId).toBe('a');
  });

  it('promotes the input draft to the active id when the library is empty', () => {
    const cfg = makeConfig();
    const draft = makeDraft('fresh', 'Fresh');
    const next = replaceActiveWorkflowInConfig(cfg, draft);
    expect(next.workflowLibrary).toHaveLength(1);
    expect(next.activeWorkflowId).toBe('fresh');
  });
});
