import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_KINDS,
  computeFingerprint,
  computeMemoryFingerprint,
  fingerprintProjection,
  normalizeContentForFingerprint,
  normalizeSummaryForFingerprint,
} from '../../shared/memory-fingerprint.js';

const fixtureCases = [
  {
    name: 'CJK and emoji summary whitespace',
    kind: 'summary' as const,
    a: '  修复 Docker 缓存 🚀\n下一步：验证。 ',
    b: '修复   Docker 缓存 🚀 下一步：验证。',
  },
  {
    name: 'RTL decision case and whitespace',
    kind: 'decision' as const,
    a: 'قرار:  Use Redis\tfor cache',
    b: 'قرار: use redis for cache',
  },
  {
    name: 'preference strips trusted prefix',
    kind: 'preference' as const,
    a: '@pref: Prefer pnpm for JS projects.',
    b: 'prefer PNPM for JS projects.',
  },
  {
    name: 'skill strips front matter',
    kind: 'skill' as const,
    a: '---\ntitle: Test skill\norigin: user\n---\nUse safe shell quoting.\n',
    b: 'Use safe shell quoting.',
  },
  {
    name: 'note normalizes line endings without lowercasing',
    kind: 'note' as const,
    a: 'Release Note\r\n\r\nKeep Case',
    b: 'Release Note Keep Case',
  },
] as const;

describe('memory fingerprint v1', () => {
  it('defines the canonical closed kind registry', () => {
    expect(FINGERPRINT_KINDS).toEqual(['summary', 'preference', 'skill', 'decision', 'note']);
  });

  it.each(fixtureCases)('matches byte-identical daemon/server fixtures: $name', ({ kind, a, b }) => {
    const daemonFingerprint = computeMemoryFingerprint({ kind, content: a, scopeKey: 'scope/project-a', version: 'v1' });
    const serverFingerprint = computeMemoryFingerprint({ kind, content: b, scopeKey: 'scope/project-a', version: 'v1' });
    expect(daemonFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(serverFingerprint).toBe(daemonFingerprint);
  });

  it('keeps identical normalized content separated by scope key', () => {
    const content = 'Same durable memory.';
    const projectA = computeMemoryFingerprint({ kind: 'summary', content, scopeKey: 'project_shared/github.com/acme/a' });
    const projectB = computeMemoryFingerprint({ kind: 'summary', content, scopeKey: 'project_shared/github.com/acme/b' });
    expect(projectA).not.toBe(projectB);
  });

  it('deduplicates same-scope normalized content while preserving punctuation distinctions', () => {
    const scopeKey = 'personal/github.com/acme/repo';
    const first = computeMemoryFingerprint({ kind: 'summary', content: 'Docker cache fix', scopeKey });
    const same = computeMemoryFingerprint({ kind: 'summary', content: '  DOCKER   cache\nfix  ', scopeKey });
    const punctuationDiffers = computeMemoryFingerprint({ kind: 'summary', content: 'Docker cache fix!', scopeKey });
    expect(same).toBe(first);
    expect(punctuationDiffers).not.toBe(first);
  });

  it('exposes deprecated summary-only helpers without changing legacy behavior', () => {
    expect(normalizeSummaryForFingerprint('  Foo\nBAR  ')).toBe('foo bar');
    expect(fingerprintProjection({ namespaceKey: 'ns', projectionClass: 'recent_summary', summary: '  Foo\nBAR  ' })).toBe('ns\u0000recent_summary\u0000foo bar');
    expect(computeFingerprint('foo bar')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('applies kind-specific normalization rules', () => {
    expect(normalizeContentForFingerprint('skill', '---\na: b\n---\nBody')).toBe('Body');
    expect(normalizeContentForFingerprint('preference', '@pref: Use tabs')).toBe('use tabs');
    expect(normalizeContentForFingerprint('note', 'Mixed Case')).toBe('Mixed Case');
  });
});
