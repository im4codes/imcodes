import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runMock, incrementCounterMock, warnOncePerHourMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  incrementCounterMock: vi.fn(),
  warnOncePerHourMock: vi.fn(),
}));

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));
vi.mock('../../src/util/metrics.js', () => ({ incrementCounter: incrementCounterMock }));
vi.mock('../../src/util/rate-limited-warn.js', () => ({ warnOncePerHour: warnOncePerHourMock }));

import {
  loadMemoryShortRefsFromStore,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
} from '../../src/context/memory-short-ref.js';

/**
 * A stored namespace that cannot be fully validated must take the whole row
 * down. Loading it namespace-less instead yields an entry that looks healthy but
 * can never resolve for a namespaced caller, and counts as loaded — the handle
 * disappears with no signal, which is precisely the failure this module exists
 * to prevent. An earlier check only required `scope` to be a non-empty string,
 * so an illegal scope or a corrupt identity field slipped through.
 */
describe('memory short refs — invalid namespaces are discarded, not degraded', () => {
  let priorPath: string | undefined;
  let priorLegacy: string | undefined;
  let dir: string;

  beforeEach(() => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    priorLegacy = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    dir = mkdtempSync(join(tmpdir(), 'imc-ns-'));
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = join(dir, 'legacy.json');
    vi.clearAllMocks();
    resetMemoryShortRefsForTests();
  });

  afterEach(() => {
    resetMemoryShortRefsForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    if (priorLegacy === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacy;
    rmSync(dir, { recursive: true, force: true });
  });

  const validNamespace = { scope: 'personal', userId: 'u1', projectId: 'p1' };
  /** Storage key is the JSON tuple written by namespaceStorageKey(). */
  const validKey = JSON.stringify(['personal', 'u1', 'p1', '', '']);

  const invalidNamespaces: Array<[string, unknown]> = [
    ['illegal scope value', { scope: 'not_a_scope', userId: 'u1' }],
    ['non-string identity field', { scope: 'personal', userId: 42 }],
    ['non-object namespace', 'personal'],
  ];

  for (const [label, namespace] of invalidNamespaces) {
    it(`discards a store row with an ${label}`, async () => {
      runMock.mockImplementation(async (op: string) => (op === 'listMemoryShortRefs'
        ? [{ ref: 'proj:aaaaaaaaaaaaa', kind: 'projection', id: 'store-row', namespaceKey: validKey, namespaceJson: JSON.stringify(namespace), lastSeenAt: 1 }]
        : 1));

      await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
      expect(resolveMemoryShortRef('proj:aaaaaaaaaaaaa')).toBeUndefined();
      expect(incrementCounterMock).toHaveBeenCalledWith('mem.short_ref.discarded_row', { source: 'warm_load' });
    });

    it(`discards a legacy JSON row with an ${label}`, async () => {
      writeFileSync(join(dir, 'legacy.json'), JSON.stringify({
        schemaVersion: 2,
        entries: [{ ref: 'proj:bbbbbbbbbbbbb', kind: 'projection', id: 'legacy-row', namespace }],
      }), 'utf8');
      runMock.mockImplementation(async (op: string) => (op === 'listMemoryShortRefs' ? [] : 1));

      await loadMemoryShortRefsFromStore();
      expect(resolveMemoryShortRef('proj:bbbbbbbbbbbbb')).toBeUndefined();
      expect(incrementCounterMock).toHaveBeenCalledWith('mem.short_ref.discarded_row', { source: 'legacy_file' });
    });
  }

  it('discards a store row whose namespace_key disagrees with its namespace_json', async () => {
    // The key says the row is scoped while the JSON says it is not: the row's
    // identity is corrupt, and loading it would file the handle under the wrong
    // namespace.
    runMock.mockImplementation(async (op: string) => (op === 'listMemoryShortRefs'
      ? [{ ref: 'proj:ccccccccccccc', kind: 'projection', id: 'mismatch', namespaceKey: validKey, namespaceJson: null, lastSeenAt: 1 }]
      : 1));

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
    expect(incrementCounterMock).toHaveBeenCalledWith('mem.short_ref.discarded_row', { source: 'warm_load' });
  });

  it('loads a row whose namespace is valid and consistent', async () => {
    runMock.mockImplementation(async (op: string) => (op === 'listMemoryShortRefs'
      ? [{ ref: 'proj:ddddddddddddd', kind: 'projection', id: 'ok-row', namespaceKey: validKey, namespaceJson: JSON.stringify(validNamespace), lastSeenAt: 1 }]
      : 1));

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(1);
    expect(resolveMemoryShortRef('proj:ddddddddddddd', validNamespace as never)).toMatchObject({ id: 'ok-row' });
    expect(incrementCounterMock).not.toHaveBeenCalledWith('mem.short_ref.discarded_row', expect.anything());
  });

  it('rejects a schemaVersion 1 legacy file wholesale', async () => {
    // Handles from the previous derivation denote different records now.
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [{ ref: 'proj:deeaca10cd', kind: 'projection', id: 'v1-row', namespace: validNamespace }],
    }), 'utf8');
    runMock.mockImplementation(async (op: string) => (op === 'listMemoryShortRefs' ? [] : 1));

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
    expect(resolveMemoryShortRef('proj:deeaca10cd')).toBeUndefined();
  });
});
