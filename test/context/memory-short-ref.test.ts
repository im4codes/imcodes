import { writeFileSync } from 'node:fs';
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
  resolveMemoryShortRefCandidates,
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

  // Golden values: pin the derivation (md5 → base32, first 13 chars) so an
  // accidental change to the algorithm invalidating every issued handle fails
  // here loudly instead of silently.
  it('builds compact deterministic refs from full memory ids', () => {
    expect(makeMemoryShortRef('observation', 'aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('obs:vd34zyurs535g');
    expect(makeMemoryShortRef('projection', '1111111111-2222-3333-4444-555555555555')).toBe('proj:bp27impgwfo27');
  });

  it('derives handles from the whole id, not the leading hex-ish characters', () => {
    // Regression: the previous derivation kept the first 10 hex-looking chars of
    // the id, scavenged from anywhere in the string. Structured ids that share a
    // constant prefix therefore collapsed onto ONE handle (their discriminating
    // sha256 sat past the 10th kept character), and resolution then returned
    // whichever colliding record was newest — i.e. the wrong memory, silently.
    const base = 'md-ingest:personal::::::::local/10cd7355ec31:CLAUDE.md:';
    const first = makeMemoryShortRef('projection', `${base}5f4045310f20b47e48090f0d7bc67020305d68f12ea66e9920a800321f279b42`);
    const second = makeMemoryShortRef('projection', `${base}bff091dac14fa9e1c6405660f45a0db626ccafd19276af083a49439ce4bbd659`);
    expect(first).not.toBe(second);
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

  // A digest collision can no longer be produced through registerMemoryShortRef
  // (that was only reachable because the old derivation collided on a shared id
  // prefix), so seed the persisted cache directly to keep the ambiguity paths
  // covered. They still guard real 65-bit collisions.
  function seedColliding(ref: string, entries: ReadonlyArray<Record<string, unknown>>): void {
    writeFileSync(
      join(tempDir, 'refs.json'),
      JSON.stringify({ schemaVersion: 2, entries: entries.map((entry) => ({ ref, ...entry })) }),
      'utf8',
    );
    reloadMemoryShortRefsForTests();
  }

  it('does not guess when a short ref is ambiguous across namespaces', () => {
    const ref = 'proj:collide000000';
    seedColliding(ref, [
      { kind: 'projection', id: 'bbbbbbbbbb-1111-2222-3333-444444444444', namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-a' } },
      { kind: 'projection', id: 'bbbbbbbbbb-9999-8888-7777-666666666666', namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-b' } },
    ]);

    expect(resolveMemoryShortRef(ref)).toBeUndefined();
    expect(resolveMemoryShortRef(ref, { scope: 'user_private', userId: 'user-1', projectId: 'repo-b' })).toMatchObject({
      id: 'bbbbbbbbbb-9999-8888-7777-666666666666',
    });
  });

  it('does not use singleton fallback when the supplied namespace does not match', () => {
    const ref = registerMemoryShortRef({
      kind: 'projection',
      id: 'dddddddddd-1111-2222-3333-444444444444',
      namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-a' },
    });

    expect(resolveMemoryShortRef(ref, { scope: 'user_private', userId: 'user-1', projectId: 'repo-b' })).toBeUndefined();
    expect(resolveMemoryShortRef(ref)).toMatchObject({
      id: 'dddddddddd-1111-2222-3333-444444444444',
    });
  });

  it('surfaces every record behind a colliding handle so a reader can choose', () => {
    // Refusing outright would throw away information the caller can use, so read
    // paths get all matches; only callers that ACT on the result (see the strict
    // accessor below) refuse.
    const namespace = { scope: 'user_private' as const, userId: 'user-1', projectId: 'repo-1' };
    const ref = 'obs:collide000001';
    seedColliding(ref, [
      { kind: 'observation', id: 'aaaa1111-2222-3333-4444-555555555555', namespace, lastSeenAt: 100 },
      { kind: 'observation', id: 'bbbb9999-8888-7777-6666-666666666666', namespace, lastSeenAt: 200 },
    ]);

    const candidates = resolveMemoryShortRefCandidates(ref, namespace);
    expect(candidates.map((entry) => entry.id).sort()).toEqual([
      'aaaa1111-2222-3333-4444-555555555555',
      'bbbb9999-8888-7777-6666-666666666666',
    ]);
  });

  it('refuses to resolve a same-namespace collision instead of guessing the newest', () => {
    // Two different records deriving one handle used to resolve to whichever was
    // seen last, handing back the wrong memory with no signal. That was tolerable
    // when the derivation collided routinely; with a 65-bit digest a same-
    // namespace collision should never occur, so it is treated as unresolvable
    // (and reported) rather than silently answered with the wrong record.
    const namespace = { scope: 'user_private' as const, userId: 'user-1', projectId: 'repo-1' };
    const ref = 'obs:collide000000';
    seedColliding(ref, [
      { kind: 'observation', id: 'cccccccccc-1111-2222-3333-444444444444', namespace, lastSeenAt: 100 },
      { kind: 'observation', id: 'cccccccccc-9999-8888-7777-666666666666', namespace, lastSeenAt: 200 },
    ]);

    expect(resolveMemoryShortRef(ref, namespace)).toBeUndefined();

    // Still unresolvable after a reload — the collision is a property of the
    // data, not of this process's in-memory state.
    reloadMemoryShortRefsForTests();
    expect(resolveMemoryShortRef(ref, namespace)).toBeUndefined();
  });
});
