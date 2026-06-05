import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingQuestionRegistry } from '../../src/agent/pending-question-registry.js';

type R = { kind: 'answer' | 'fallback'; value?: string };
const FALLBACK: R = { kind: 'fallback' };

describe('PendingQuestionRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves with the answered result when resolve() is called in time', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const p = reg.wait('s1', { timeoutMs: 60_000, fallback: FALLBACK });
    expect(reg.has('s1')).toBe(true);
    expect(reg.resolve('s1', { kind: 'answer', value: 'A' })).toBe(true);
    await expect(p).resolves.toEqual({ kind: 'answer', value: 'A' });
    expect(reg.has('s1')).toBe(false); // cleared after settle
  });

  it('falls back after the timeout when unanswered', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const p = reg.wait('s1', { timeoutMs: 60_000, fallback: FALLBACK });
    vi.advanceTimersByTime(60_000);
    await expect(p).resolves.toEqual(FALLBACK);
    expect(reg.has('s1')).toBe(false);
  });

  it('resolve() returns false when nothing is pending', () => {
    const reg = new PendingQuestionRegistry<R>();
    expect(reg.resolve('nope', { kind: 'answer', value: 'x' })).toBe(false);
  });

  it('falls back on abort signal', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const ac = new AbortController();
    const p = reg.wait('s1', { timeoutMs: 60_000, fallback: FALLBACK, signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toEqual(FALLBACK);
    expect(reg.has('s1')).toBe(false);
  });

  it('release() resolves a pending question with its fallback', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const p = reg.wait('s1', { timeoutMs: 60_000, fallback: FALLBACK });
    reg.release('s1');
    await expect(p).resolves.toEqual(FALLBACK);
    expect(reg.has('s1')).toBe(false);
  });

  it('a second wait() for the same session releases the stale one', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const p1 = reg.wait('s1', { timeoutMs: 60_000, fallback: FALLBACK });
    const p2 = reg.wait('s1', { timeoutMs: 60_000, fallback: { kind: 'fallback', value: '2nd' } });
    await expect(p1).resolves.toEqual(FALLBACK); // stale one settled with its fallback
    expect(reg.resolve('s1', { kind: 'answer', value: 'B' })).toBe(true);
    await expect(p2).resolves.toEqual({ kind: 'answer', value: 'B' });
  });

  it('a late resolve after timeout is a no-op (idempotent settle)', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const p = reg.wait('s1', { timeoutMs: 1000, fallback: FALLBACK });
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toEqual(FALLBACK);
    expect(reg.resolve('s1', { kind: 'answer', value: 'too late' })).toBe(false);
  });

  it('releaseAll() resolves every pending question', async () => {
    const reg = new PendingQuestionRegistry<R>();
    const p1 = reg.wait('s1', { timeoutMs: 60_000, fallback: FALLBACK });
    const p2 = reg.wait('s2', { timeoutMs: 60_000, fallback: FALLBACK });
    reg.releaseAll();
    await expect(Promise.all([p1, p2])).resolves.toEqual([FALLBACK, FALLBACK]);
    expect(reg.has('s1')).toBe(false);
    expect(reg.has('s2')).toBe(false);
  });
});
