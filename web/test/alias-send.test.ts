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

describe('buildAliasSendExtra — author notes', () => {
  const withNote: AliasEntry = {
    name: 'deploy', value: 'sk-live-1', description: 'prod — read replica only',
    tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const noNote: AliasEntry = { ...withNote, name: 'plain', value: 'v2', description: undefined };

  it('ships the note alongside the value', () => {
    expect(buildAliasSendExtra('use ;;(deploy)', [withNote])).toEqual({
      resolvedAliases: { deploy: 'sk-live-1' },
      resolvedAliasNotes: { deploy: 'prod — read replica only' },
    });
  });

  it('omits the notes field entirely when nothing has a note', () => {
    // Keeps note-free sends byte-identical, so an older daemon sees no new field.
    expect(buildAliasSendExtra('use ;;(plain)', [noNote])).toEqual({ resolvedAliases: { plain: 'v2' } });
  });

  it('keeps resolvedAliases a flat name→string map for older daemons', () => {
    // An old daemon calls nfc() on each entry; an object there throws
    // TypeError and the send never reaches the agent.
    const extra = buildAliasSendExtra('use ;;(deploy)', [withNote]);
    for (const v of Object.values(extra.resolvedAliases!)) expect(typeof v).toBe('string');
  });

  it('includes only the notes of aliases the body actually references', () => {
    const extra = buildAliasSendExtra('use ;;(plain)', [withNote, noNote]);
    expect(extra.resolvedAliasNotes).toBeUndefined();
    expect(extra.resolvedAliases).toEqual({ plain: 'v2' });
  });

  it('drops a whitespace-only note instead of shipping an empty one', () => {
    const blank: AliasEntry = { ...withNote, description: '   ' };
    expect(buildAliasSendExtra('use ;;(deploy)', [blank]).resolvedAliasNotes).toBeUndefined();
  });
});
