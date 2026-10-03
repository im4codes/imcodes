import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchContextBootstrap } from '../../src/agent/launch-context-bootstrap.js';
import type { TransportContextBootstrap, TransportContextNamespaceStage } from '../../src/agent/runtime-context-bootstrap.js';

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NAMESPACE = { scope: 'personal', projectId: 'github.com/acme/repo' } as const;
const FULL: TransportContextBootstrap = {
  namespace: NAMESPACE,
  diagnostics: ['namespace:git-origin'],
  localProcessedFreshness: 'fresh',
  startupMemory: { reason: 'startup' } as unknown as TransportContextBootstrap['startupMemory'],
};
const STAGE: TransportContextNamespaceStage = { namespace: NAMESPACE, diagnostics: ['namespace:git-origin'] };

describe('resolveLaunchContextBootstrap', () => {
  beforeEach(() => { vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '80'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns the full bootstrap untouched when it arrives inside the budget', async () => {
    const result = await resolveLaunchContextBootstrap('deck_a_brain', async (onNamespace) => {
      onNamespace(STAGE);
      return FULL;
    });
    expect(result).toEqual({ bootstrap: FULL });
    expect(result.deferred).toBeUndefined();
  });

  it('on timeout keeps the namespace stage, marks the launch, and hands back the still-running bootstrap', async () => {
    let finish!: (b: TransportContextBootstrap) => void;
    const running = new Promise<TransportContextBootstrap>((resolve) => { finish = resolve; });
    const startedAt = Date.now();
    const result = await resolveLaunchContextBootstrap('deck_a_brain', (onNamespace) => {
      onNamespace(STAGE);
      return running;
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.bootstrap.namespace).toEqual(NAMESPACE);
    expect(result.bootstrap.diagnostics).toEqual(['namespace:git-origin', 'context-bootstrap:launch-timeout']);
    expect(result.bootstrap.startupMemory).toBeUndefined();
    expect(result.bootstrap.localProcessedFreshness).toBeUndefined();
    expect(result.deferred).toBeDefined();
    finish(FULL);
    await expect(result.deferred).resolves.toEqual(FULL);
  });

  it('on timeout before the namespace is known there is no namespace, only the marker', async () => {
    const result = await resolveLaunchContextBootstrap('deck_a_brain', () => new Promise<TransportContextBootstrap>(() => { /* never */ }));
    expect(result.bootstrap.namespace).toBeUndefined();
    expect(result.bootstrap.diagnostics).toEqual(['context-bootstrap:launch-timeout']);
    expect(result.deferred).toBeDefined();
  });

  it('a rejected bootstrap no longer fails the launch: the namespace stage survives, nothing is deferred', async () => {
    const result = await resolveLaunchContextBootstrap('deck_a_brain', async (onNamespace) => {
      onNamespace(STAGE);
      throw new Error('context store worker lost');
    });
    expect(result.bootstrap.namespace).toEqual(NAMESPACE);
    expect(result.bootstrap.diagnostics).toEqual(['namespace:git-origin', 'context-bootstrap:launch-failed']);
    expect(result.deferred).toBeUndefined();
  });

  it('a resolver that throws synchronously is treated the same way', async () => {
    const result = await resolveLaunchContextBootstrap('deck_a_brain', () => { throw new Error('boom'); });
    expect(result.bootstrap.namespace).toBeUndefined();
    expect(result.bootstrap.diagnostics).toEqual(['context-bootstrap:launch-failed']);
    expect(result.deferred).toBeUndefined();
  });

  it('a late rejection of a deferred bootstrap is not an unhandled rejection', async () => {
    let fail!: (err: Error) => void;
    const running = new Promise<TransportContextBootstrap>((_resolve, reject) => { fail = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await resolveLaunchContextBootstrap('deck_a_brain', () => running);
      expect(result.deferred).toBeDefined();
      fail(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
