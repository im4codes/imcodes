import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('daemon lifecycle context-store startup ordering', () => {
  it('starts the context-store worker and waits for readiness before warming memory short refs', () => {
    const source = readFileSync(resolve(repoRoot, 'src/daemon/lifecycle.ts'), 'utf8');
    const startIndex = source.indexOf('getContextStoreClient().start();');
    const readyIndex = source.indexOf('await getContextStoreClient().whenReady();');
    const warmIndex = source.indexOf('loadMemoryShortRefsFromStore();');

    expect(startIndex, 'context-store worker must be started in production startup').toBeGreaterThan(-1);
    expect(readyIndex, 'short-ref warm-load must await worker readiness').toBeGreaterThan(startIndex);
    expect(warmIndex, 'short-ref warm-load must run after the worker is ready').toBeGreaterThan(readyIndex);
    expect(
      source.indexOf('getContextStoreClient().start();', startIndex + 1),
      'startup must not retain a second later worker-start block that lets earlier store reads race it',
    ).toBe(-1);
  });
});
