import { describe, it, expect } from 'vitest';

/**
 * Tests for the normalizeForEcho function used in useTimeline for echo deduplication.
 *
 * The function is defined inside useTimeline.ts but not exported, so we
 * re-implement it here (keeping it in sync with the source) and test the
 * logic directly. This also serves as documentation of the exact contract.
 *
 * Source: web/src/hooks/useTimeline.ts — normalizeForEcho()
 * Strips prompt prefixes (❯ > λ › $ % #), collapses whitespace, trims.
 */

function normalizeForEcho(text: string): string {
  return text
    .trim()
    .replace(/^[❯>λ›$%#]\s*/, '')
    .replace(/\s+/g, ' ');
}

describe('normalizeForEcho — prompt prefix stripping', () => {
  it('strips ❯ prefix', () => {
    expect(normalizeForEcho('❯ hello world')).toBe('hello world');
    expect(normalizeForEcho('❯hello')).toBe('hello');
  });

  it('strips > prefix', () => {
    expect(normalizeForEcho('> some command')).toBe('some command');
    expect(normalizeForEcho('>command')).toBe('command');
  });

  it('strips λ prefix', () => {
    expect(normalizeForEcho('λ do something')).toBe('do something');
    expect(normalizeForEcho('λdo something')).toBe('do something');
  });

  it('strips › prefix', () => {
    expect(normalizeForEcho('› run tests')).toBe('run tests');
    expect(normalizeForEcho('›run tests')).toBe('run tests');
  });

  it('strips $ prefix', () => {
    expect(normalizeForEcho('$ npm install')).toBe('npm install');
    expect(normalizeForEcho('$npm install')).toBe('npm install');
  });

  it('strips % prefix', () => {
    expect(normalizeForEcho('% git status')).toBe('git status');
  });

  it('strips # prefix', () => {
    expect(normalizeForEcho('# comment')).toBe('comment');
  });

  it('strips only the first prompt character', () => {
    // Only the leading prefix char is stripped, not subsequent ones
    expect(normalizeForEcho('> > nested')).toBe('> nested');
    expect(normalizeForEcho('❯ ❯ double')).toBe('❯ double');
  });
});

describe('normalizeForEcho — whitespace collapsing', () => {
  it('collapses internal whitespace to single space', () => {
    expect(normalizeForEcho('hello   world')).toBe('hello world');
    expect(normalizeForEcho('foo\t\tbar')).toBe('foo bar');
    expect(normalizeForEcho('a  b  c')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeForEcho('  hello  ')).toBe('hello');
    expect(normalizeForEcho('\t hello \t')).toBe('hello');
  });

  it('collapses newlines to spaces', () => {
    expect(normalizeForEcho('line one\nline two')).toBe('line one line two');
    expect(normalizeForEcho('a\n\nb')).toBe('a b');
  });

  it('handles mixed whitespace types', () => {
    expect(normalizeForEcho('  \t multiple \n whitespace  ')).toBe('multiple whitespace');
  });
});

describe('normalizeForEcho — combined behavior', () => {
  it('strips prefix and collapses whitespace together', () => {
    // trim: '❯   hello   world' → prefix strip (❯ + spaces): 'hello   world' → collapse: 'hello world'
    expect(normalizeForEcho('❯   hello   world  ')).toBe('hello world');
  });

  it('returns empty string for prompt-only input', () => {
    expect(normalizeForEcho('❯')).toBe('');
    expect(normalizeForEcho('> ')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeForEcho('   ')).toBe('');
    expect(normalizeForEcho('')).toBe('');
  });

  it('does not strip non-prefix characters', () => {
    expect(normalizeForEcho('hello world')).toBe('hello world');
    expect(normalizeForEcho('no prefix here')).toBe('no prefix here');
  });

  it('echo dedup: same message with and without prompt prefix produces equal normalized form', () => {
    const userInput = '❯ implement the login feature';
    const echoText = 'implement the login feature';
    expect(normalizeForEcho(userInput)).toBe(normalizeForEcho(echoText));
  });

  it('echo dedup: same message with extra whitespace produces equal normalized form', () => {
    const userInput = '>  fix   the bug  ';
    const echoText = 'fix the bug';
    expect(normalizeForEcho(userInput)).toBe(normalizeForEcho(echoText));
  });

  it('echo dedup: different messages do NOT produce equal normalized form', () => {
    const msg1 = '❯ add logging';
    const msg2 = '❯ remove logging';
    expect(normalizeForEcho(msg1)).not.toBe(normalizeForEcho(msg2));
  });
});
