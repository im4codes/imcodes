import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  ensureContextNamespace,
  writeContextObservation,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import {
  searchLocalMemory,
  searchLocalMemoryAuthorized,
} from '../../src/context/memory-search.js';
import {
  searchLocalMemory as searchLocalMemoryCore,
  searchLocalMemoryAuthorized as searchLocalMemoryAuthorizedCore,
  searchLocalMemoryCandidates,
} from '../../src/context/memory-recall-core.js';
import { searchLocalMemorySemanticBounded } from '../../src/context/memory-recall-bounded.js';
import { DEFAULT_MEMORY_SCORING_WEIGHTS } from '../../shared/memory-scoring.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

describe('bounded observation recall and semantic parity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('obs-recall-bounded');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('keeps semantic parity across user_private bridge, haystack fields, CJK, non-ASCII case, quotes, and time bounds', () => {
    const personalNs: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/app', userId: 'user-1' };
    const userPrivateNs = ensureContextNamespace({ scope: 'user_private', projectId: 'github.com/acme/app', userId: 'user-1' }, 100);
    const otherUserPrivateNs = ensureContextNamespace({ scope: 'user_private', projectId: 'github.com/acme/app', userId: 'user-2' }, 100);
    const otherProjPrivateNs = ensureContextNamespace({ scope: 'user_private', projectId: 'github.com/acme/other', userId: 'user-1' }, 100);

    // 1. Bridged user_private observation with title + multiline text + class + sourceEventIds
    writeContextObservation({
      namespaceId: userPrivateNs.id,
      scope: 'user_private',
      class: 'bugfix',
      origin: 'agent_learned',
      fingerprint: 'fp-bridge-1',
      content: { title: '部署配置', text: '修复 100% pass_rate 解析\nsay "hello" and Café', projectId: 'github.com/acme/app' },
      sourceEventIds: ['turn-special-77'],
      state: 'active',
      now: 1_000,
    });

    // 2. Another user's user_private observation (must remain hidden)
    writeContextObservation({
      namespaceId: otherUserPrivateNs.id,
      scope: 'user_private',
      class: 'bugfix',
      origin: 'agent_learned',
      fingerprint: 'fp-other-user',
      content: { text: '部署配置 secret other user turn-special-77' },
      sourceEventIds: ['turn-special-77'],
      state: 'active',
      now: 1_500,
    });

    // 3. Same user, different project user_private observation (must remain hidden for personalNs)
    writeContextObservation({
      namespaceId: otherProjPrivateNs.id,
      scope: 'user_private',
      class: 'bugfix',
      origin: 'agent_learned',
      fingerprint: 'fp-other-proj',
      content: { text: '部署配置 other project' },
      state: 'active',
      now: 1_600,
    });

    // 4. Promoted & rejected observations for observationStates verification
    writeContextObservation({
      namespaceId: userPrivateNs.id,
      scope: 'user_private',
      class: 'decision',
      origin: 'user_note',
      fingerprint: 'fp-rejected',
      content: { text: 'rejected marker 部署配置' },
      state: 'rejected',
      now: 2_000,
    });

    // Bridge + CJK substring
    const cjkHit = searchLocalMemory({ namespace: personalNs, query: '部署配置', limit: 10 });
    expect(cjkHit.items).toHaveLength(1);
    expect(cjkHit.items[0]).toMatchObject({ type: 'observation', observationClass: 'bugfix', matchKind: 'exact' });

    // Match by observationClass + sourceEventId combined
    const classSourceHit = searchLocalMemory({ namespace: personalNs, query: 'bugfix turn-special-77', limit: 10 });
    expect(classSourceHit.items).toHaveLength(1);

    // Match by normalized multiline summary across title ": " + quotes + % + non-ASCII cased token
    expect(searchLocalMemory({ namespace: personalNs, query: '部署配置: 修复 100%', limit: 10 }).items).toHaveLength(1);
    expect(searchLocalMemory({ namespace: personalNs, query: '解析 say "hello"', limit: 10 }).items).toHaveLength(1);
    expect(searchLocalMemory({ namespace: personalNs, query: 'café', limit: 10 }).items).toHaveLength(1);

    // Time bounds on createdAt
    expect(searchLocalMemory({ namespace: personalNs, query: '部署配置', after: 1_000, before: 1_000 }).items).toHaveLength(1);
    expect(searchLocalMemory({ namespace: personalNs, query: '部署配置', after: 1_001 }).items).toHaveLength(0);
    expect(searchLocalMemory({ namespace: personalNs, query: '部署配置', before: 999 }).items).toHaveLength(0);

    // observationStates & observationClass
    expect(searchLocalMemory({ namespace: personalNs, observationClass: 'decision', observationStates: ['rejected'] }).items).toHaveLength(1);
    expect(searchLocalMemory({ namespace: personalNs, observationClass: 'decision' }).items).toHaveLength(0);

    // Entrypoint parity between memory-search.ts and memory-recall-core.ts
    const authRes = searchLocalMemoryAuthorized({ authorizedNamespaces: [personalNs], query: '部署配置', limit: 10 });
    const authCoreRes = searchLocalMemoryAuthorizedCore({ authorizedNamespaces: [personalNs], query: '部署配置', limit: 10 });
    expect(authRes.items).toEqual(authCoreRes.items);
    expect(authRes.items).toHaveLength(1);
    expect(searchLocalMemory({ namespace: personalNs, query: '部署配置' }).items)
      .toEqual(searchLocalMemoryCore({ namespace: personalNs, query: '部署配置' }).items);
  });

  it('forwards bounded limit in collectProcessedProjections and supports deep pagination across >50 projections and observations', () => {
    const ns: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/paginated', userId: 'user-p' };
    const nsRow = ensureContextNamespace(ns, 100);
    for (let i = 0; i < 65; i++) {
      writeProcessedProjection({
        namespace: ns,
        class: 'recent_summary',
        origin: 'chat_compacted',
        sourceEventIds: [`evt-p-${i}`],
        summary: `Processed summary entry ${i}`,
        content: { text: `Processed summary entry ${i}` },
        createdAt: 100 + i,
        updatedAt: 100 + i,
      });
    }
    for (let i = 0; i < 65; i++) {
      writeContextObservation({
        namespaceId: nsRow.id,
        scope: 'personal',
        class: 'note',
        origin: 'user_note',
        fingerprint: `fp-p-${i}`,
        content: { text: `Unprojected observation entry ${i}` },
        now: 100 + i,
      });
    }

    const highLimit = searchLocalMemory({ namespace: ns, projectionClass: 'recent_summary', limit: 60 });
    expect(highLimit.items).toHaveLength(60);

    // Deep pagination: observations rank ahead of projections (65 observations, indexes 64..0 desc),
    // so offset=60, limit=10 should yield last 5 observations + first 5 projections.
    const deepPage = searchLocalMemory({ namespace: ns, offset: 60, limit: 10 });
    expect(deepPage.items).toHaveLength(10);
    expect(deepPage.items.slice(0, 5).every((i) => i.type === 'observation')).toBe(true);
    expect(deepPage.items.slice(5, 10).every((i) => i.type === 'processed')).toBe(true);
  });

  it('stays fast (<200ms) across 25,000 production-shaped observation rows on bounded and authorized recall', async () => {
    const targetPersonalNs: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/target', userId: 'user-target' };
    const targetPrivateNs = ensureContextNamespace({ scope: 'user_private', projectId: 'github.com/acme/target', userId: 'user-target' }, 100);
    const targetPersonalRow = ensureContextNamespace(targetPersonalNs, 100);
    const otherNamespaceIds: string[] = [];
    for (let n = 0; n < 20; n++) {
      const row = ensureContextNamespace({ scope: 'personal', projectId: `github.com/acme/noise-${n}`, userId: `user-noise-${n % 4}` }, 100);
      otherNamespaceIds.push(row.id);
    }

    // Target user_private unprojected observations (mix of matching + recent non-matching)
    const targetObs = writeContextObservation({
      namespaceId: targetPrivateNs.id,
      scope: 'user_private',
      class: 'discovery',
      origin: 'agent_learned',
      fingerprint: 'fp-target-hit',
      content: { text: 'production latency killer fixed via composite index on context_observations' },
      sourceEventIds: ['turn-211-prod'],
      state: 'active',
      now: 9_000_000,
    });

    // Bulk-seed 25,000 rows: 15,000 across unrelated namespaces + 10,000 projection-linked rows inside target namespace
    const database = new DatabaseSync(join(tempDir, 'context.sqlite'));
    database.exec('BEGIN');
    const insert = database.prepare(`
      INSERT INTO context_observations (
        id, namespace_id, scope, class, origin, fingerprint, content_json, text_hash,
        source_event_ids_json, projection_id, state, confidence, created_at, updated_at, promoted_at
      ) VALUES (?, ?, 'personal', 'note', 'chat_compacted', ?, ?, ?, '["evt-bulk"]', ?, 'active', NULL, ?, ?, NULL)
    `);
    const largePayload = JSON.stringify({ text: 'unrelated historical context observation payload '.repeat(20) });
    for (let i = 0; i < 25_000; i++) {
      const inTargetNs = i < 10_000;
      const nsId = inTargetNs ? targetPersonalRow.id : otherNamespaceIds[i % otherNamespaceIds.length]!;
      const projectionId = inTargetNs ? `proj-linked-${i}` : (i % 3 === 0 ? null : `proj-other-${i}`);
      insert.run(
        `bulk-obs-${i}`,
        nsId,
        `fp-bulk-${i}`,
        largePayload,
        `hash-bulk-${i}`,
        projectionId,
        1_000 + i,
        1_000 + i,
      );
    }
    database.exec('COMMIT');
    database.close();

    // Warm once then measure bounded semantic recall, substring recall, and authorized management recall
    const queryEmbedding = new Float32Array(384);
    queryEmbedding[0] = 1;
    await searchLocalMemorySemanticBounded(
      { namespace: targetPersonalNs, query: 'composite index context_observations', limit: 5 },
      queryEmbedding,
      [],
      DEFAULT_MEMORY_SCORING_WEIGHTS,
    );

    const t0 = performance.now();
    const semanticRes = await searchLocalMemorySemanticBounded(
      { namespace: targetPersonalNs, query: 'composite index context_observations', limit: 5 },
      queryEmbedding,
      [],
      DEFAULT_MEMORY_SCORING_WEIGHTS,
    );
    const searchRes = searchLocalMemory({
      namespace: targetPersonalNs,
      query: 'composite index context_observations',
      limit: 5,
    });
    const authRes = searchLocalMemoryAuthorized({
      authorizedNamespaces: [targetPersonalNs],
      query: 'composite index context_observations',
      limit: 10,
    });
    const elapsedMs = performance.now() - t0;

    expect(semanticRes.items.map((i) => i.id)).toContain(targetObs.id);
    expect(searchRes.items.map((i) => i.id)).toEqual([targetObs.id]);
    expect(authRes.items.map((i) => i.id)).toEqual([targetObs.id]);
    expect(elapsedMs).toBeLessThan(200);
  }, 30_000);

  it('matches ASCII queries against Unicode case-folded source text (Kelvin sign Kelvin) in observations and projections', () => {
    const ns: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/unicode', userId: 'user-u' };
    const nsRow = ensureContextNamespace(ns, 100);
    const obs = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-kelvin',
      content: { text: '\u212aelvin temperature threshold' },
      now: 100,
    });
    const proj = writeProcessedProjection({
      namespace: ns,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-kelvin'],
      summary: '\u212aelvin summary note',
      content: { text: '\u212aelvin summary note' },
      createdAt: 100,
      updatedAt: 100,
    });

    const obsOnly = searchLocalMemory({ namespace: ns, query: 'kelvin', limit: 10 });
    expect(obsOnly.items.map((i) => i.id)).toEqual([obs.id, proj.id]);
    expect(obsOnly.stats.matchedRecords).toBe(2);

    const auth = searchLocalMemoryAuthorized({ authorizedNamespaces: [ns], query: 'kelvin', limit: 10 });
    expect(auth.items.map((i) => i.id)).toEqual([obs.id, proj.id]);
    expect(auth.stats.matchedRecords).toBe(2);
  });

  it('finds sparse matches behind >200 newer non-matching rows and keeps matchedRecords invariant across pagination & >10k deep offsets', () => {
    const ns: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/sparse', userId: 'user-s' };
    const nsRow = ensureContextNamespace(ns, 100);

    // Older sparse hit (Café)
    const oldCafe = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-old-cafe',
      content: { text: 'old Café endpoint note' },
      now: 1_000,
    });

    // 205 newer non-matching rows + 70 matching 'paginated-hit' rows (and >10,000 total rows for deep offset)
    const database = new DatabaseSync(join(tempDir, 'context.sqlite'));
    database.exec('BEGIN');
    const insert = database.prepare(`
      INSERT INTO context_observations (
        id, namespace_id, scope, class, origin, fingerprint, content_json, text_hash,
        source_event_ids_json, projection_id, state, confidence, created_at, updated_at, promoted_at
      ) VALUES (?, ?, 'personal', 'note', 'user_note', ?, ?, ?, '["evt-deep"]', NULL, 'active', NULL, ?, ?, NULL)
    `);
    for (let i = 0; i < 10_020; i++) {
      const ts = 2_000 + i;
      const text = i < 70 ? `paginated-hit item ${i}` : `unrelated noise entry ${i}`;
      insert.run(
        `deep-obs-${i}`,
        nsRow.id,
        `fp-deep-${i}`,
        JSON.stringify({ text }),
        `hash-deep-${i}`,
        ts,
        ts,
      );
    }
    database.exec('COMMIT');
    database.close();

    // 1. Sparse hit behind >200 (actually 10,020) newer non-matching rows with limit=1
    const sparse = searchLocalMemory({ namespace: ns, query: 'café', limit: 1 });
    expect(sparse.items.map((i) => i.id)).toEqual([oldCafe.id]);
    expect(sparse.stats.matchedRecords).toBe(1);

    // 2. matchedRecords invariant across offset=0 vs offset=60 on authorized search (deduped)
    const page0 = searchLocalMemoryAuthorized({
      authorizedNamespaces: [ns, ns],
      query: 'paginated-hit',
      offset: 0,
      limit: 10,
    });
    const page60 = searchLocalMemoryAuthorized({
      authorizedNamespaces: [ns],
      query: 'paginated-hit',
      offset: 60,
      limit: 10,
    });
    expect(page0.items).toHaveLength(10);
    expect(page60.items).toHaveLength(10);
    expect(page0.stats.matchedRecords).toBe(70);
    expect(page60.stats.matchedRecords).toBe(70);

    // 3. Deep pagination past 10,000 (> old 10,000 hard cap)
    const deep = searchLocalMemory({ namespace: ns, offset: 10_005, limit: 10 });
    expect(deep.items).toHaveLength(10);
    expect(deep.stats.matchedRecords).toBe(10_021);
  });

  it('preserves authorized workspace/org row-level userId filtering, projectless observation exclusion, candidate offset/durable window, and whitespace query zero-match', () => {
    const wsNs: ContextNamespace = { scope: 'workspace_shared', enterpriseId: 'ent-ws', workspaceId: 'ws-1' };
    const wsRowNoProj = ensureContextNamespace(wsNs, 100);
    const orgNs: ContextNamespace = { scope: 'org_shared', enterpriseId: 'ent-ws' };
    const orgRowNoProj = ensureContextNamespace(orgNs, 100);

    // Projectless workspace_shared & org_shared observations map projectId -> '', excluded when authorized namespace lacks projectId
    writeContextObservation({
      namespaceId: wsRowNoProj.id,
      scope: 'workspace_shared',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-ws-obs',
      content: { text: 'projectless workspace observation' },
      now: 200,
    });
    writeContextObservation({
      namespaceId: orgRowNoProj.id,
      scope: 'org_shared',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-org-obs',
      content: { text: 'projectless org observation' },
      now: 210,
    });

    // Workspace-shared projections with distinct row owners
    const wsProjOwner1 = writeProcessedProjection({
      namespace: { scope: 'workspace_shared', enterpriseId: 'ent-ws', workspaceId: 'ws-1', userId: 'owner-1' },
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-ws-1'],
      summary: 'Workspace summary by owner-1',
      content: { text: 'Workspace summary by owner-1' },
      createdAt: 300,
      updatedAt: 300,
    });
    writeProcessedProjection({
      namespace: { scope: 'workspace_shared', enterpriseId: 'ent-ws', workspaceId: 'ws-1', userId: 'owner-2' },
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-ws-2'],
      summary: 'Workspace summary by owner-2',
      content: { text: 'Workspace summary by owner-2' },
      createdAt: 310,
      updatedAt: 310,
    });

    const authOwnerFiltered = searchLocalMemoryAuthorized({
      authorizedNamespaces: [wsNs, orgNs],
      userId: 'owner-1',
      limit: 10,
    });
    expect(authOwnerFiltered.items.map((i) => i.id)).toEqual([wsProjOwner1.id]);
    expect(authOwnerFiltered.stats.matchedRecords).toBe(1);

    // Empty string userId behaves like omitted userId (truthiness parity with matchesNamespace)
    const authEmptyUser = searchLocalMemoryAuthorized({
      authorizedNamespaces: [wsNs, orgNs],
      userId: '',
      limit: 10,
    });
    expect(authEmptyUser.items).toHaveLength(2);
    expect(authEmptyUser.stats.matchedRecords).toBe(2);

    const authOtherUser = searchLocalMemoryAuthorized({
      authorizedNamespaces: [wsNs, orgNs],
      userId: 'other-owner',
      limit: 10,
    });
    expect(authOtherUser.items).toEqual([]);
    expect(authOtherUser.stats.matchedRecords).toBe(0);

    const authUnfiltered = searchLocalMemoryAuthorized({
      authorizedNamespaces: [wsNs, orgNs],
      limit: 10,
    });
    expect(authUnfiltered.items.some((i) => i.type === 'observation')).toBe(false);
    expect(authUnfiltered.stats.matchedRecords).toBe(2);

    // Semantic candidate path: offset + 41st durable projection behind 40 newer recent summaries
    const candNs: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/cand', userId: 'user-c' };
    const hit1 = writeProcessedProjection({
      namespace: candNs,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-hit-1'],
      summary: 'memory search hit 1',
      content: {},
      createdAt: 100,
      updatedAt: 100,
    });
    writeProcessedProjection({
      namespace: candNs,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-hit-2'],
      summary: 'memory search hit 2',
      content: {},
      createdAt: 200,
      updatedAt: 200,
    });
    const offsetRes = searchLocalMemoryCandidates({ namespace: candNs, query: 'memory search', offset: 1, limit: 1 });
    expect(offsetRes.items.map((i) => i.id)).toEqual([hit1.id]);

    const durableNs: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/durable41', userId: 'user-d' };
    const durable41 = writeProcessedProjection({
      namespace: durableNs,
      class: 'durable_memory_candidate',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-durable-41'],
      summary: '41st older durable projection survives ranking',
      content: {},
      createdAt: 50,
      updatedAt: 50,
    });
    for (let i = 0; i < 40; i++) {
      writeProcessedProjection({
        namespace: durableNs,
        class: 'recent_summary',
        origin: 'chat_compacted',
        sourceEventIds: [`evt-recent-${i}`],
        summary: `Newer recent summary ${i}`,
        content: {},
        createdAt: 100 + i,
        updatedAt: 100 + i,
      });
    }
    const cand40 = searchLocalMemoryCandidates({ namespace: durableNs, limit: 40 });
    expect(cand40.items.map((i) => i.id)).toContain(durable41.id);

    // Whitespace-only non-empty query returns 0 hits while '' / undefined browse normally
    expect(searchLocalMemory({ namespace: candNs, query: '   ' }).items).toEqual([]);
    expect(searchLocalMemory({ namespace: candNs, query: '   ' }).stats.matchedRecords).toBe(0);
    expect(searchLocalMemoryAuthorized({ authorizedNamespaces: [candNs], query: '   ' }).items).toEqual([]);
    expect(searchLocalMemoryAuthorized({ authorizedNamespaces: [candNs], query: '   ' }).stats.matchedRecords).toBe(0);
    expect(searchLocalMemoryCandidates({ namespace: candNs, query: '   ' }).items).toEqual([]);
    expect(searchLocalMemory({ namespace: candNs, query: '' }).stats.matchedRecords).toBe(2);
    expect(searchLocalMemory({ namespace: candNs }).stats.matchedRecords).toBe(2);
  });
});
