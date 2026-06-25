/**
 * DB-free unit test for the four-surface execution-clone listing filter +
 * projection (OpenSpec change `dedicated-execution-clone-sessions`, task 6.3).
 *
 * Contract under test:
 *  - `isExecutionCloneRow(row)` is true ONLY when
 *    `execution_clone_metadata.kind === EXECUTION_CLONE_KIND`, tolerant of the
 *    JSONB column arriving as either a parsed object or a raw JSON string.
 *  - `projectSubSessionRow(row)` derives `executionCloneKind` / `parentRunId`
 *    onto a copy of clone rows (existing fields preserved) and leaves non-clone
 *    rows untouched.
 *  - `getSubSessionsByServer` EXCLUDES clones by default and INCLUDES them only
 *    when `{ includeExecutionClones: true }` is passed; either way the projected
 *    fields are present on returned clone rows.
 *  - All four normal-listing consumer call sites pass the default (clones
 *    excluded) — asserted by a grep-style scan of their source so a future edit
 *    that drops the exclusion is caught here.
 *
 * No DB is required: the row-mapping/filter/projection are pure, and the
 * `getSubSessionsByServer` integration is exercised through a tiny in-memory
 * `db.query` stub.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  isExecutionCloneRow,
  projectSubSessionRow,
  getSubSessionsByServer,
  type DbSubSession,
} from '../src/db/queries.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

function baseRow(overrides: Partial<DbSubSession> = {}): DbSubSession {
  return {
    id: 'sub1',
    server_id: 'srv-1',
    type: 'claude-code',
    shell_bin: null,
    cwd: null,
    label: null,
    closed_at: null,
    created_at: 1,
    updated_at: 1,
    cc_session_id: null,
    gemini_session_id: null,
    parent_session: 'deck_proj_brain',
    sort_order: null,
    runtime_type: null,
    provider_id: null,
    provider_session_id: null,
    description: null,
    cc_preset_id: null,
    requested_model: null,
    active_model: null,
    effort: null,
    transport_config: {},
    execution_clone_metadata: null,
    ...overrides,
  };
}

function cloneMeta(parentRunId: string | null = 'run-abc'): Record<string, unknown> {
  // `null` means "omit parentRunId entirely" (a real key default would swallow
  // an explicit `undefined`, so a sentinel is used instead).
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: 'deck_proj_exec',
    ...(parentRunId !== null ? { parentRunId } : {}),
    parentStage: 'generic_execution',
    createdBySessionName: 'deck_proj_brain',
    createdAt: 1,
    hardTimeoutAt: 2,
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
  };
}

describe('isExecutionCloneRow', () => {
  it('is true for a clone row whose metadata is a parsed object', () => {
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: cloneMeta() }))).toBe(true);
  });

  it('is true for a clone row whose metadata arrived as a JSON string', () => {
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: JSON.stringify(cloneMeta()) }))).toBe(true);
  });

  it('is false when metadata is null (a normal sub-session)', () => {
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: null }))).toBe(false);
  });

  it('is false when metadata kind is some other discriminant', () => {
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: { kind: 'something_else' } }))).toBe(false);
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: JSON.stringify({ kind: 'something_else' }) }))).toBe(false);
  });

  it('is false for malformed JSON / non-object metadata rather than throwing', () => {
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: '{not json' }))).toBe(false);
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: 'null' }))).toBe(false);
    expect(isExecutionCloneRow(baseRow({ execution_clone_metadata: '[1,2,3]' }))).toBe(false);
  });
});

describe('projectSubSessionRow', () => {
  it('projects executionCloneKind + parentRunId onto a clone row, preserving existing fields', () => {
    const row = baseRow({ id: 'cln', label: 'worker', execution_clone_metadata: cloneMeta('run-xyz') });
    const projected = projectSubSessionRow(row);
    expect(projected.executionCloneKind).toBe(EXECUTION_CLONE_KIND);
    expect(projected.parentRunId).toBe('run-xyz');
    // Existing fields intact.
    expect(projected.id).toBe('cln');
    expect(projected.label).toBe('worker');
    expect(projected.parent_session).toBe('deck_proj_brain');
    expect(projected.execution_clone_metadata).toBe(row.execution_clone_metadata);
  });

  it('projects from a JSON-string metadata column too', () => {
    const projected = projectSubSessionRow(
      baseRow({ execution_clone_metadata: JSON.stringify(cloneMeta('run-str')) }),
    );
    expect(projected.executionCloneKind).toBe(EXECUTION_CLONE_KIND);
    expect(projected.parentRunId).toBe('run-str');
  });

  it('omits parentRunId when it is missing/non-string but still marks the kind', () => {
    const projected = projectSubSessionRow(
      baseRow({ execution_clone_metadata: cloneMeta(null) }),
    );
    expect(projected.executionCloneKind).toBe(EXECUTION_CLONE_KIND);
    expect('parentRunId' in projected).toBe(false);
  });

  it('leaves a non-clone row untouched (no projected fields)', () => {
    const row = baseRow();
    const projected = projectSubSessionRow(row);
    expect(projected.executionCloneKind).toBeUndefined();
    expect(projected.parentRunId).toBeUndefined();
    expect(projected).toBe(row); // returns the same reference, no clone of normal rows
  });
});

// ── getSubSessionsByServer filter/projection via an in-memory db.query stub ───
function stubDb(rows: DbSubSession[]) {
  return {
    query: async () => rows,
  } as unknown as Parameters<typeof getSubSessionsByServer>[0];
}

describe('getSubSessionsByServer — clone filter + projection', () => {
  const rows = [
    baseRow({ id: 'normal-1', execution_clone_metadata: null }),
    baseRow({ id: 'clone-1', execution_clone_metadata: cloneMeta('run-1') }),
    baseRow({ id: 'normal-2', execution_clone_metadata: { kind: 'something_else' } }),
    baseRow({ id: 'clone-2', execution_clone_metadata: JSON.stringify(cloneMeta('run-2')) }),
  ];

  it('EXCLUDES execution clones by default', async () => {
    const out = await getSubSessionsByServer(stubDb(rows), 'srv-1');
    expect(out.map((r) => r.id)).toEqual(['normal-1', 'normal-2']);
    expect(out.some((r) => r.executionCloneKind === EXECUTION_CLONE_KIND)).toBe(false);
  });

  it('EXCLUDES execution clones when explicitly opted out', async () => {
    const out = await getSubSessionsByServer(stubDb(rows), 'srv-1', { includeExecutionClones: false });
    expect(out.map((r) => r.id)).toEqual(['normal-1', 'normal-2']);
  });

  it('INCLUDES execution clones with projected kind/parentRunId when opted in', async () => {
    const out = await getSubSessionsByServer(stubDb(rows), 'srv-1', { includeExecutionClones: true });
    expect(out.map((r) => r.id)).toEqual(['normal-1', 'clone-1', 'normal-2', 'clone-2']);
    const clone1 = out.find((r) => r.id === 'clone-1')!;
    const clone2 = out.find((r) => r.id === 'clone-2')!;
    expect(clone1.executionCloneKind).toBe(EXECUTION_CLONE_KIND);
    expect(clone1.parentRunId).toBe('run-1');
    expect(clone2.executionCloneKind).toBe(EXECUTION_CLONE_KIND);
    expect(clone2.parentRunId).toBe('run-2');
    // Non-clone rows carry no projected fields even when clones are included.
    expect(out.find((r) => r.id === 'normal-1')!.executionCloneKind).toBeUndefined();
  });
});

// ── The four normal-listing consumers must pass the default (clones excluded).
//    Grep-style guard: catch a future edit that flips a surface to include
//    clones or drops the call entirely. ────────────────────────────────────────
describe('four-surface consumer call sites exclude clones', () => {
  const surfaces: Array<{ name: string; file: string }> = [
    { name: 'normal sub-session list', file: 'routes/sub-sessions.ts' },
    { name: 'session-mgmt snapshot list', file: 'routes/session-mgmt.ts' },
    { name: 'Watch list', file: 'routes/watch.ts' },
    { name: 'tab-sharing shared sub-session list', file: 'routes/tab-sharing.ts' },
  ];

  for (const { name, file } of surfaces) {
    it(`${name} (${file}) calls getSubSessionsByServer with includeExecutionClones: false`, () => {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      expect(source).toContain('getSubSessionsByServer');
      // The surface must NOT request clones.
      expect(source).not.toMatch(/includeExecutionClones:\s*true/);
      // And must explicitly opt out of clones.
      expect(source).toMatch(/includeExecutionClones:\s*false/);
    });
  }

  it('tab-sharing never includes execution clones in its shared sub-session list', () => {
    const source = readFileSync(resolve(SRC, 'routes/tab-sharing.ts'), 'utf8');
    expect(source).not.toMatch(/getSubSessionsByServer\([^)]*includeExecutionClones:\s*true/);
  });
});
