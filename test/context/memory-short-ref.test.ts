import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeMemoryShortRef,
  registerMemoryShortRef,
  reloadMemoryShortRefsForTests,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
} from '../../src/context/memory-short-ref.js';

describe('memory short refs', () => {
  let tempDir: string;
  let priorPath: string | undefined;

  beforeEach(async () => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    tempDir = await mkdtemp(join(tmpdir(), 'imc-memory-short-ref-'));
    process.env.IMCODES_MEMORY_SHORT_REF_PATH = join(tempDir, 'refs.json');
    resetMemoryShortRefsForTests();
  });

  afterEach(async () => {
    resetMemoryShortRefsForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds compact deterministic refs from full memory ids', () => {
    expect(makeMemoryShortRef('observation', 'aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('obs:aaaaaaaaaa');
    expect(makeMemoryShortRef('projection', '1111111111-2222-3333-4444-555555555555')).toBe('proj:1111111111');
  });

  it('survives daemon restart by reloading the local short-ref cache', () => {
    const namespace = { scope: 'user_private' as const, userId: 'user-1', projectId: 'repo-1' };
    const ref = registerMemoryShortRef({
      kind: 'observation',
      id: 'aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      namespace,
      lastSeenAt: 100,
    });

    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({
      kind: 'observation',
      id: 'aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    reloadMemoryShortRefsForTests();

    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({
      kind: 'observation',
      id: 'aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
  });

  it('does not guess when a short ref is ambiguous across namespaces', () => {
    const ref = registerMemoryShortRef({
      kind: 'projection',
      id: 'bbbbbbbbbb-1111-2222-3333-444444444444',
      namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-a' },
    });
    registerMemoryShortRef({
      kind: 'projection',
      id: 'bbbbbbbbbb-9999-8888-7777-666666666666',
      namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-b' },
    });

    expect(resolveMemoryShortRef(ref)).toBeUndefined();
    expect(resolveMemoryShortRef(ref, { scope: 'user_private', userId: 'user-1', projectId: 'repo-b' })).toMatchObject({
      id: 'bbbbbbbbbb-9999-8888-7777-666666666666',
    });
  });

  it('resolves same-namespace short-ref conflicts to the newest seen entry', () => {
    const namespace = { scope: 'user_private' as const, userId: 'user-1', projectId: 'repo-1' };
    const ref = registerMemoryShortRef({
      kind: 'observation',
      id: 'cccccccccc-1111-2222-3333-444444444444',
      namespace,
      lastSeenAt: 100,
    });
    registerMemoryShortRef({
      kind: 'observation',
      id: 'cccccccccc-9999-8888-7777-666666666666',
      namespace,
      lastSeenAt: 200,
    });

    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({
      id: 'cccccccccc-9999-8888-7777-666666666666',
    });

    reloadMemoryShortRefsForTests();

    expect(resolveMemoryShortRef(ref, namespace)).toMatchObject({
      id: 'cccccccccc-9999-8888-7777-666666666666',
    });
  });
});
