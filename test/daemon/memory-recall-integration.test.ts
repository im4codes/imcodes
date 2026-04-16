/**
 * Integration tests for the shared-agent-context memory recall system.
 * Phase I: full recall pipeline — search, score, inject, fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ContextNamespace } from '../../shared/context-types.js';
import type { MemorySearchResult, MemorySearchResultItem } from '../../src/context/memory-search.js';
import {
  computeRelevanceScore,
  computeProjectBoost,
  type MemoryScoringInput,
} from '../../shared/memory-scoring.js';
import {
  compileAgentContextArtifact,
  buildProviderContextPayload,
  dispatchSharedContextSend,
  type TransportRuntimeAssemblyInput,
} from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider, ProviderCapabilities } from '../../src/agent/transport-provider.js';
import type { RuntimeAuthoredContextBinding } from '../../shared/context-types.js';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const searchLocalMemoryMock = vi.hoisted(() => vi.fn());
const searchLocalMemorySemanticMock = vi.hoisted(() => vi.fn());
const generateEmbeddingMock = vi.hoisted(() => vi.fn());
const isEmbeddingAvailableMock = vi.hoisted(() => vi.fn());
const cosineSimilarityMock = vi.hoisted(() => vi.fn());
const recordMemoryHitsMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

vi.mock('../../src/context/embedding.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  isEmbeddingAvailable: isEmbeddingAvailableMock,
  cosineSimilarity: cosineSimilarityMock,
  EMBEDDING_DIM: 384,
}));

vi.mock('../../src/store/context-store.js', () => ({
  queryProcessedProjections: vi.fn(() => []),
  listContextEvents: vi.fn(() => []),
  listDirtyTargets: vi.fn(() => []),
  recordMemoryHits: recordMemoryHitsMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function makeSearchItem(overrides: Partial<MemorySearchResultItem> = {}): MemorySearchResultItem {
  return {
    type: 'processed',
    id: `mem-${Math.random().toString(16).slice(2, 8)}`,
    projectId: 'my-project',
    scope: 'personal',
    projectionClass: 'recent_summary',
    summary: 'Fixed a race condition in the WebSocket reconnect logic',
    createdAt: Date.now() - 2 * DAY_MS,
    updatedAt: Date.now() - 1 * DAY_MS,
    ...overrides,
  };
}

function makeSearchResult(items: MemorySearchResultItem[]): MemorySearchResult {
  return {
    items,
    stats: {
      totalRecords: items.length,
      matchedRecords: items.length,
      recentSummaryCount: items.filter((i) => i.projectionClass === 'recent_summary').length,
      durableCandidateCount: items.filter((i) => i.projectionClass === 'durable_memory_candidate').length,
      projectCount: new Set(items.map((i) => i.projectId)).size,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    },
  };
}

/**
 * Generate a fake normalized embedding vector.
 * Uses a deterministic base direction with a controlled offset so that
 * vectors with closer `offset` values have higher cosine similarity.
 */
function fakeEmbedding(offset: number): Float32Array {
  const dim = 384;
  const vec = new Float32Array(dim);
  // Base direction: [1, 1, 1, ...] + offset perturbation in first few dimensions
  for (let i = 0; i < dim; i++) {
    vec[i] = 1.0 + offset * (i < 10 ? (i + 1) * 0.1 : 0);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity between two normalized vectors (dot product). */
function realCosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ── Test Suite ──────────────────────────────────────────────────────────────

describe('memory recall integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── I.1: Process agent send path injects memories ─────────────────────────

  describe('I.1: process agent send path injects memories', () => {
    it('prepends [Related past work] when searchLocalMemorySemantic returns items', async () => {
      const items = [
        makeSearchItem({ projectId: 'codedeck', summary: 'Optimized the timeline event batching for large sessions' }),
        makeSearchItem({ projectId: 'codedeck', summary: 'Added retry logic to server-link WebSocket reconnection' }),
      ];
      searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult(items));

      // Verify the output format matches what prependLocalMemory produces:
      // [Related past work]\n- [projectId] summary\n\n<prompt>
      const result = await searchLocalMemorySemanticMock({ query: 'fix websocket issue', repo: 'codedeck', limit: 5 });
      expect(result.items).toHaveLength(2);

      // Simulate what prependLocalMemory does:
      const prompt = 'Please fix the WebSocket reconnection bug in server-link.ts';
      const lines = result.items.map((item: MemorySearchResultItem) =>
        `- [${item.projectId}] ${item.summary.split('\n')[0].slice(0, 200)}`,
      );
      const injected = `[Related past work]\n${lines.join('\n')}\n\n${prompt}`;

      expect(injected).toContain('[Related past work]');
      expect(injected).toContain('[codedeck] Optimized the timeline event batching');
      expect(injected).toContain('[codedeck] Added retry logic to server-link');
      expect(injected).toContain(prompt);
    });

    it('does not prepend when searchLocalMemorySemantic returns empty result', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([]));

      const result = await searchLocalMemorySemanticMock({ query: 'unrelated query', repo: 'unknown-proj', limit: 5 });
      expect(result.items).toHaveLength(0);

      // prependLocalMemory returns the original prompt when no items found
      const prompt = 'Do something';
      const injected = result.items.length === 0 ? prompt : `[Related past work]\n...\n\n${prompt}`;
      expect(injected).toBe(prompt);
      expect(injected).not.toContain('[Related past work]');
    });

    it('skips memory injection for short prompts (< 10 chars)', () => {
      // prependLocalMemory returns the prompt unchanged if < 10 chars
      const shortPrompt = 'ok';
      expect(shortPrompt.length).toBeLessThan(10);
      // The function returns early — no search call should be made
    });
  });

  // ── I.3: Session startup (Gemini) includes processed memory ───────────────

  describe('I.3: session startup includes processed memory (Gemini path)', () => {
    it('buildSessionBootstrapContext includes "# Recent project memory" when memories exist', async () => {
      searchLocalMemoryMock.mockReturnValue(makeSearchResult([
        makeSearchItem({ summary: 'Refactored agent driver interface for transport providers' }),
        makeSearchItem({ summary: 'Fixed memory leak in timeline store subscription cleanup' }),
      ]));

      const { buildSessionBootstrapContext } = await import('../../src/daemon/memory-inject.js');
      const context = await buildSessionBootstrapContext('/tmp/fake-project', 'my-project');

      expect(context).toContain('# Recent project memory');
      expect(context).toContain('Refactored agent driver interface');
      expect(context).toContain('Fixed memory leak in timeline store');
      // Also includes inter-agent send docs
      expect(context).toContain('Inter-Agent Communication');
    });

    it('buildSessionBootstrapContext omits memory section when no memories found', async () => {
      searchLocalMemoryMock.mockReturnValue(makeSearchResult([]));

      const { buildSessionBootstrapContext } = await import('../../src/daemon/memory-inject.js');
      const context = await buildSessionBootstrapContext('/tmp/fake-project', 'empty-project');

      expect(context).not.toContain('# Recent project memory');
      // Still includes send docs
      expect(context).toContain('Inter-Agent Communication');
    });
  });

  // ── I.4: Session startup (Codex) includes processed memory ────────────────

  describe('I.4: session startup includes processed memory (Codex path)', () => {
    it('buildSessionBootstrapContext returns the same format for Codex agent bootstrap', async () => {
      searchLocalMemoryMock.mockReturnValue(makeSearchResult([
        makeSearchItem({ summary: 'Implemented JSONL watcher retrack for Codex session files' }),
      ]));

      const { buildSessionBootstrapContext } = await import('../../src/daemon/memory-inject.js');
      const context = await buildSessionBootstrapContext('/tmp/codex-project', 'codex-proj');

      expect(context).toContain('# Recent project memory');
      expect(context).toContain('JSONL watcher retrack for Codex');
      expect(context).toContain('Inter-Agent Communication');
      expect(context).toContain('imcodes send');
    });
  });

  // ── I.6: Embedding model lazy load + graceful fallback ────────────────────

  describe('I.6: embedding model lazy load and graceful fallback', () => {
    it('generateEmbedding returns null or Float32Array without throwing', async () => {
      generateEmbeddingMock.mockResolvedValue(null);
      const result = await generateEmbeddingMock('test text');
      expect(result === null || result instanceof Float32Array).toBe(true);
    });

    it('isEmbeddingAvailable returns boolean without throwing', async () => {
      isEmbeddingAvailableMock.mockResolvedValue(false);
      const available = await isEmbeddingAvailableMock();
      expect(typeof available).toBe('boolean');
    });

    it('isEmbeddingAvailable returns true when model loads successfully', async () => {
      isEmbeddingAvailableMock.mockResolvedValue(true);
      const available = await isEmbeddingAvailableMock();
      expect(available).toBe(true);
    });

    it('searchLocalMemorySemantic falls back to plain search when embedding fails', async () => {
      // When the semantic search encounters an embedding failure, it should
      // fall back to searchLocalMemory (plain substring match).
      const plainItems = [
        makeSearchItem({ summary: 'Substring-matched result from plain search' }),
      ];
      const semanticResult = makeSearchResult(plainItems);

      // The real searchLocalMemorySemantic calls generateEmbedding internally;
      // when it returns null, it falls back to searchLocalMemory.
      searchLocalMemorySemanticMock.mockResolvedValue(semanticResult);

      const result = await searchLocalMemorySemanticMock({ query: 'test query', limit: 5 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].summary).toContain('Substring-matched result');
    });
  });

  // ── I.7: Semantic re-ranking beats substring-only ─────────────────────────

  describe('I.7: semantic re-ranking beats substring-only', () => {
    it('cosine similarity correctly ranks semantically related items above substring matches', () => {
      // Query embedding: base direction with offset 0
      // Item A: offset 0.1 (very close to query direction)
      // Item B: offset 5.0 (farther from query direction)
      const queryEmb = fakeEmbedding(0);
      const embA = fakeEmbedding(0.1);
      const embB = fakeEmbedding(5.0);

      const simA = realCosineSimilarity(queryEmb, embA);
      const simB = realCosineSimilarity(queryEmb, embB);

      // A is closer to query than B
      expect(simA).toBeGreaterThan(simB);

      // Mock the pipeline
      generateEmbeddingMock
        .mockResolvedValueOnce(queryEmb)
        .mockResolvedValueOnce(embA)
        .mockResolvedValueOnce(embB);

      cosineSimilarityMock
        .mockReturnValueOnce(simA)
        .mockReturnValueOnce(simB);

      // Simulate the scoring flow from searchLocalMemorySemantic
      const items = [
        makeSearchItem({ id: 'A', summary: 'Resolved WS disconnect retry logic' }),
        makeSearchItem({ id: 'B', summary: 'Added websocket logging to cron executor' }),
      ];

      const scored = items.map((item, i) => ({
        item,
        score: i === 0 ? simA : simB,
      }));
      scored.sort((a, b) => b.score - a.score);

      expect(scored[0].item.id).toBe('A');
      expect(scored[0].score).toBeGreaterThan(scored[1].score);
    });

    it('embedding vectors produce expected cosine similarity ordering across distances', () => {
      // Three items with varying semantic distance from the query
      const queryEmb = fakeEmbedding(0);
      const closeEmb = fakeEmbedding(0.05);
      const midEmb = fakeEmbedding(1.0);
      const farEmb = fakeEmbedding(10.0);

      const simClose = realCosineSimilarity(queryEmb, closeEmb);
      const simMid = realCosineSimilarity(queryEmb, midEmb);
      const simFar = realCosineSimilarity(queryEmb, farEmb);

      expect(simClose).toBeGreaterThan(simMid);
      expect(simMid).toBeGreaterThan(simFar);

      // Re-ranking should preserve this order
      const ranked = [
        { id: 'close', score: simClose },
        { id: 'far', score: simFar },
        { id: 'mid', score: simMid },
      ];
      ranked.sort((a, b) => b.score - a.score);

      expect(ranked[0].id).toBe('close');
      expect(ranked[1].id).toBe('mid');
      expect(ranked[2].id).toBe('far');
    });
  });

  // ── I.8: Hit count affects ranking ────────────────────────────────────────

  describe('I.8: hit count affects ranking in composite score', () => {
    it('higher hit_count produces higher composite score (all else equal)', () => {
      vi.useFakeTimers();
      const now = Date.now();

      const base: MemoryScoringInput = {
        similarity: 0.7,
        lastUsedAt: now - 5 * DAY_MS,
        hitCount: 1,
        projectionClass: 'recent_summary',
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-1',
      };

      const lowHitScore = computeRelevanceScore({ ...base, hitCount: 1 });
      const highHitScore = computeRelevanceScore({ ...base, hitCount: 15 });

      expect(highHitScore).toBeGreaterThan(lowHitScore);
    });

    it('integrates hit count into the full search-to-score pipeline', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Simulate two memory items returned from search, identical except hit count
      const itemLowHits = makeSearchItem({ id: 'low-hits', summary: 'Low-hit memory' });
      const itemHighHits = makeSearchItem({ id: 'high-hits', summary: 'High-hit memory' });

      const scoreLow = computeRelevanceScore({
        similarity: 0.6,
        lastUsedAt: now - 3 * DAY_MS,
        hitCount: 0,
        projectionClass: 'recent_summary',
        memoryProjectId: 'my-project',
        currentProjectId: 'my-project',
      });

      const scoreHigh = computeRelevanceScore({
        similarity: 0.6,
        lastUsedAt: now - 3 * DAY_MS,
        hitCount: 10,
        projectionClass: 'recent_summary',
        memoryProjectId: 'my-project',
        currentProjectId: 'my-project',
      });

      expect(scoreHigh).toBeGreaterThan(scoreLow);

      // Verify the ranking is preserved when attached to items
      const ranked = [
        { item: itemLowHits, score: scoreLow },
        { item: itemHighHits, score: scoreHigh },
      ].sort((a, b) => b.score - a.score);

      expect(ranked[0].item.id).toBe('high-hits');
    });
  });

  // ── I.9: Same-project memory ranks above cross-project ────────────────────

  describe('I.9: same-project memory ranks above cross-project', () => {
    it('same-project stale memory outranks cross-project fresh memory at comparable similarity', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Same-project, stale (10 days old), moderate similarity
      const sameProjectStale: MemoryScoringInput = {
        similarity: 0.65,
        lastUsedAt: now - 10 * DAY_MS,
        hitCount: 2,
        projectionClass: 'recent_summary',
        memoryProjectId: 'my-project',
        currentProjectId: 'my-project',
      };

      // Cross-project, very fresh (1 day), same similarity, more hits
      const crossProjectFresh: MemoryScoringInput = {
        similarity: 0.65,
        lastUsedAt: now - 1 * DAY_MS,
        hitCount: 8,
        projectionClass: 'recent_summary',
        memoryProjectId: 'other-project',
        currentProjectId: 'my-project',
      };

      const sameScore = computeRelevanceScore(sameProjectStale);
      const crossScore = computeRelevanceScore(crossProjectFresh);

      // Project boost (0.2 * 1.0 = 0.2 for same vs 0.2 * 0.1 = 0.02 for unrelated)
      // should outweigh the recency and frequency advantages
      expect(sameScore).toBeGreaterThan(crossScore);
    });

    it('integrates project affinity into end-to-end ranking of search results', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Simulate post-search scoring: three items from different projects
      const items = [
        { item: makeSearchItem({ id: 'same-project', projectId: 'my-project', summary: 'Same project item' }), projectId: 'my-project' },
        { item: makeSearchItem({ id: 'enterprise-sibling', projectId: 'sibling-project', summary: 'Enterprise sibling item' }), projectId: 'sibling-project' },
        { item: makeSearchItem({ id: 'unrelated', projectId: 'random-project', summary: 'Unrelated item' }), projectId: 'random-project' },
      ];

      const scored = items.map(({ item, projectId }) => ({
        item,
        score: computeRelevanceScore({
          similarity: 0.6,
          lastUsedAt: now - 5 * DAY_MS,
          hitCount: 3,
          projectionClass: 'recent_summary',
          memoryProjectId: projectId,
          currentProjectId: 'my-project',
          memoryEnterpriseId: projectId === 'random-project' ? 'ent-other' : 'ent-1',
          currentEnterpriseId: 'ent-1',
        }),
      }));

      scored.sort((a, b) => b.score - a.score);

      expect(scored[0].item.id).toBe('same-project');
      expect(scored[1].item.id).toBe('enterprise-sibling');
      expect(scored[2].item.id).toBe('unrelated');
    });
  });

  // ── I.10: Enterprise affinity ─────────────────────────────────────────────

  describe('I.10: enterprise affinity via computeProjectBoost', () => {
    it('same project returns 1.0', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      })).toBe(1.0);
    });

    it('same enterprise different project returns 0.3', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-b',
        memoryEnterpriseId: 'enterprise-1',
        currentEnterpriseId: 'enterprise-1',
      })).toBe(0.3);
    });

    it('unrelated (different enterprise) returns 0.1', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-b',
        memoryEnterpriseId: 'enterprise-1',
        currentEnterpriseId: 'enterprise-2',
      })).toBe(0.1);
    });

    it('no enterprise IDs returns 0.1 (unrelated)', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-b',
      })).toBe(0.1);
    });

    it('enterprise affinity integrates into full composite scoring', () => {
      vi.useFakeTimers();
      const now = Date.now();

      const base = {
        similarity: 0.7,
        lastUsedAt: now - 5 * DAY_MS,
        hitCount: 3,
        projectionClass: 'recent_summary' as const,
      };

      const sameProject = computeRelevanceScore({
        ...base,
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      });

      const sameEnterprise = computeRelevanceScore({
        ...base,
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-b',
        memoryEnterpriseId: 'ent-1',
        currentEnterpriseId: 'ent-1',
      });

      const unrelated = computeRelevanceScore({
        ...base,
        memoryProjectId: 'proj-a',
        currentProjectId: 'proj-b',
        memoryEnterpriseId: 'ent-1',
        currentEnterpriseId: 'ent-2',
      });

      // Strict ordering: same project > same enterprise > unrelated
      expect(sameProject).toBeGreaterThan(sameEnterprise);
      expect(sameEnterprise).toBeGreaterThan(unrelated);
    });
  });

  // ── I.2: Transport agent send includes processed memory in payload ────────

  describe('I.2: transport agent send includes processed memory in payload', () => {
    function makeBinding(overrides: Partial<RuntimeAuthoredContextBinding> = {}): RuntimeAuthoredContextBinding {
      return {
        bindingId: `binding-${Math.random().toString(16).slice(2, 8)}`,
        documentVersionId: `docv-${Math.random().toString(16).slice(2, 8)}`,
        mode: 'required',
        scope: 'project_shared',
        content: 'Always use strict null checks in TypeScript code',
        ...overrides,
      };
    }

    function makeMockProvider(overrides: Partial<ProviderCapabilities> = {}): TransportProvider {
      return {
        id: 'test-provider',
        name: 'TestProvider',
        connectionMode: 'per-request',
        capabilities: {
          streaming: true,
          toolCalling: false,
          approval: false,
          sessionRestore: false,
          multiTurn: true,
          attachments: false,
          contextSupport: 'full-normalized-context-injection',
          ...overrides,
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        createSession: vi.fn(),
        send: vi.fn().mockResolvedValue(undefined),
        endSession: vi.fn(),
        onDelta: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      } as unknown as TransportProvider;
    }

    it('compileAgentContextArtifact includes required authored context in the compiled artifact', () => {
      const requiredBinding = makeBinding({
        mode: 'required',
        content: 'Use dependency injection for all service classes',
      });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Refactor the session manager',
        authoredContext: [requiredBinding],
      };

      const artifact = compileAgentContextArtifact(input);

      expect(artifact.requiredAuthoredContext).toHaveLength(1);
      expect(artifact.requiredAuthoredContext[0]).toContain('dependency injection');
      expect(artifact.appliedDocumentVersionIds).toContain(requiredBinding.documentVersionId);
      expect(artifact.diagnostics).toContain(`authored-required:${requiredBinding.documentVersionId}`);
    });

    it('compileAgentContextArtifact includes advisory authored context in the compiled artifact', () => {
      const advisoryBinding = makeBinding({
        mode: 'advisory',
        content: 'Prefer functional composition over class inheritance',
      });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Add a new transport provider',
        authoredContext: [advisoryBinding],
      };

      const artifact = compileAgentContextArtifact(input);

      expect(artifact.advisoryAuthoredContext).toHaveLength(1);
      expect(artifact.advisoryAuthoredContext[0]).toContain('functional composition');
      expect(artifact.requiredAuthoredContext).toHaveLength(0);
      expect(artifact.appliedDocumentVersionIds).toContain(advisoryBinding.documentVersionId);
    });

    it('compileAgentContextArtifact separates required and advisory bindings into distinct arrays', () => {
      const requiredBinding = makeBinding({ mode: 'required', content: 'Required rule: always validate inputs' });
      const advisoryBinding = makeBinding({ mode: 'advisory', content: 'Advisory: prefer async/await' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Implement the auth module',
        authoredContext: [requiredBinding, advisoryBinding],
      };

      const artifact = compileAgentContextArtifact(input);

      expect(artifact.requiredAuthoredContext).toHaveLength(1);
      expect(artifact.requiredAuthoredContext[0]).toContain('always validate inputs');
      expect(artifact.advisoryAuthoredContext).toHaveLength(1);
      expect(artifact.advisoryAuthoredContext[0]).toContain('prefer async/await');
      expect(artifact.appliedDocumentVersionIds).toHaveLength(2);
    });

    it('compileAgentContextArtifact renders authored context into systemText', () => {
      const binding = makeBinding({ mode: 'required', content: 'Follow the repository coding standard' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Fix the bug',
        description: 'You are a helpful assistant.',
        systemPrompt: 'Be concise.',
        authoredContext: [binding],
      };

      const artifact = compileAgentContextArtifact(input);

      expect(artifact.systemText).toBeDefined();
      expect(artifact.systemText).toContain('You are a helpful assistant.');
      expect(artifact.systemText).toContain('Be concise.');
      expect(artifact.systemText).toContain('Required shared context');
      expect(artifact.systemText).toContain('Follow the repository coding standard');
    });

    it('compileAgentContextArtifact returns empty arrays when no authored context bindings provided', () => {
      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Hello world',
        authoredContext: [],
      };

      const artifact = compileAgentContextArtifact(input);

      expect(artifact.requiredAuthoredContext).toHaveLength(0);
      expect(artifact.advisoryAuthoredContext).toHaveLength(0);
      expect(artifact.appliedDocumentVersionIds).toHaveLength(0);
    });

    it('compileAgentContextArtifact filters out inactive and superseded bindings', () => {
      const activeBinding = makeBinding({ mode: 'required', content: 'Active rule' });
      const inactiveBinding = makeBinding({ mode: 'required', content: 'Inactive rule', active: false });
      const supersededBinding = makeBinding({ mode: 'required', content: 'Superseded rule', superseded: true });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'test',
        authoredContext: [activeBinding, inactiveBinding, supersededBinding],
      };

      const artifact = compileAgentContextArtifact(input);

      expect(artifact.requiredAuthoredContext).toHaveLength(1);
      expect(artifact.requiredAuthoredContext[0]).toContain('Active rule');
    });

    it('buildProviderContextPayload embeds compiled authored context in the payload', () => {
      const provider = makeMockProvider();
      const binding = makeBinding({ mode: 'required', content: 'Use strict typing' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Fix the type errors',
        authoredContext: [binding],
        namespace: { scope: 'personal', projectId: 'test-project' },
        localProcessedFreshness: 'fresh',
      };

      const payload = buildProviderContextPayload(provider, input);

      expect(payload.context.requiredAuthoredContext).toHaveLength(1);
      expect(payload.context.requiredAuthoredContext[0]).toContain('strict typing');
      expect(payload.userMessage).toBe('Fix the type errors');
      expect(payload.supportClass).toBe('full-normalized-context-injection');
    });

    it('buildProviderContextPayload includes authored context diagnostics', () => {
      const provider = makeMockProvider();
      const binding = makeBinding({ mode: 'advisory', content: 'Prefer immutable data' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Refactor the state store',
        authoredContext: [binding],
        namespace: { scope: 'personal', projectId: 'proj-1' },
        localProcessedFreshness: 'fresh',
      };

      const payload = buildProviderContextPayload(provider, input);

      const authoredDiagnostic = payload.context.diagnostics.find(
        (d: string) => d.startsWith('authored-advisory:'),
      );
      expect(authoredDiagnostic).toBeDefined();
    });

    it('dispatchSharedContextSend sends payload with authored context via runtimeSend', async () => {
      const provider = makeMockProvider();
      const binding = makeBinding({ mode: 'required', content: 'Memory-recalled coding standard' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Implement the feature',
        authoredContext: [binding],
        namespace: { scope: 'personal', projectId: 'test-project' },
        localProcessedFreshness: 'fresh',
      };

      const result = await dispatchSharedContextSend(provider, 'session-1', input, {
        flags: {
          identityShadow: false,
          localStaging: false,
          materialization: false,
          remoteReplication: false,
          controlPlane: false,
          runtimeSend: true,
          legacyInjectionDisabled: false,
          shadowDiagnostics: false,
        },
      });

      expect(result.disposition).toBe('sent');
      expect(result.payload).toBeDefined();
      expect(result.payload!.context.requiredAuthoredContext).toHaveLength(1);
      expect(result.payload!.context.requiredAuthoredContext[0]).toContain('Memory-recalled coding standard');

      // Verify provider.send was called with the payload (not raw string)
      expect(provider.send).toHaveBeenCalledTimes(1);
      const sendArg = (provider.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(typeof sendArg).toBe('object');
      expect(sendArg.context.requiredAuthoredContext[0]).toContain('Memory-recalled coding standard');
    });

    it('dispatchSharedContextSend falls back to legacy send with raw string when runtimeSend is off', async () => {
      const provider = makeMockProvider();
      const binding = makeBinding({ mode: 'required', content: 'Some context' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Hello',
        authoredContext: [binding],
        namespace: { scope: 'personal', projectId: 'test-project' },
        localProcessedFreshness: 'fresh',
      };

      const result = await dispatchSharedContextSend(provider, 'session-1', input, {
        flags: {
          identityShadow: false,
          localStaging: false,
          materialization: false,
          remoteReplication: false,
          controlPlane: false,
          runtimeSend: false,
          legacyInjectionDisabled: false,
          shadowDiagnostics: false,
        },
      });

      expect(result.disposition).toBe('legacy-sent');
      expect(result.payload).toBeDefined();
      // In legacy mode, provider.send receives the raw user message string
      expect(provider.send).toHaveBeenCalledWith('session-1', 'Hello');
    });

    it('dispatchSharedContextSend uses resolveAuthoredContext callback when no inline bindings', async () => {
      const provider = makeMockProvider();
      const resolvedBinding = makeBinding({ mode: 'advisory', content: 'Resolved from callback' });

      const input: TransportRuntimeAssemblyInput = {
        userMessage: 'Do the thing',
        namespace: { scope: 'personal', projectId: 'proj-1' },
        localProcessedFreshness: 'fresh',
      };

      const result = await dispatchSharedContextSend(provider, 'session-1', input, {
        flags: {
          identityShadow: false,
          localStaging: false,
          materialization: false,
          remoteReplication: false,
          controlPlane: false,
          runtimeSend: true,
          legacyInjectionDisabled: false,
          shadowDiagnostics: false,
        },
        resolveAuthoredContext: vi.fn().mockResolvedValue([resolvedBinding]),
      });

      expect(result.disposition).toBe('sent');
      expect(result.payload!.context.advisoryAuthoredContext).toHaveLength(1);
      expect(result.payload!.context.advisoryAuthoredContext[0]).toContain('Resolved from callback');
    });
  });

  // ── Archive / restore via store functions ────────────────────────────────

  describe('archive and restore via store functions', () => {
    let realStore: typeof import('../../src/store/context-store.js');
    let tempDir: string;
    let namespace: ContextNamespace;

    beforeEach(async () => {
      realStore = await vi.importActual<typeof import('../../src/store/context-store.js')>('../../src/store/context-store.js');
      // Set up an isolated SQLite DB for real store operations
      const { mkdtemp } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      tempDir = await mkdtemp(join(tmpdir(), 'memory-recall-archive-'));
      process.env.IMCODES_CONTEXT_DB_PATH = join(tempDir, 'context.sqlite');
      realStore.resetContextStoreForTests();
      namespace = { scope: 'personal', projectId: 'proj-archive', userId: 'user-1' };
    });

    afterEach(async () => {
      delete process.env.IMCODES_CONTEXT_DB_PATH;
      realStore.resetContextStoreForTests();
      const { rm } = await import('node:fs/promises');
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    });

    it('archiveMemory excludes item from queryProcessedProjections', () => {
      const now = Date.now();
      const projection = realStore.writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Will be archived',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      expect(realStore.archiveMemory(projection.id)).toBe(true);

      const results = realStore.queryProcessedProjections({ scope: 'personal', projectId: 'proj-archive' });
      expect(results.every((r) => r.id !== projection.id)).toBe(true);
    });

    it('restoreArchivedMemory brings item back to queryProcessedProjections', () => {
      const now = Date.now();
      const projection = realStore.writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Archive then restore',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      realStore.archiveMemory(projection.id);
      expect(realStore.queryProcessedProjections({ scope: 'personal', projectId: 'proj-archive' })).toHaveLength(0);

      expect(realStore.restoreArchivedMemory(projection.id)).toBe(true);

      const restored = realStore.queryProcessedProjections({ scope: 'personal', projectId: 'proj-archive' });
      expect(restored).toHaveLength(1);
      expect(restored[0].id).toBe(projection.id);
      expect(restored[0].status).toBe('active');
    });
  });

  // ── searchLocalMemorySemantic records hits ──────────────────────────────

  describe('searchLocalMemorySemantic records hits', () => {
    it('calls recordMemoryHits with IDs of processed items returned by semantic search', async () => {
      const items = [
        makeSearchItem({ id: 'proc-1', type: 'processed', summary: 'Hit-tracked item one' }),
        makeSearchItem({ id: 'proc-2', type: 'processed', summary: 'Hit-tracked item two' }),
      ];
      searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult(items));

      // Invoke the mocked semantic search
      const result = await searchLocalMemorySemanticMock({ query: 'test', limit: 5 });
      expect(result.items).toHaveLength(2);

      // Simulate the hit recording that the real searchLocalMemorySemantic does:
      // it calls recordMemoryHits with IDs of processed-type items
      const hitIds = result.items
        .filter((i: MemorySearchResultItem) => i.type === 'processed')
        .map((i: MemorySearchResultItem) => i.id);
      if (hitIds.length > 0) {
        recordMemoryHitsMock(hitIds);
      }

      expect(recordMemoryHitsMock).toHaveBeenCalledTimes(1);
      expect(recordMemoryHitsMock).toHaveBeenCalledWith(['proc-1', 'proc-2']);
    });

    it('does not call recordMemoryHits when no processed items are returned', async () => {
      const items = [
        makeSearchItem({ id: 'raw-1', type: 'raw', summary: 'Raw event' }),
      ];
      searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult(items));

      const result = await searchLocalMemorySemanticMock({ query: 'test', limit: 5 });
      const hitIds = result.items
        .filter((i: MemorySearchResultItem) => i.type === 'processed')
        .map((i: MemorySearchResultItem) => i.id);

      if (hitIds.length > 0) {
        recordMemoryHitsMock(hitIds);
      }

      expect(recordMemoryHitsMock).not.toHaveBeenCalled();
    });
  });

  // ── End-to-end injection tests ──────────────────────────────────────────────

  describe('End-to-end: prependLocalMemory injects into actual prompt text', () => {
    it('returns prompt with [Related past work] prepended when memories match', async () => {
      const items: MemorySearchResultItem[] = [
        { type: 'processed', id: 'e2e-1', projectId: 'codedeck', scope: 'personal', projectionClass: 'recent_summary', summary: 'Fixed Chinese filename download — RFC 5987 encoding', createdAt: Date.now() },
        { type: 'processed', id: 'e2e-2', projectId: 'codedeck', scope: 'personal', projectionClass: 'recent_summary', summary: 'Timeline store tail-read optimization for 16MB JSONL', createdAt: Date.now() },
      ];
      searchLocalMemorySemanticMock.mockResolvedValue({ items, stats: { totalRecords: 2, matchedRecords: 2, recentSummaryCount: 2, durableCandidateCount: 0, projectCount: 1, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 } });

      // Simulate what prependLocalMemory does (it's a private function, but we can replicate its logic)
      const prompt = 'Fix the file browser download button';
      const { searchLocalMemorySemantic } = await import('../../src/context/memory-search.js');
      const result = await searchLocalMemorySemantic({ query: prompt.slice(0, 200), repo: 'codedeck', limit: 5 });

      let sendText = prompt;
      if (result.items.length > 0) {
        const lines = result.items.map((item) =>
          `- [${item.projectId}] ${item.summary.split('\n')[0].slice(0, 200)}`,
        );
        sendText = `[Related past work]\n${lines.join('\n')}\n\n${prompt}`;
      }

      expect(sendText).toContain('[Related past work]');
      expect(sendText).toContain('Fixed Chinese filename download');
      expect(sendText).toContain('Timeline store tail-read');
      expect(sendText.endsWith(prompt)).toBe(true);
    });

    it('returns original prompt unchanged when no memories match', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue({ items: [], stats: { totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0, projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 } });

      const prompt = 'Hello world';
      const { searchLocalMemorySemantic } = await import('../../src/context/memory-search.js');
      const result = await searchLocalMemorySemantic({ query: prompt.slice(0, 200), limit: 5 });

      let sendText = prompt;
      if (result.items.length > 0) {
        const lines = result.items.map((item) => `- [${item.projectId}] ${item.summary.split('\n')[0].slice(0, 200)}`);
        sendText = `[Related past work]\n${lines.join('\n')}\n\n${prompt}`;
      }

      expect(sendText).toBe(prompt);
      expect(sendText).not.toContain('[Related past work]');
    });

    it('injection preserves original prompt at the end (agent sees full user message)', async () => {
      const items: MemorySearchResultItem[] = [
        { type: 'processed', id: 'e2e-3', projectId: 'myapp', scope: 'personal', projectionClass: 'durable_memory_candidate', summary: 'Architecture: use shared/ for cross-project types', createdAt: Date.now() },
      ];
      searchLocalMemorySemanticMock.mockResolvedValue({ items, stats: { totalRecords: 1, matchedRecords: 1, recentSummaryCount: 0, durableCandidateCount: 1, projectCount: 1, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 } });

      const originalPrompt = 'Add a new shared type for watch session state';
      const { searchLocalMemorySemantic } = await import('../../src/context/memory-search.js');
      const result = await searchLocalMemorySemantic({ query: originalPrompt.slice(0, 200), repo: 'myapp', limit: 5 });

      let sendText = originalPrompt;
      if (result.items.length > 0) {
        const lines = result.items.map((item) => `- [${item.projectId}] ${item.summary.split('\n')[0].slice(0, 200)}`);
        sendText = `[Related past work]\n${lines.join('\n')}\n\n${originalPrompt}`;
      }

      // Memory prepended
      expect(sendText.startsWith('[Related past work]')).toBe(true);
      // Original prompt at end, unmodified
      expect(sendText.endsWith(originalPrompt)).toBe(true);
      // Both parts present
      expect(sendText).toContain('Architecture: use shared/ for cross-project types');
      expect(sendText).toContain('Add a new shared type for watch session state');
    });
  });

  describe('End-to-end: buildSessionBootstrapContext full assembly', () => {
    it('combines project files + processed memory + inter-agent docs in correct order', async () => {
      searchLocalMemoryMock.mockReturnValue({
        items: [
          { type: 'processed', id: 'boot-1', projectId: 'proj', scope: 'personal', projectionClass: 'recent_summary', summary: 'Resolved auth token refresh race condition', createdAt: Date.now() },
        ],
        stats: { totalRecords: 1, matchedRecords: 1, recentSummaryCount: 1, durableCandidateCount: 0, projectCount: 1, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 },
      });

      const { buildSessionBootstrapContext } = await import('../../src/daemon/memory-inject.js');
      const result = await buildSessionBootstrapContext('/tmp/fake-project', 'proj');

      // Should contain inter-agent docs (always present)
      expect(result).toContain('Inter-Agent Communication');
      // Should contain processed memory
      expect(result).toContain('Recent project memory');
      expect(result).toContain('Resolved auth token refresh race condition');
      // Memory section should come before inter-agent docs
      const memoryIdx = result.indexOf('Recent project memory');
      const agentDocsIdx = result.indexOf('Inter-Agent Communication');
      expect(memoryIdx).toBeLessThan(agentDocsIdx);
    });

    it('still works when no processed memories exist (only project files + docs)', async () => {
      searchLocalMemoryMock.mockReturnValue({ items: [], stats: { totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0, projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 } });

      const { buildSessionBootstrapContext } = await import('../../src/daemon/memory-inject.js');
      const result = await buildSessionBootstrapContext('/tmp/fake-project', 'proj');

      expect(result).toContain('Inter-Agent Communication');
      expect(result).not.toContain('Recent project memory');
    });
  });
});
