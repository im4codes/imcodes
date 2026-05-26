import { describe, expect, it } from 'vitest';
import { USER_SESSION_TEXT_MAX_CHARS, clampUserSessionText } from '../../shared/user-session-text-caps.js';

describe('clampUserSessionText', () => {
  it('returns undefined for null / undefined / non-string input', () => {
    expect(clampUserSessionText(null)).toBeUndefined();
    expect(clampUserSessionText(undefined)).toBeUndefined();
    expect(clampUserSessionText((42 as unknown) as string)).toBeUndefined();
  });

  it('returns undefined for empty / whitespace-only input', () => {
    expect(clampUserSessionText('')).toBeUndefined();
    expect(clampUserSessionText('   ')).toBeUndefined();
    expect(clampUserSessionText('\n\t\r')).toBeUndefined();
  });

  it('trims surrounding whitespace from short input', () => {
    expect(clampUserSessionText('  hello  ')).toBe('hello');
  });

  it('returns the input verbatim when at or below the cap', () => {
    const atCap = 'x'.repeat(USER_SESSION_TEXT_MAX_CHARS);
    expect(clampUserSessionText(atCap)).toBe(atCap);
    expect(clampUserSessionText('short text')).toBe('short text');
  });

  it('truncates text longer than the cap to exactly the cap', () => {
    const overCap = 'a'.repeat(USER_SESSION_TEXT_MAX_CHARS + 100);
    const result = clampUserSessionText(overCap);
    expect(result).toHaveLength(USER_SESSION_TEXT_MAX_CHARS);
    expect(result).toBe('a'.repeat(USER_SESSION_TEXT_MAX_CHARS));
  });

  it('caps after trim, not before — leading whitespace does not consume budget', () => {
    const padded = '   ' + 'b'.repeat(USER_SESSION_TEXT_MAX_CHARS + 50) + '   ';
    const result = clampUserSessionText(padded);
    expect(result).toHaveLength(USER_SESSION_TEXT_MAX_CHARS);
    expect(result).toBe('b'.repeat(USER_SESSION_TEXT_MAX_CHARS));
  });

  it('exposes the cap as a constant so daemon/server/web all agree', () => {
    expect(USER_SESSION_TEXT_MAX_CHARS).toBe(300);
  });
});
