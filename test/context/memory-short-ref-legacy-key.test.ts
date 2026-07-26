import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { upsertMemoryShortRefs } from '../../src/store/context-store.js';
import {
  loadMemoryShortRefsFromStore,
  makeMemoryShortRef,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
} from '../../src/context/memory-short-ref.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Exercised against a real SQLite store rather than a mocked client: the whole
 * point is how node:sqlite round-trips a namespace key, which a mock cannot
 * reproduce.
 *
 * Keys used to be NUL-separated. The bytes store fine and the primary key is
 * unaffected, but node:sqlite stops at the first NUL when converting TEXT to a
 * JS string, so such a row reads back as just its scope. Verifying that against
 * the current JSON-tuple key would discard every handle written before the
 * format changed — an upgrade that silently empties the cache.
 */
describe('memory short refs — legacy NUL-separated namespace keys', () => {
  let tempDir: string;
  let priorPath: string | undefined;
  let priorLegacy: string | undefined;

  const namespace = { scope: 'personal' as const, userId: 'u1', projectId: 'p1' };
  const NUL = String.fromCharCode(0);
  const legacyKey = [namespace.scope, namespace.userId, namespace.projectId, '', ''].join(NUL);

  beforeEach(async () => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    priorLegacy = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = '/nonexistent/imcodes-test/legacy.json';
    tempDir = await createIsolatedSharedContextDb('memory-short-ref-legacy-key');
    resetMemoryShortRefsForTests();
  });

  afterEach(async () => {
    resetMemoryShortRefsForTests();
    resetContextStoreClientForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    if (priorLegacy === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacy;
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('still resolves a handle stored under the old NUL-separated key', async () => {
    const id = 'fb7a7af3-3185-45a4-ac47-b26a57142353';
    const ref = makeMemoryShortRef('projection', id);
    upsertMemoryShortRefs([{
      ref, kind: 'projection', id,
      namespaceKey: legacyKey,
      namespaceJson: JSON.stringify(namespace),
      lastSeenAt: 1,
    }]);

    await expect(loadMemoryShortRefsFromStore()).resolves.toBeGreaterThanOrEqual(1);
    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({ id });
  });

  it('keeps two legacy rows that differ only by namespace apart', async () => {
    // The legacy key reads back as the shared scope, so accepting it must not
    // let one namespace's handle answer for another's.
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const ref = makeMemoryShortRef('projection', id);
    const other = { scope: 'personal' as const, userId: 'u2', projectId: 'p2' };
    upsertMemoryShortRefs([
      { ref, kind: 'projection', id, namespaceKey: legacyKey, namespaceJson: JSON.stringify(namespace), lastSeenAt: 1 },
      {
        ref, kind: 'projection', id,
        namespaceKey: [other.scope, other.userId, other.projectId, '', ''].join(NUL),
        namespaceJson: JSON.stringify(other),
        lastSeenAt: 2,
      },
    ]);

    await loadMemoryShortRefsFromStore();
    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({ id });
    expect(resolveMemoryShortRef(ref, other)).toMatchObject({ id });
    // A third, unrelated namespace must still miss.
    expect(resolveMemoryShortRef(ref, { scope: 'personal', userId: 'u3', projectId: 'p3' } as never)).toBeUndefined();
  });

  it('discards a row whose namespace column is present but unparseable', async () => {
    // An empty key plus broken JSON previously decoded as "no namespace" and
    // loaded, leaving a handle no namespaced caller can reach.
    const id = 'bbbbbbbb-1111-2222-3333-444444444444';
    const ref = makeMemoryShortRef('projection', id);
    upsertMemoryShortRefs([{
      ref, kind: 'projection', id,
      namespaceKey: '',
      namespaceJson: '{bad-json',
      lastSeenAt: 1,
    }]);

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
    expect(resolveMemoryShortRef(ref)).toBeUndefined();
  });
});

describe('memory short refs — namespace values that name nothing reachable', () => {
  let tempDir: string;
  let priorPath: string | undefined;
  let priorLegacy: string | undefined;

  beforeEach(async () => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    priorLegacy = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = '/nonexistent/imcodes-test/legacy.json';
    tempDir = await createIsolatedSharedContextDb('memory-short-ref-identity');
    resetMemoryShortRefsForTests();
  });

  afterEach(async () => {
    resetMemoryShortRefsForTests();
    resetContextStoreClientForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    if (priorLegacy === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacy;
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  // Each row below pairs the namespace with the key that namespaceStorageKey
  // would produce for it, so the key-consistency check agrees and ONLY the
  // scope/identity rules can reject the row. Earlier tests always used a valid
  // key, which meant a mismatch masked whether identity was checked at all.
  const keyFor = (ns: Record<string, string>) => JSON.stringify([
    ns.scope, ns.userId ?? '', ns.projectId ?? '', ns.workspaceId ?? '', ns.enterpriseId ?? '',
  ]);

  it('discards a personal-scope row missing the identity that scope requires', async () => {
    const id = 'cccccccc-1111-2222-3333-444444444444';
    const ref = makeMemoryShortRef('projection', id);
    const ns = { scope: 'personal', userId: 'u1' }; // no projectId
    upsertMemoryShortRefs([{
      ref, kind: 'projection', id,
      namespaceKey: keyFor(ns), namespaceJson: JSON.stringify(ns), lastSeenAt: 1,
    }]);

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
    expect(resolveMemoryShortRef(ref, ns as never)).toBeUndefined();
  });

  it('discards a row whose namespace column holds the JSON text null', async () => {
    // Parses successfully, so a parse-failure guard alone lets it through; it
    // still describes no namespace.
    const id = 'dddddddd-1111-2222-3333-444444444444';
    const ref = makeMemoryShortRef('projection', id);
    upsertMemoryShortRefs([{
      ref, kind: 'projection', id,
      namespaceKey: '', namespaceJson: 'null', lastSeenAt: 1,
    }]);

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
    expect(resolveMemoryShortRef(ref)).toBeUndefined();
  });
});
