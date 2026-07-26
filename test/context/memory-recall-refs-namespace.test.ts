/**
 * A handle injected into an agent's context must be redeemable by that agent.
 *
 * Live failure this pins: the ⚠️ "记忆句柄未保存" warning with 302 handle rows
 * sitting in the database. The handles WERE persisted — under the wrong
 * namespace. Registration derived it from recall-item fields, and recall items
 * carry `scope` + `projectId` but no `userId`, so injected handles landed under
 * `userId: ''`. The MCP server resolves personal / user_private memory as
 * `userId: 'daemon-local'`, and `resolveMemoryShortRef` refuses a cross-namespace
 * match on purpose, so `get_memory_sources` answered `sources: []` for every
 * injected ref while the very same session's search-provided refs redeemed fine.
 *
 * Verified against the real store before the fix: the four injected refs I probed
 * were all present with namespace_key `["personal","","<project>","",""]`, while
 * the working search-path refs read `["personal","daemon-local","<project>","",""]`
 * — one field apart. 290 of 302 rows (96%) carried the empty spelling, so nearly
 * every handle ever minted on that machine was unreachable.
 *
 * Worse than unresolvable: `personal` declares
 * `requiredIdentityFields: ['user_id', 'project_id']`, so those rows FAILED
 * validation and the warm loader discarded them on every daemon start. The handles
 * were being destroyed, not just missed.
 *
 * The owner is therefore not optional for owner-private memory — on a single-user
 * device it is merely implicit. So the fix has two halves, and either one alone
 * leaves the bug half-alive:
 *   1. registration makes the owner explicit, so new rows are policy-valid;
 *   2. the warm loader backfills the owner on already-stored owner-less rows
 *      instead of dropping them, which is what rescues the existing 290.
 *
 * Sharing does not transfer ownership, so SHARED scopes keep a real owner and stay
 * isolated — the sentinel stands for "this device's owner", never for "anybody".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));

import { attachMemoryShortRefs } from '../../src/context/memory-recall-refs.js';
import {
  loadMemoryShortRefsFromStore,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
} from '../../src/context/memory-short-ref.js';
import { LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import type { ContextNamespace } from '../../shared/context-types.js';

const PROJECT = 'github-im4codes/im4codes/imcodes';

/** Exactly what getDefaultMcpServers hands the MCP server for a personal scope. */
const RESOLVER_NAMESPACE: ContextNamespace = {
  scope: 'personal',
  userId: LEGACY_DAEMON_LOCAL_USER_ID,
  projectId: PROJECT,
};

describe('injected memory handles resolve for the agent they were injected into', () => {
  let dir: string;
  let priorPath: string | undefined;
  let priorLegacy: string | undefined;

  beforeEach(() => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    priorLegacy = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    dir = mkdtempSync(join(tmpdir(), 'imc-recall-refs-'));
    // Keep the store path unset so persistence goes through the mocked client,
    // and point the legacy file at a temp dir so the developer's real cache is
    // never read.
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = join(dir, 'legacy.json');
    runMock.mockReset();
    runMock.mockResolvedValue(undefined);
    resetMemoryShortRefsForTests();
  });

  afterEach(() => {
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    if (priorLegacy === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacy;
    rmSync(dir, { recursive: true, force: true });
  });

  it('redeems a personal projection handle even though the recall item carries no userId', () => {
    // The injected shape, verbatim: scope + projectId, no userId.
    const [item] = attachMemoryShortRefs([
      { id: 'proj-id-1', type: 'processed', scope: 'personal', projectId: PROJECT },
    ]);

    expect(item.ref).toBeTruthy();
    const resolved = resolveMemoryShortRef(item.ref!, RESOLVER_NAMESPACE);
    expect(resolved?.id).toBe('proj-id-1');
    expect(resolved?.kind).toBe('projection');
  });

  it('redeems an observation handle from the same injected shape', () => {
    const [item] = attachMemoryShortRefs([
      { id: 'obs-id-1', type: 'observation', scope: 'user_private' },
    ]);

    expect(item.ref).toBeTruthy();
    const resolved = resolveMemoryShortRef(item.ref!, {
      scope: 'user_private',
      userId: LEGACY_DAEMON_LOCAL_USER_ID,
    });
    expect(resolved?.id).toBe('obs-id-1');
    expect(resolved?.kind).toBe('observation');
  });

  it('still redeems after a daemon restart, via the row that actually reached the store', async () => {
    // The in-memory index would mask a namespace mismatch for the life of the
    // process, so assert the round trip: persist, drop the index, warm-load from
    // exactly what was written, resolve again.
    const [item] = attachMemoryShortRefs([
      { id: 'proj-id-2', type: 'processed', scope: 'personal', projectId: PROJECT },
    ]);
    const upsert = runMock.mock.calls.find(([name]) => name === 'upsertMemoryShortRefs');
    expect(upsert).toBeTruthy();
    const written = (upsert![1] as [Array<Record<string, unknown>>])[0];
    expect(written).toHaveLength(1);

    resetMemoryShortRefsForTests();
    runMock.mockReset();
    // `listMemoryShortRefs` in the store already maps snake_case columns to
    // camelCase, so the warm loader receives exactly the rows that were written.
    // (Re-converting them to snake_case here made this test fail against correct
    // product code — the mock, not the loader, was wrong.)
    runMock.mockImplementation(async (name: string) => (
      name === 'listMemoryShortRefs' ? written : undefined
    ));
    await loadMemoryShortRefsFromStore();

    expect(resolveMemoryShortRef(item.ref!, RESOLVER_NAMESPACE)?.id).toBe('proj-id-2');
  });

  it('rescues an already-stored owner-less row instead of discarding it at startup', async () => {
    // The 290 rows written before registration filled the owner in. `personal`
    // declares requiredIdentityFields ['user_id','project_id'], so validation
    // rejected them and the warm loader dropped every one on each daemon start —
    // the handles were not merely unresolvable, they were destroyed. A device has
    // one owner, so an owner-less owner-private row is unambiguous.
    resetMemoryShortRefsForTests();
    runMock.mockReset();
    runMock.mockImplementation(async (name: string) => (
      name === 'listMemoryShortRefs'
        ? [{
            ref: 'proj:legacyownerless',
            kind: 'projection',
            id: 'legacy-id-1',
            namespaceKey: JSON.stringify(['personal', '', PROJECT, '', '']),
            namespaceJson: JSON.stringify({ scope: 'personal', projectId: PROJECT }),
            lastSeenAt: Date.now(),
          }]
        : undefined
    ));

    const loaded = await loadMemoryShortRefsFromStore();
    expect(loaded).toBe(1);
    expect(resolveMemoryShortRef('proj:legacyownerless', RESOLVER_NAMESPACE)?.id).toBe('legacy-id-1');
  });

  it('does not excuse an owner-less KEY on a row that carries an explicit owner', async () => {
    // The rescue must only forgive rows that actually needed it. Offering the
    // owner-less key shape to every row also excused a genuine key/JSON
    // disagreement — the exact corruption this integrity check exists to catch.
    // (Found by the independent audit of the first version of this fix.)
    resetMemoryShortRefsForTests();
    runMock.mockReset();
    runMock.mockImplementation(async (name: string) => (
      name === 'listMemoryShortRefs'
        ? [{
            ref: 'proj:mismatchedowner',
            kind: 'projection',
            id: 'mismatch-id-1',
            // Key says nobody owns it; JSON says user-42 does. Inconsistent.
            namespaceKey: JSON.stringify(['personal', '', PROJECT, '', '']),
            namespaceJson: JSON.stringify({ scope: 'personal', projectId: PROJECT, userId: 'user-42' }),
            lastSeenAt: Date.now(),
          }]
        : undefined
    ));

    expect(await loadMemoryShortRefsFromStore()).toBe(0);
    expect(resolveMemoryShortRef('proj:mismatchedowner', {
      scope: 'personal', projectId: PROJECT, userId: 'user-42',
    })).toBeUndefined();
  });

  it('keeps SHARED scopes isolated by owner — sharing does not transfer ownership', () => {
    // The narrow boundary: the owner is only implied for owner-private scopes. A
    // shared record can genuinely belong to somebody else, so collapsing owners
    // there would let one owner's handle resolve as another's.
    const [item] = attachMemoryShortRefs([
      { id: 'proj-id-3', type: 'processed', scope: 'project_shared', projectId: PROJECT, userId: 'user-42' },
    ]);

    expect(item.ref).toBeTruthy();
    expect(resolveMemoryShortRef(item.ref!, {
      scope: 'project_shared', projectId: PROJECT, userId: 'user-42',
    })?.id).toBe('proj-id-3');
    // A different owner must NOT redeem it.
    expect(resolveMemoryShortRef(item.ref!, {
      scope: 'project_shared', projectId: PROJECT, userId: 'someone-else',
    })).toBeUndefined();
  });

  it('keeps an explicit real owner distinct from the daemon-local one', () => {
    // Filling the owner in must not flatten real user ids together: the sentinel
    // stands in for "this device's owner", not for "anybody".
    const [item] = attachMemoryShortRefs([
      { id: 'proj-id-4', type: 'processed', scope: 'personal', projectId: PROJECT, userId: 'user-42' },
    ]);

    expect(resolveMemoryShortRef(item.ref!, {
      scope: 'personal', projectId: PROJECT, userId: 'user-42',
    })?.id).toBe('proj-id-4');
    expect(resolveMemoryShortRef(item.ref!, RESOLVER_NAMESPACE)).toBeUndefined();
  });

  it('still isolates the dimensions that DO carry information', () => {
    // Dropping the owner must not turn into "namespace no longer matters".
    const [item] = attachMemoryShortRefs([
      { id: 'proj-id-5', type: 'processed', scope: 'personal', projectId: PROJECT },
    ]);

    expect(resolveMemoryShortRef(item.ref!, { scope: 'personal', projectId: 'other/project' }))
      .toBeUndefined();
    expect(resolveMemoryShortRef(item.ref!, { scope: 'project_shared', projectId: PROJECT }))
      .toBeUndefined();
  });
});
