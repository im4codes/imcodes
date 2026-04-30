import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace, ContextTargetRef, LocalContextEvent } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor, serializeEvents } from '../../src/context/summary-compressor.js';
import { searchLocalMemorySemantic } from '../../src/context/memory-search.js';
import { getArchivedEvent, resetContextStoreForTests, writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const embeddingProbe = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock('../../src/context/embedding.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    embeddingProbe.texts.push(text);
    return new Float32Array([1]);
  }),
  cosineSimilarity: vi.fn(() => 1),
  encodeEmbedding: (vec: Float32Array) => Buffer.from(new Uint8Array(vec.buffer.slice(0))),
  decodeEmbedding: () => null,
}));

describe('memory redaction pipeline', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;
  // Runtime concat so GitHub secret-scanning doesn't see a literal in source.
  const stripeKey = 's' + 'k_' + 'live_' + '123456789012345678901234';

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('redact-pipeline');
    namespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
    embeddingProbe.texts.length = 0;
  });

  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('redacts secrets before compression input, persisted summaries, and embedding source while preserving archive originals', async () => {
    const event: LocalContextEvent = {
      id: 'evt-stripe',
      target,
      eventType: 'assistant.text',
      content: `Bash deploy output contained ${stripeKey}`,
      metadata: { toolName: 'Bash' },
      createdAt: 100,
    };

    const serialized = serializeEvents([event], { maxEventChars: 2000 });
    expect(serialized).toContain('[REDACTED:stripe]');
    expect(serialized).not.toContain(stripeKey);

    const coordinator = new MaterializationCoordinator({
      compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent(event);
    const result = await coordinator.materializeTarget(target, 'manual', 200);

    expect(result.summaryProjection?.summary).toContain('[REDACTED:stripe]');
    expect(result.summaryProjection?.summary).not.toContain(stripeKey);
    expect(getArchivedEvent('evt-stripe')?.content).toContain(stripeKey);

    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-stripe'],
      summary: `Embedding source must redact ${stripeKey}`,
      content: {},
    });

    await searchLocalMemorySemantic({ query: 'embedding source', namespace, limit: 5 });
    const candidateTexts = embeddingProbe.texts.filter((text) => text.includes('Embedding source'));
    expect(candidateTexts.length).toBeGreaterThan(0);
    expect(candidateTexts.every((text) => !text.includes(stripeKey))).toBe(true);
    expect(candidateTexts.some((text) => text.includes('[REDACTED:stripe]'))).toBe(true);
  });
});
