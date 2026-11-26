import { describe, expect, it } from 'vitest';
import { buildResolvedAliases } from '../src/util/alias-insert.js';
import { buildAliasMarker, type AliasEntry } from '@shared/alias-types.js';

function alias(name: string, value: string, description?: string): AliasEntry {
  return {
    name,
    value,
    description,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'web',
  };
}

describe('buildResolvedAliases', () => {
  it('resolves a single known marker to its value and leaves text unchanged', () => {
    const list = [alias('deploy', 'ssh root@host && restart')];
    const text = `run ${buildAliasMarker('deploy')} now`;

    const { text: outText, resolvedAliases } = buildResolvedAliases(text, list);

    expect(outText).toBe(text); // text is transported unexpanded
    expect(resolvedAliases).toEqual({ deploy: 'ssh root@host && restart' });
  });

  it('resolves multiple distinct markers', () => {
    const list = [alias('a', 'AAA'), alias('b', 'BBB')];
    const text = `${buildAliasMarker('a')} and ${buildAliasMarker('b')}`;

    const { resolvedAliases } = buildResolvedAliases(text, list);

    expect(resolvedAliases).toEqual({ a: 'AAA', b: 'BBB' });
  });

  it('dedupes repeated markers into a single entry', () => {
    const list = [alias('x', 'XXX')];
    const text = `${buildAliasMarker('x')} ${buildAliasMarker('x')}`;

    const { resolvedAliases } = buildResolvedAliases(text, list);

    expect(resolvedAliases).toEqual({ x: 'XXX' });
    expect(Object.keys(resolvedAliases)).toHaveLength(1);
  });

  it('skips unknown markers (left literal, not in the map)', () => {
    const list = [alias('known', 'KV')];
    const text = `${buildAliasMarker('known')} ${buildAliasMarker('missing')}`;

    const { text: outText, resolvedAliases } = buildResolvedAliases(text, list);

    expect(resolvedAliases).toEqual({ known: 'KV' });
    expect('missing' in resolvedAliases).toBe(false);
    // The unknown marker stays literally present in the transported text.
    expect(outText).toContain(buildAliasMarker('missing'));
  });

  it('resolves CJK alias names', () => {
    const list = [alias('win服务器', '10.0.0.1')];
    const text = `连接 ${buildAliasMarker('win服务器')}`;

    const { resolvedAliases } = buildResolvedAliases(text, list);

    expect(resolvedAliases).toEqual({ 'win服务器': '10.0.0.1' });
  });

  it('ignores structurally invalid markers (spaces, inner parens, empty)', () => {
    const list = [alias('ok', 'V')];
    // `;;(na me)` has a space, `;;(a(b)` has an inner paren, `;;()` is empty —
    // none are valid marker names, so none resolve.
    const text = ';;(na me) ;;(a(b) ;;()';

    const { resolvedAliases } = buildResolvedAliases(text, list);

    expect(resolvedAliases).toEqual({});
  });

  it('returns an empty map and unchanged text when there are no markers', () => {
    const list = [alias('deploy', 'V')];
    const text = 'plain message with no markers';

    const { text: outText, resolvedAliases } = buildResolvedAliases(text, list);

    expect(outText).toBe(text);
    expect(resolvedAliases).toEqual({});
  });

  it('returns an empty map when the alias list is empty', () => {
    const text = `${buildAliasMarker('deploy')}`;

    const { resolvedAliases } = buildResolvedAliases(text, []);

    expect(resolvedAliases).toEqual({});
  });

  it('does not leak values for markers absent from the list', () => {
    const list = [alias('present', 'secret-value')];
    const text = 'no markers referencing present at all';

    const { resolvedAliases } = buildResolvedAliases(text, list);

    // Value must only appear when its marker is actually referenced.
    expect(Object.values(resolvedAliases)).not.toContain('secret-value');
  });
});
