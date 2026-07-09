import { describe, it, expect } from 'vitest';
import {
  ALIAS_NAME_MAX,
  ALIAS_VALUE_MAX,
  ALIAS_REASONS,
  buildAliasMarker,
  buildAliasLegendLine,
  normalizeAliasValueForStorage,
  parseAliasMarkers,
  validateAliasDescription,
  validateAliasName,
  validateAliasValue,
} from '../../shared/alias-types.js';

const NUL = String.fromCharCode(0);
const ZWSP = String.fromCharCode(0x200b);

describe('alias name validation', () => {
  it('accepts CJK and the allowlist chars', () => {
    expect(validateAliasName('win服务器')).toBeNull();
    expect(validateAliasName('deploy-prod.v2_x')).toBeNull();
  });

  it('rejects whitespace, delimiter and URL-dangerous chars', () => {
    for (const bad of ['', 'a b', 'a:b', 'a/b', 'a%b', 'a#b', 'a;b', 'a(b', 'a)b']) {
      expect(validateAliasName(bad)).toBe(ALIAS_REASONS.INVALID_NAME);
    }
  });

  it('rejects zero-width and control characters', () => {
    expect(validateAliasName(`pr${ZWSP}od`)).toBe(ALIAS_REASONS.INVALID_NAME);
    expect(validateAliasName(`a${String.fromCharCode(1)}b`)).toBe(ALIAS_REASONS.INVALID_NAME);
  });

  it('enforces the code-point length cap', () => {
    expect(validateAliasName('a'.repeat(ALIAS_NAME_MAX))).toBeNull();
    expect(validateAliasName('a'.repeat(ALIAS_NAME_MAX + 1))).toBe(ALIAS_REASONS.INVALID_NAME);
  });
});

describe('alias value validation', () => {
  it('accepts spaces and newlines (user exact text)', () => {
    expect(validateAliasValue('ssh root@xxx -p2222')).toBeNull();
    expect(validateAliasValue('line1\nline2')).toBeNull();
  });

  it('rejects empty, NUL and oversize', () => {
    expect(validateAliasValue('')).toBe(ALIAS_REASONS.VALUE_INVALID);
    expect(validateAliasValue(`a${NUL}b`)).toBe(ALIAS_REASONS.VALUE_INVALID);
    expect(validateAliasValue('x'.repeat(ALIAS_VALUE_MAX))).toBeNull();
    expect(validateAliasValue('x'.repeat(ALIAS_VALUE_MAX + 1))).toBe(ALIAS_REASONS.VALUE_INVALID);
  });

  it('normalizes CRLF/CR to LF for storage', () => {
    expect(normalizeAliasValueForStorage('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('alias description validation', () => {
  it('is optional and length-bounded', () => {
    expect(validateAliasDescription(undefined)).toBeNull();
    expect(validateAliasDescription('x'.repeat(200))).toBeNull();
    expect(validateAliasDescription('x'.repeat(201))).toBe(ALIAS_REASONS.DESCRIPTION_INVALID);
  });
});

describe('marker parsing', () => {
  it('extracts valid names in first-occurrence order, deduped', () => {
    expect(parseAliasMarkers('go ;;(b) then ;;(a) then ;;(b)')).toEqual(['b', 'a']);
  });

  it('resolves a CJK marker', () => {
    expect(parseAliasMarkers('login ;;(win服务器)')).toEqual(['win服务器']);
  });

  it('leaves invalid markers literal (returns no names)', () => {
    for (const bad of [';;()', 'x ;;(has space) y', 'x ;;(a:b) y', ';;(unclosed', ';;(na(me)']) {
      expect(parseAliasMarkers(bad)).toEqual([]);
    }
  });
});

describe('marker + legend builders', () => {
  it('builds a marker', () => {
    expect(buildAliasMarker('x')).toBe(';;(x)');
  });
  it('single-lines the legend value', () => {
    expect(buildAliasLegendLine('x', 'a\nb\tc')).toBe(';;(x): a b c');
  });
});
