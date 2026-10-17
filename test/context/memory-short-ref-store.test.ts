import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import {
  listMemoryShortRefs,
  listMemoryShortRefsByRef,
  upsertMemoryShortRefs,
} from '../../src/store/context-store.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadMemoryShortRefsFromStore,
  makeMemoryShortRef,
  registerMemoryShortRefs,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
  resolveMemoryShortRefCandidatesWithStore,
  resolveMemoryShortRefWithStore,
  seedMemoryShortRefCollisionForTests,
} from '../../src/context/memory-short-ref.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Durable handle map. Handles used to persist by rewriting a whole JSON file on
 * every registration, with the write error swallowed — once the disk filled up
 * the file silently stopped being written, so every handle issued after that
 * point died on the next daemon restart. Persist incrementally to the context
 * store instead, and warm the in-memory index from it at startup.
 */
describe('memory short refs — durable store persistence', () => {
  let tempDir: string;
  let priorPath: string | undefined;
  let priorLegacyPath: string | undefined;
  let priorRecoveryPath: string | undefined;

  beforeEach(async () => {
    // Unset so the store (not the JSON file) is the persistence target.
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    // Warm-load also imports the retired JSON cache. Point it at a path that
    // does not exist so these assertions never read the developer's real file.
    priorLegacyPath = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = '/nonexistent/imcodes-test/legacy-short-refs.json';
    priorRecoveryPath = process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH;
    tempDir = await createIsolatedSharedContextDb('memory-short-ref-store');
    resetMemoryShortRefsForTests();
  });

  afterEach(async () => {
    resetMemoryShortRefsForTests();
    resetContextStoreClientForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    if (priorLegacyPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacyPath;
    if (priorRecoveryPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH = priorRecoveryPath;
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  const namespace = { scope: 'personal' as const, userId: 'user-1', projectId: 'repo-1' };

  it('persists registered handles to the store and resolves them after a restart', async () => {
    const [ref] = registerMemoryShortRefs([
      { kind: 'projection', id: 'fb7a7af3-3185-45a4-ac47-b26a57142353', namespace },
      { kind: 'observation', id: '2cf7602fb9d586fa5377f22b879ca97b3ba4c5acbdd32b9df36ad15e2df0a8c6', namespace },
    ]);
    expect(ref).toMatch(/^proj:[a-z2-7]{13}$/);

    // Registration is fire-and-forget; let the store write settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listMemoryShortRefs().length).toBeGreaterThanOrEqual(2);

    // Simulate a daemon restart: in-memory index gone, store intact.
    resetMemoryShortRefsForTests();
    expect(resolveMemoryShortRef(ref!, namespace)).toBeUndefined();

    const loaded = await loadMemoryShortRefsFromStore();
    expect(loaded).toBeGreaterThanOrEqual(2);
    expect(resolveMemoryShortRef(ref!, namespace)).toMatchObject({
      kind: 'projection',
      id: 'fb7a7af3-3185-45a4-ac47-b26a57142353',
    });
  });

  it('replays a real atomic recovery journal into SQLite and removes it after catch-up', async () => {
    const recoveryPath = join(tempDir, 'memory-short-refs.pending.json');
    process.env.IMCODES_MEMORY_SHORT_REF_RECOVERY_PATH = recoveryPath;
    const id = 'durable-during-worker-self-heal';
    const ref = makeMemoryShortRef('projection', id);
    writeFileSync(recoveryPath, JSON.stringify({
      schemaVersion: 2,
      rows: [{
        ref,
        kind: 'projection',
        id,
        namespaceKey: JSON.stringify(['personal', 'user-1', 'repo-1', '', '']),
        namespaceJson: JSON.stringify(namespace),
        lastSeenAt: Date.now(),
      }],
    }), { encoding: 'utf8', mode: 0o600 });

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(1);
    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({ id });
    await expect.poll(() => listMemoryShortRefsByRef(ref)).toHaveLength(1);
    await expect.poll(() => existsSync(recoveryPath)).toBe(false);
  });

  it('re-registering the same memory upserts instead of accumulating rows', async () => {
    const entry = { kind: 'projection' as const, id: 'dddddddddd-1111-2222-3333-444444444444', namespace };
    registerMemoryShortRefs([entry]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterFirst = listMemoryShortRefs().length;

    // The handle is a pure function of the id, so a repeat injection reuses the
    // same primary key rather than growing the table.
    registerMemoryShortRefs([entry]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listMemoryShortRefs().length).toBe(afterFirst);
  });

  it('imports handles from the retired JSON cache and moves them into the store', async () => {
    // The JSON file is a read-only fallback during the migration: handles it
    // still holds are valid, so carry them over rather than stranding them until
    // their memory is injected again. The file itself is never written or
    // deleted — it just stops being needed.
    const legacyPath = join(tempDir, 'legacy-short-refs.json');
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = legacyPath;
    const legacyId = '45663d84-d3bb-4f9a-bf65-eba630b45d66';
    const legacyRef = makeMemoryShortRef('projection', legacyId);
    writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: 2,
      entries: [{ ref: legacyRef, kind: 'projection', id: legacyId, namespace, lastSeenAt: 123 }],
    }), 'utf8');

    const before = readFileSync(legacyPath, 'utf8');
    const loaded = await loadMemoryShortRefsFromStore();
    expect(loaded).toBeGreaterThanOrEqual(1);
    expect(resolveMemoryShortRef(legacyRef, namespace)).toMatchObject({ id: legacyId });

    // Imported handles land in the store, so the next start no longer needs the file.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listMemoryShortRefs().some((row) => row.id === legacyId)).toBe(true);
    // And the file is left exactly as it was.
    expect(readFileSync(legacyPath, 'utf8')).toBe(before);
  });

  it('keeps cross-namespace isolation after a store warm-load', async () => {
    const [ref] = registerMemoryShortRefs([
      { kind: 'projection', id: 'cccccccccc-1111-2222-3333-444444444444', namespace },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    resetMemoryShortRefsForTests();
    await loadMemoryShortRefsFromStore();

    expect(resolveMemoryShortRef(ref!, { ...namespace, projectId: 'other-repo' })).toBeUndefined();
    expect(resolveMemoryShortRef(ref!, namespace)).toMatchObject({ id: 'cccccccccc-1111-2222-3333-444444444444' });
  });

  it('hydrates an exact ref persisted after this process cache was populated', async () => {
    const localId = 'local-cache-entry';
    const remoteId = 'persisted-by-another-process';
    const remoteRef = makeMemoryShortRef('projection', remoteId);

    // Populate this process's Map first, then write a different ref straight to
    // SQLite as another daemon/MCP process would. A one-time warm-load cannot
    // observe this later write.
    seedMemoryShortRefCollisionForTests(makeMemoryShortRef('projection', localId), [{
      kind: 'projection',
      id: localId,
      namespace,
    }]);
    upsertMemoryShortRefs([{
      ref: remoteRef,
      kind: 'projection',
      id: remoteId,
      namespaceKey: JSON.stringify([
        namespace.scope,
        namespace.userId,
        namespace.projectId,
        '',
        '',
      ]),
      namespaceJson: JSON.stringify(namespace),
      lastSeenAt: Date.now(),
    }]);

    expect(resolveMemoryShortRef(remoteRef, namespace)).toBeUndefined();
    expect(listMemoryShortRefsByRef(remoteRef)).toHaveLength(1);

    await expect(resolveMemoryShortRefCandidatesWithStore(remoteRef, namespace))
      .resolves.toEqual([
        expect.objectContaining({ kind: 'projection', id: remoteId }),
      ]);
    await expect(resolveMemoryShortRefWithStore(remoteRef, namespace))
      .resolves.toMatchObject({ kind: 'projection', id: remoteId });
  });

  it('does not cross namespaces while hydrating an exact persisted ref', async () => {
    const id = 'persisted-private-entry';
    const ref = makeMemoryShortRef('projection', id);
    upsertMemoryShortRefs([{
      ref,
      kind: 'projection',
      id,
      namespaceKey: JSON.stringify([
        namespace.scope,
        namespace.userId,
        namespace.projectId,
        '',
        '',
      ]),
      namespaceJson: JSON.stringify(namespace),
      lastSeenAt: Date.now(),
    }]);

    await expect(resolveMemoryShortRefCandidatesWithStore(ref, {
      ...namespace,
      userId: 'other-user',
    })).resolves.toEqual([]);
    await expect(resolveMemoryShortRefWithStore(ref, {
      ...namespace,
      projectId: 'other-repo',
    })).resolves.toBeUndefined();
    await expect(resolveMemoryShortRefWithStore(ref, namespace))
      .resolves.toMatchObject({ id });
  });

  it('keeps an old hydrated ref long enough to resolve when the local LRU is full', async () => {
    for (let index = 0; index < 10_000; index += 1) {
      seedMemoryShortRefCollisionForTests(`proj:cached${String(index).padStart(7, '0')}`, [{
        kind: 'projection',
        id: `cached-${index}`,
        namespace,
        lastSeenAt: 1_000 + index,
      }]);
    }
    const id = 'old-persisted-ref-at-lru-cap';
    const ref = makeMemoryShortRef('projection', id);
    upsertMemoryShortRefs([{
      ref,
      kind: 'projection',
      id,
      namespaceKey: JSON.stringify([
        namespace.scope,
        namespace.userId,
        namespace.projectId,
        '',
        '',
      ]),
      namespaceJson: JSON.stringify(namespace),
      lastSeenAt: 1,
    }]);

    expect(resolveMemoryShortRef(ref, namespace)).toBeUndefined();
    await expect(resolveMemoryShortRefWithStore(ref, namespace))
      .resolves.toMatchObject({ id });
  });
});
