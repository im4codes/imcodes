import { describe, expect, it } from 'vitest';
import {
  compareImcodesVersions,
  isImcodesVersionOutdated,
  isLocalDevImcodesVersion,
  parseImcodesVersion,
} from '../../shared/imcodes-version.js';

describe('imcodes version helpers', () => {
  it('parses stable and dev versions', () => {
    expect(parseImcodesVersion('2026.4.905')).toEqual({
      major: 2026,
      minor: 4,
      patch: 905,
      prerelease: [],
    });
    expect(parseImcodesVersion('2026.4.905-dev.877')).toEqual({
      major: 2026,
      minor: 4,
      patch: 905,
      prerelease: ['dev', '877'],
    });
  });

  it('orders prerelease and stable versions correctly', () => {
    expect(compareImcodesVersions('2026.4.905-dev.877', '2026.4.905')).toBe(-1);
    expect(compareImcodesVersions('2026.4.905', '2026.4.905-dev.877')).toBe(1);
    expect(compareImcodesVersions('2026.4.905-dev.877', '2026.4.905-dev.878')).toBe(-1);
    expect(compareImcodesVersions('2026.4.906-dev.1', '2026.4.905-dev.877')).toBe(1);
    expect(compareImcodesVersions('2026.4.905-dev.877', '2026.4.905-dev.877')).toBe(0);
  });

  it('marks only 0.x.x builds as local dev builds', () => {
    expect(isLocalDevImcodesVersion('0.1.2')).toBe(true);
    expect(isLocalDevImcodesVersion('2026.4.905-dev.877')).toBe(false);
  });
});

describe('isImcodesVersionOutdated', () => {
  it('flags only a strictly older parseable version', () => {
    expect(isImcodesVersionOutdated('2026.8.3400-dev.3800', '2026.8.3447-dev.3884')).toBe(true);
    expect(isImcodesVersionOutdated('2026.8.3447-dev.3884', '2026.8.3447-dev.3884')).toBe(false);
    expect(isImcodesVersionOutdated('2026.8.3500', '2026.8.3447-dev.3884')).toBe(false);
  });

  it('never invents an upgrade from missing or unparseable input', () => {
    expect(isImcodesVersionOutdated(null, '2026.8.3447-dev.3884')).toBe(false);
    expect(isImcodesVersionOutdated(undefined, '2026.8.3447-dev.3884')).toBe(false);
    expect(isImcodesVersionOutdated('2026.8.3400-dev.3800', undefined)).toBe(false);
    expect(isImcodesVersionOutdated('not a version', '2026.8.3447-dev.3884')).toBe(false);
    expect(isImcodesVersionOutdated('2026.8.3400-dev.3800', 'nightly')).toBe(false);
  });
});
