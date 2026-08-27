import { describe, expect, it } from 'vitest';
import {
  isAcceptableCallerSuppliedId,
  mintSupervisionId,
} from '../../src/daemon/supervision-id-minter.js';
import { parseSupervisionCanonicalId } from '../../shared/supervision-durable-identity.js';

const SUFFIX = '01JABCDEF0123456789';

describe('daemon-minted canonical ids', () => {
  it('mints typed prefix + semantic key + daemon suffix', () => {
    const minted = mintSupervisionId(
      { kind: 'task', semanticKey: 'macos-remote-desktop-full-build-graph' },
      { uniqueSuffix: () => SUFFIX },
    );
    expect(minted).toEqual({
      ok: true, semanticKey: 'macos-remote-desktop-full-build-graph',
      id: `tsk_macos-remote-desktop-full-build-graph_${SUFFIX}`,
    });
    expect(parseSupervisionCanonicalId((minted as { id: string }).id)).toMatchObject({
      kind: 'task', semanticKey: 'macos-remote-desktop-full-build-graph', uniqueSuffix: SUFFIX,
    });
  });

  it('encodes a daemon-counted audit round', () => {
    const minted = mintSupervisionId(
      { kind: 'auditAttempt', semanticKey: 'media-binder-rebind', round: 2 },
      { uniqueSuffix: () => SUFFIX },
    );
    expect((minted as { id: string }).id).toBe(`aud_media-binder-rebind_r2_${SUFFIX}`);
    expect(parseSupervisionCanonicalId((minted as { id: string }).id)?.round).toBe('r2');
  });

  it('rejects non-kebab, reserved, over/under-length keys', () => {
    for (const key of ['Not Kebab', 'trailing-', '-leading', 'double--dash', 'ab', 'test', 'tmp',
      'x'.repeat(65), '', 'UPPER', 'snake_case']) {
      expect(mintSupervisionId({ kind: 'task', semanticKey: key }, { uniqueSuffix: () => SUFFIX }), key)
        .toEqual({ ok: false, reason: 'invalid_semantic_key' });
    }
  });

  it('rejects a model-supplied round that is not a daemon-countable integer', () => {
    for (const round of [0, -1, 1.5, 1000, Number.NaN]) {
      expect(mintSupervisionId({ kind: 'auditAttempt', semanticKey: 'slice-a', round }, { uniqueSuffix: () => SUFFIX }), String(round))
        .toEqual({ ok: false, reason: 'invalid_round' });
    }
  });

  it('is unique across calls with the same semantic key', () => {
    let n = 0;
    const ids = [1, 2, 3].map(() => mintSupervisionId(
      { kind: 'task', semanticKey: 'same-objective' }, { uniqueSuffix: () => `01JAAAAAAAAAAAAAA${n += 1}` },
    ));
    const set = new Set(ids.map((r) => (r as { id: string }).id));
    expect(set.size).toBe(3);
  });

  it('retries past a collision instead of returning a duplicate', () => {
    let call = 0;
    const minted = mintSupervisionId(
      { kind: 'task', semanticKey: 'collide-once' },
      { uniqueSuffix: () => `01JSUFFIXAAAAAAA${call += 1}`, exists: (id) => id.endsWith('1') },
    );
    expect((minted as { id: string }).id).toContain('2');
  });

  it('gives up rather than looping forever when everything collides', () => {
    expect(mintSupervisionId(
      { kind: 'task', semanticKey: 'always-collides' },
      { uniqueSuffix: () => SUFFIX, exists: () => true },
    )).toEqual({ ok: false, reason: 'collision' });
  });
});

describe('caller-supplied id guard', () => {
  const known = `tsk_known-slice_${SUFFIX}`;
  const exists = (id: string) => id === known;

  it('accepts a previously minted id (idempotent replay)', () => {
    expect(isAcceptableCallerSuppliedId({ id: known, kind: 'task', exists })).toBe(true);
  });

  it('REFUSES a well-formed but unknown id (impersonation)', () => {
    expect(isAcceptableCallerSuppliedId({
      id: `tsk_someone-elses-slice_${SUFFIX}`, kind: 'task', exists,
    })).toBe(false);
  });

  it('refuses a wrong-kind prefix and malformed ids', () => {
    expect(isAcceptableCallerSuppliedId({ id: known, kind: 'assignment', exists })).toBe(false);
    for (const id of ['', 'tsk_', 'nope', 'supervision_task_' + SUFFIX, 'tsk_UPPER_' + SUFFIX]) {
      expect(isAcceptableCallerSuppliedId({ id, kind: 'task', exists }), id).toBe(false);
    }
  });
});
