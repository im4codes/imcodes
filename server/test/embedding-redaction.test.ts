/**
 * (memory-system-1.1-foundations P3 / spec.md:178)
 *
 * `storeProjectionEmbedding` MUST redact secrets before passing the summary
 * to the embedding model. This is defense-in-depth — replicated daemon
 * summaries should already be redacted, but a misbehaving daemon (or a
 * custom-pattern miss) must not be able to leak secrets into pgvector.
 *
 * The test captures the exact text the embedding worker receives by
 * injecting a fake `EmbeddingPool` and a fake `Database`, then asserts the
 * captured input contains the deterministic `[REDACTED:...]` tags rather
 * than the original key material.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingPool, __setEmbeddingPoolForTests } from '../src/util/embedding-pool.js';
import { storeProjectionEmbedding } from '../src/util/embedding.js';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';

class CapturingPool {
  inputs: string[] = [];
  isAvailable(): boolean { return true; }
  async embed(text: string): Promise<Float32Array | null> {
    this.inputs.push(text);
    return new Float32Array(EMBEDDING_DIM);
  }
  async terminate(): Promise<void> { /* no-op */ }
}

class FakeDatabase {
  executed: Array<{ sql: string; params: readonly unknown[] }> = [];
  async execute(sql: string, params: readonly unknown[]): Promise<void> {
    this.executed.push({ sql, params });
  }
  async query<T>(_sql: string, _params?: readonly unknown[]): Promise<T[]> {
    return [];
  }
}

describe('server-side embedding redaction (P3)', () => {
  let pool: CapturingPool;

  beforeEach(() => {
    pool = new CapturingPool();
    __setEmbeddingPoolForTests(pool as unknown as EmbeddingPool);
  });
  afterEach(() => {
    __setEmbeddingPoolForTests(null);
  });

  // Test fixtures assembled at runtime so that GitHub secret-scanning never
  // sees a literal secret-shaped string in the source. The redactor regex
  // does not care; it sees the concatenated value once execution reaches it.
  const fakeBearerTail = 'abcdef0123456789ZZZZZZ123456';
  const fakeAnthropicTail = 'api03-' + 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
  const fakeStripeTail = 'abcdefghijklmnopqrstuvwx';

  it('redacts a Bearer token before the embedding worker sees the summary', async () => {
    const db = new FakeDatabase();
    const token = 'Bea' + 'rer ' + fakeBearerTail;
    const summary = `project notes\nAuthorization: ${token}\nend`;
    await storeProjectionEmbedding(db as never, 'proj-1', summary);
    expect(pool.inputs.length).toBe(1);
    const seen = pool.inputs[0];
    expect(seen).toContain('[REDACTED:bearer]');
    expect(seen).not.toContain(token);
  });

  it('redacts an Anthropic API key before the embedding worker sees the summary', async () => {
    const db = new FakeDatabase();
    const key = 's' + 'k-' + 'ant-' + fakeAnthropicTail;
    const summary = `leaked secret ${key} context`;
    await storeProjectionEmbedding(db as never, 'proj-2', summary);
    expect(pool.inputs[0]).toContain('[REDACTED:anthropic_key]');
    expect(pool.inputs[0]).not.toContain(key);
  });

  it('redacts a Stripe live key before the embedding worker sees the summary', async () => {
    const db = new FakeDatabase();
    const key = 's' + 'k_' + 'live_' + fakeStripeTail;
    const summary = `use ${key} now`;
    await storeProjectionEmbedding(db as never, 'proj-3', summary);
    expect(pool.inputs[0]).toContain('[REDACTED:stripe]');
    expect(pool.inputs[0]).not.toContain(key);
  });
});
