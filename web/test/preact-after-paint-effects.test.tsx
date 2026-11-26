/**
 * @vitest-environment jsdom
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { Component, options, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const require = createRequire(import.meta.url);

class EffectErrorBoundary extends Component<
  { onError: (error: unknown) => void; children: preact.ComponentChildren },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return <div data-testid="fallback">recovered</div>;
    }
    return this.props.children;
  }
}

describe('preact/hooks afterPaintEffects O(N) drain and dedup', () => {
  const originalRaf = options.requestAnimationFrame;
  const containers: HTMLElement[] = [];

  function makeContainer(): HTMLElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    containers.push(el);
    return el;
  }

  afterEach(() => {
    options.requestAnimationFrame = originalRaf;
    while (containers.length > 0) {
      const el = containers.pop()!;
      render(null, el);
      el.remove();
    }
  });

  it('drains 50,000 distinct component effects in O(N) time without shift() quadratic hang', () => {
    const queuedCallbacks: Array<() => void> = [];
    options.requestAnimationFrame = (cb) => {
      queuedCallbacks.push(cb);
    };

    const COUNT = 50_000;
    let ranCount = 0;

    function Leaf({ index }: { index: number }) {
      useEffect(() => {
        if (index >= 0) ranCount += 1;
      }, [index]);
      return null;
    }

    function Batch() {
      const items = [];
      for (let i = 0; i < COUNT; i += 1) {
        items.push(<Leaf key={i} index={i} />);
      }
      return <div>{items}</div>;
    }

    const container = makeContainer();
    render(<Batch />, container);

    // afterPaint only schedules once for the whole batch
    expect(queuedCallbacks).toHaveLength(1);
    expect(ranCount).toBe(0);

    const start = performance.now();
    queuedCallbacks.shift()!();
    const elapsedMs = performance.now() - start;

    expect(ranCount).toBe(COUNT);
    expect(elapsedMs).toBeLessThan(1_000);
  }, 15_000);

  it('deduplicates repeated re-renders of the same component while paint is deferred and resets the dedup flag after flush', () => {
    const queuedCallbacks: Array<() => void> = [];
    options.requestAnimationFrame = (cb) => {
      queuedCallbacks.push(cb);
    };

    const observed: number[] = [];

    function Repeated({ step }: { step: number }) {
      useEffect(() => {
        observed.push(step);
      });
      return <span>{step}</span>;
    }

    const container = makeContainer();
    const RENDERS = 60_000;
    const renderStart = performance.now();
    for (let i = 0; i < RENDERS; i += 1) {
      render(<Repeated step={i} />, container);
    }
    const renderElapsedMs = performance.now() - renderStart;

    // Repeated component renders before flush only schedule one rAF callback
    // because component.__hooks.__q deduplicates afterPaintEffects pushes.
    expect(queuedCallbacks).toHaveLength(1);

    const flushStart = performance.now();
    while (queuedCallbacks.length > 0) {
      queuedCallbacks.shift()!();
    }
    const flushElapsedMs = performance.now() - flushStart;

    expect(observed.at(-1)).toBe(RENDERS - 1);
    expect(renderElapsedMs + flushElapsedMs).toBeLessThan(2_000);

    // Dedup flag must be cleared so subsequent renders enqueue normally
    render(<Repeated step={RENDERS} />, container);
    expect(queuedCallbacks).toHaveLength(1);
    queuedCallbacks.shift()!();
    expect(observed.at(-1)).toBe(RENDERS);
  }, 15_000);

  it('supports re-entrant setState inside useEffect without dropping the follow-up effect', () => {
    const queuedCallbacks: Array<() => void> = [];
    options.requestAnimationFrame = (cb) => {
      queuedCallbacks.push(cb);
    };

    const transitions: string[] = [];
    const cleanups: string[] = [];

    function Reentrant() {
      const [stage, setStage] = useState(0);
      useEffect(() => {
        transitions.push(`effect:${stage}`);
        if (stage === 0) {
          setStage(1);
        }
        return () => {
          cleanups.push(`cleanup:${stage}`);
        };
      }, [stage]);
      return <span>{stage}</span>;
    }

    const container = makeContainer();
    render(<Reentrant />, container);
    expect(queuedCallbacks).toHaveLength(1);

    // Preact schedules re-renders asynchronously; draining queued callbacks + microtasks completes stage 0 -> 1.
    return new Promise<void>((resolve) => {
      queuedCallbacks.shift()!();
      setTimeout(() => {
        while (queuedCallbacks.length > 0) {
          queuedCallbacks.shift()!();
        }
        expect(transitions).toEqual(['effect:0', 'effect:1']);
        expect(cleanups).toEqual(['cleanup:0']);
        resolve();
      }, 25);
    });
  });

  it('isolates an effect exception via error boundary, cleans up pendingEffects/dedup flag, and still drains sibling effects', () => {
    const queuedCallbacks: Array<() => void> = [];
    options.requestAnimationFrame = (cb) => {
      queuedCallbacks.push(cb);
    };

    const boundaryErrors: unknown[] = [];
    const siblingRuns: number[] = [];

    function Throwing({ fail }: { fail: boolean }) {
      useEffect(() => {
        if (fail) {
          throw new Error('boom-in-effect');
        }
      }, [fail]);
      return <div>{fail ? 'fail' : 'ok'}</div>;
    }

    function Healthy({ seq }: { seq: number }) {
      useEffect(() => {
        siblingRuns.push(seq);
      }, [seq]);
      return <div>healthy-{seq}</div>;
    }

    const container = makeContainer();
    render(
      <div>
        <EffectErrorBoundary onError={(err) => boundaryErrors.push(err)}>
          <Throwing fail={true} />
        </EffectErrorBoundary>
        <Healthy seq={1} />
      </div>,
      container,
    );

    expect(queuedCallbacks).toHaveLength(1);
    while (queuedCallbacks.length > 0) {
      queuedCallbacks.shift()!();
    }

    expect(boundaryErrors).toHaveLength(1);
    expect((boundaryErrors[0] as Error).message).toBe('boom-in-effect');
    expect(siblingRuns).toEqual([1]);

    // Subsequent updates still drain properly
    render(
      <div>
        <EffectErrorBoundary onError={(err) => boundaryErrors.push(err)}>
          <Throwing fail={false} />
        </EffectErrorBoundary>
        <Healthy seq={2} />
      </div>,
      container,
    );
    while (queuedCallbacks.length > 0) {
      queuedCallbacks.shift()!();
    }
    expect(siblingRuns).toEqual([1, 2]);
  });

  it('re-schedules through a newly installed options.requestAnimationFrame even when a component is already queued', () => {
    const firstQueue: Array<() => void> = [];
    const secondQueue: Array<() => void> = [];
    const ran: number[] = [];

    function Counter({ n }: { n: number }) {
      useEffect(() => {
        ran.push(n);
      }, [n]);
      return <span>{n}</span>;
    }

    const container = makeContainer();
    options.requestAnimationFrame = (cb) => {
      firstQueue.push(cb);
    };
    render(<Counter n={1} />, container);
    expect(firstQueue).toHaveLength(1);

    // Swap options.requestAnimationFrame before firstQueue flushes (just as preact/test-utils act() does)
    options.requestAnimationFrame = (cb) => {
      secondQueue.push(cb);
    };
    render(<Counter n={2} />, container);
    expect(secondQueue).toHaveLength(1);

    secondQueue.shift()!();
    expect(ran.at(-1)).toBe(2);
    // Draining the earlier frame callback is a clean no-op
    firstQueue.shift()!();
    expect(ran.at(-1)).toBe(2);
  });

  it('ships O(N) drain and dedup in all preact/hooks package entry builds (CJS/ESM/module/UMD)', () => {
    const cjsHooks = require('preact/hooks') as typeof import('preact/hooks');
    expect(typeof cjsHooks.useEffect).toBe('function');

    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { dirname, resolve } = require('node:path') as typeof import('node:path');
    const hooksDir = resolve(dirname(require.resolve('preact/package.json')), 'hooks');

    for (const rel of [
      'src/index.js',
      'dist/hooks.js',
      'dist/hooks.mjs',
      'dist/hooks.module.js',
      'dist/hooks.umd.js',
    ]) {
      const content = readFileSync(resolve(hooksDir, rel), 'utf8');
      expect(content, `${rel} should not use afterPaintEffects.shift()`).not.toMatch(/\.shift\(\)/);
      expect(
        content,
        `${rel} should carry dedup guard`,
      ).toMatch(rel === 'src/index.js' ? /_queuedAfterPaint/ : /__q/);
    }
  });
});
