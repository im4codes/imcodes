import { describe, expect, it } from 'vitest';
import { buildAliasSendExtra } from '../src/util/alias-send.js';
import { buildAliasMarker, type AliasEntry } from '@shared/alias-types.js';

function alias(name: string, value: string): AliasEntry {
  return { name, value, tags: [], createdAt: '', updatedAt: '', source: 'web' };
}

describe('buildAliasSendExtra', () => {
  it('returns { resolvedAliases } for a body that references a known marker', () => {
    const list = [alias('deploy', 'ssh root@host && restart')];
    const extra = buildAliasSendExtra(`run ${buildAliasMarker('deploy')} now`, list);
    expect(extra).toEqual({ resolvedAliases: { deploy: 'ssh root@host && restart' } });
  });

  it('returns an empty object (spread-safe) when the body has no markers', () => {
    const list = [alias('deploy', 'V')];
    const extra = buildAliasSendExtra('plain message', list);
    expect(extra).toEqual({});
    expect('resolvedAliases' in extra).toBe(false);
    // Spreading an empty result must not add any key to a send extra.
    expect({ ...extra }).toEqual({});
  });

  it('omits resolvedAliases for an unknown marker (no value leak)', () => {
    const list = [alias('known', 'secret')];
    const extra = buildAliasSendExtra(`x ${buildAliasMarker('missing')} y`, list);
    expect(extra).toEqual({});
    expect(Object.values(extra)).not.toContain('secret');
  });

  it('resolves only markers present in the caller list; text is never expanded here', () => {
    const list = [alias('a', 'AAA')];
    const body = `${buildAliasMarker('a')} ${buildAliasMarker('b')}`;
    const extra = buildAliasSendExtra(body, list);
    expect(extra).toEqual({ resolvedAliases: { a: 'AAA' } });
  });
});
