import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { listMemoryShortRefs } from '../../src/store/context-store.js';
import {
  loadMemoryShortRefsFromStore,
  registerMemoryShortRefs,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
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

  beforeEach(async () => {
    // Unset so the store (not the JSON file) is the persistence target.
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    tempDir = await createIsolatedSharedContextDb('memory-short-ref-store');
    resetMemoryShortRefsForTests();
  });

  afterEach(async () => {
    resetMemoryShortRefsForTests();
    resetContextStoreClientForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
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
});
