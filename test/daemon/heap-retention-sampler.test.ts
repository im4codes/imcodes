/**
 * 158 (2026-10-08): seven GB in the large-object space, and a diagnostic that could only say "large_object_space". The guard's
 * diagnostic now names the code that allocated the biggest live data -- sizes and code locations, never a value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_HEAP_RETAINED_FRAMES,
  DAEMON_HEAP_RETAINED_MAX_NODES,
  DAEMON_HEAP_RETAINED_TOP_N,
  DAEMON_HEAP_SAMPLER_ENV,
} from '../../shared/daemon-memory-guard.js';
import {
  largestRetainedAllocations,
  relativeCodeLocation,
  startHeapRetentionSampler,
  stopHeapRetentionSampler,
  summarizeSamplingProfile,
} from '../../src/daemon/heap-retention-sampler.js';
import { createMemoryGuard } from '../../src/daemon/memory-guard.js';

type Node = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: Node[] };
const node = (functionName: string, url: string, lineNumber: number, selfSize: number, children: Node[] = []): Node =>
  ({ callFrame: { functionName, url, lineNumber }, selfSize, children });

describe('summarizeSamplingProfile', () => {
  it('lists the heaviest stacks first, innermost frame first, with only sizes and code locations', () => {
    const head = node('(root)', '', -1, 0, [
      node('readStore', 'file:///home/secret-user/.nvm/lib/imcodes/dist/src/daemon/session-identity-local-store.js', 62, 0, [
        node('readFile', 'node:fs/promises', 10, 30_000_000),
      ]),
      node('small', 'file:///home/secret-user/.nvm/lib/imcodes/dist/src/a.js', 1, 1_000),
    ]);
    const report = summarizeSamplingProfile(head);
    expect(report.status).toBe('ok');
    expect(report.totalBytes).toBe(30_001_000);
    expect(report.top[0]).toEqual({
      bytes: 30_000_000,
      frames: ['readFile (node:fs/promises:11)', 'readStore (dist/src/daemon/session-identity-local-store.js:63)'],
    });
    expect(JSON.stringify(report)).not.toContain('secret-user');
  });

  it('is bounded: top N entries, a frame cap, and a node cap on a profile of any size', () => {
    let chain = node('leaf', 'file:///x/src/leaf.js', 0, 5);
    for (let depth = 0; depth < 50; depth += 1) chain = node(`f${depth}`, `file:///x/src/f${depth}.js`, depth, 0, [chain]);
    const wide = Array.from({ length: DAEMON_HEAP_RETAINED_TOP_N * 4 }, (_, index) => node(`w${index}`, 'file:///x/src/w.js', index, 100 + index));
    const report = summarizeSamplingProfile(node('(root)', '', -1, 0, [chain, ...wide]));
    expect(report.top).toHaveLength(DAEMON_HEAP_RETAINED_TOP_N);
    expect(Math.max(...report.top.map((entry) => entry.frames.length))).toBeLessThanOrEqual(DAEMON_HEAP_RETAINED_FRAMES);

    const huge = node('(root)', '', -1, 0, Array.from({ length: DAEMON_HEAP_RETAINED_MAX_NODES + 500 }, (_, index) => node('n', 'file:///x/src/n.js', 0, 1 + (index % 3))));
    const truncated = summarizeSamplingProfile(huge);
    expect(truncated.truncated).toBe(true);
    expect(truncated.top.length).toBeLessThanOrEqual(DAEMON_HEAP_RETAINED_TOP_N);
  });

  it('never reports an absolute path', () => {
    expect(relativeCodeLocation('file:///home/u/proj/node_modules/pkg/dist/index.js')).toBe('node_modules/pkg/dist/index.js');
    expect(relativeCodeLocation('/home/u/elsewhere/tool.js')).toBe('elsewhere/tool.js');
    expect(relativeCodeLocation('')).toBe('(native)');
  });
});

describe('largestRetainedAllocations', () => {
  afterEach(() => stopHeapRetentionSampler());

  it('never throws: a missing sampler or a failing source is reported as unavailable', () => {
    expect(largestRetainedAllocations({ profile: () => undefined })).toMatchObject({ status: 'unavailable', top: [] });
    expect(largestRetainedAllocations({ profile: () => { throw new TypeError('boom'); } })).toMatchObject({ status: 'unavailable', reason: 'TypeError' });
    expect(largestRetainedAllocations()).toMatchObject({ status: 'unavailable' });
  });

  it('can be switched off', () => {
    expect(startHeapRetentionSampler({ [DAEMON_HEAP_SAMPLER_ENV]: '0' })).toBe(false);
    expect(largestRetainedAllocations().status).toBe('unavailable');
  });

  it('names the function that holds live large data (real V8 sampling profiler)', () => {
    expect(startHeapRetentionSampler({})).toBe(true);
    const keep: unknown[][] = [];
    function holdsTheBigArrays(): void {
      for (let index = 0; index < 8; index += 1) keep.push(new Array(1_000_000).fill(index));
    }
    holdsTheBigArrays();
    const report = largestRetainedAllocations();
    expect(report.status).toBe('ok');
    expect(report.top.length).toBeGreaterThan(0);
    const hit = report.top.find((entry) => entry.frames.some((frame) => frame.startsWith('holdsTheBigArrays')));
    expect(hit, JSON.stringify(report.top)).toBeDefined();
    expect(hit!.bytes).toBeGreaterThan(8_000_000);
    expect(keep.length).toBe(8);
  });
});

describe('memory guard diagnostic', () => {
  it('embeds the retained section in the warn diagnostic, and survives a failing reader', async () => {
    const written: Array<Record<string, unknown>> = [];
    const make = (retained: () => unknown) => createMemoryGuard({
      now: () => 1,
      heap: () => ({ usedBytes: 7_000, limitBytes: 10_000 }),
      writeDiagnostic: (data) => { written.push(data); return 'f'; },
      probes: () => ({}),
      retained,
      restart: async () => undefined,
      readRestarts: () => [],
      recordRestart: () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await make(() => ({ status: 'ok', top: [{ bytes: 1, frames: ['f (a.js:1)'] }] })).tick();
    expect(written[0]!['largestRetained']).toEqual({ status: 'ok', top: [{ bytes: 1, frames: ['f (a.js:1)'] }] });
    await make(() => { throw new Error('x'); }).tick();
    expect(written[1]!['largestRetained']).toMatchObject({ status: 'unavailable' });
  });
});
