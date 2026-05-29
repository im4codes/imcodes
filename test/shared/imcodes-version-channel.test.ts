import { describe, expect, it } from 'vitest';
import { asReleaseChannel, getReleaseChannel } from '../../shared/imcodes-version.js';

describe('getReleaseChannel', () => {
  it('treats a clean MAJOR.MINOR.PATCH as the stable (latest) channel', () => {
    expect(getReleaseChannel('2026.5.2059')).toBe('latest');
    expect(getReleaseChannel('1.0.0')).toBe('latest');
    expect(getReleaseChannel('  2026.5.2059  ')).toBe('latest');
  });

  it('treats any prerelease build as the dev channel', () => {
    expect(getReleaseChannel('2026.5.2059-dev.2036')).toBe('dev');
    expect(getReleaseChannel('2026.5.2059-dev')).toBe('dev');
    expect(getReleaseChannel('1.2.3-rc.1')).toBe('dev');
  });

  it('falls back to latest for unparseable input', () => {
    expect(getReleaseChannel('not-a-version')).toBe('latest');
    expect(getReleaseChannel('')).toBe('latest');
  });
});

describe('asReleaseChannel', () => {
  it('accepts the two valid dist-tags', () => {
    expect(asReleaseChannel('latest')).toBe('latest');
    expect(asReleaseChannel('dev')).toBe('dev');
  });

  it('rejects anything else', () => {
    expect(asReleaseChannel('stable')).toBeNull();
    expect(asReleaseChannel('LATEST')).toBeNull(); // caller lowercases before passing
    expect(asReleaseChannel('')).toBeNull();
  });
});
