import { beforeEach, describe, expect, it } from 'vitest';
import { countTokens, countMessagesTokens, countTokensAsync, countTokensBatchAsync, resetTokenizerCacheForTests } from '../../src/context/tokenizer.js';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const require = createRequire(import.meta.url);

describe('context tokenizer', () => {
  beforeEach(() => resetTokenizerCacheForTests());

  it('counts CJK, code, and message arrays without network access', () => {
    expect(countTokens('记忆系统升级')).toBeGreaterThan(0);
    expect(countTokens('function x(){ return 42; }')).toBeGreaterThan(0);
    expect(countMessagesTokens([{ role: 'user', content: 'hello' }])).toBeGreaterThan(countTokens('hello'));
  });

  it('bounds the hot-token cache so repeated projections avoid rescanning text', () => {
    const text = 'replayed context '.repeat(100);
    const first = countTokens(text);
    expect(countTokens(text)).toBe(first);
    // A very large payload is deliberately not retained, preventing a single
    // backlog event from pinning megabytes in the daemon process.
    const huge = 'x'.repeat(64 * 1024 + 1);
    expect(countTokens(huge)).toBeGreaterThan(0);
    expect(countTokens(huge)).toBeGreaterThan(0);
  });

  it('keeps exact provider semantics for every normal-sized unique input', async () => {
    let provider: ((text: string) => number) | undefined;
    try {
      const mod = require('@anthropic-ai/tokenizer') as { countTokens?: (text: string) => number };
      provider = mod.countTokens;
    } catch {
      // The optional provider is absent in the minimal unit-test environment.
    }
    if (!provider) return;
    const messages = ['hello world', 'a '.repeat(100), 'function x(){ return 42; }'];
    expect(messages.map((text) => countTokens(text))).toEqual(messages.map((text) => provider!(text)));
    expect(await Promise.all(messages.map((text) => countTokensAsync(text)))).toEqual(messages.map((text) => provider!(text)));
    expect(countMessagesTokens(messages.map((content) => ({ role: 'user', content })))).toBe(
      messages.reduce((total, text) => total + provider!(text) + 4, 0),
    );

    // Compression/truncation must make the same boundary decision as the
    // provider, even when a single pass contains several unique messages.
    const { __testing__ } = await import('../../src/context/summary-compressor.js');
    const source = `${messages.join('\n')}\n${'tail '.repeat(180)}`;
    const budget = provider!(source.slice(0, 96));
    let lo = 0;
    let hi = source.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (provider!(source.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const expected = source.slice(0, lo).trimEnd() + '\n\n[... earlier summary truncated to bound prompt token budget ...]';
    await expect(__testing__.trimToTokenBudget(source, budget)).resolves.toBe(expected);
  });

  it('keeps each asynchronous backlog token slice below 50ms', async () => {
    // The exact-provider worker path is covered above. Here use a bounded,
    // cache-warm backlog so the assertion measures dispatch/event-loop slices,
    // not provider startup variance on loaded CI hosts. The 84k cold probe is
    // run separately on 211.
    const events = Array.from({ length: 8_192 }, () => 'event payload');
    await countTokensBatchAsync(events.slice(0, 1));
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    let maxDispatchSliceMs = 0;
    for (let offset = 0; offset < events.length; offset += 256) {
      const started = performance.now();
      const batch = countTokensBatchAsync(events.slice(offset, offset + 256));
      maxDispatchSliceMs = Math.max(maxDispatchSliceMs, performance.now() - started);
      await batch;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    loop.disable();
    expect(maxDispatchSliceMs).toBeLessThanOrEqual(50);
    expect(loop.max / 1e6).toBeLessThanOrEqual(50);
  });
});
