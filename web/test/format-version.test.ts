import { describe, it, expect } from 'vitest';
import { formatDaemonVersionShort } from '../src/util/format-version.js';

describe('formatDaemonVersionShort', () => {
  it('strips the trailing .NNN counter after a -dev tag', () => {
    // Phone-width screens drop the trailing dev counter; the tooltip /
    // settings panel still surfaces the full version for support.
    expect(formatDaemonVersionShort('2026.4.1949-dev.1928')).toBe('2026.4.1949-dev');
  });

  it('strips the trailing counter for other pre-release tags too', () => {
    expect(formatDaemonVersionShort('2026.4.1949-rc.3')).toBe('2026.4.1949-rc');
    expect(formatDaemonVersionShort('2026.4.1949-beta.42')).toBe('2026.4.1949-beta');
    expect(formatDaemonVersionShort('2026.4.1949-alpha.1')).toBe('2026.4.1949-alpha');
  });

  it('returns stable versions unchanged', () => {
    // No pre-release tag → already short, no truncation applies.
    expect(formatDaemonVersionShort('2026.4.1873')).toBe('2026.4.1873');
    expect(formatDaemonVersionShort('1.2.3')).toBe('1.2.3');
  });

  it('preserves a tag without a trailing counter', () => {
    // Already as short as the formatter can make it.
    expect(formatDaemonVersionShort('2026.4.1949-dev')).toBe('2026.4.1949-dev');
  });

  it('returns empty string for null / undefined / empty input', () => {
    expect(formatDaemonVersionShort(null)).toBe('');
    expect(formatDaemonVersionShort(undefined)).toBe('');
    expect(formatDaemonVersionShort('')).toBe('');
  });

  it('does not strip numeric pre-release identifiers (semver-style)', () => {
    // semver allows numeric pre-release segments like '1.0.0-1.2'. The
    // truncation rule is anchored to a *letter* prefix to avoid eating
    // those — we only collapse human-named tags like dev / rc / beta.
    expect(formatDaemonVersionShort('1.0.0-1.2')).toBe('1.0.0-1.2');
  });
});
