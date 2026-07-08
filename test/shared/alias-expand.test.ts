import { describe, it, expect } from 'vitest';
import { SESSION_AGENT_TYPES } from '../../shared/agent-types.js';
import {
  aliasExpansionModeFor,
  everyAgentTypeClassified,
  expandForAgent,
  sanitizeResolvedAliasValue,
} from '../../shared/alias-expand.js';
import { ALIAS_LEGEND_DIRECTIVE, ALIAS_REASONS, ALIAS_VALUE_MAX } from '../../shared/alias-types.js';

const ESC = '\x1b';
const NUL = '\x00';

describe('aliasExpansionModeFor', () => {
  it('classifies every current SessionAgentType (no silent default)', () => {
    expect(everyAgentTypeClassified()).toBe(true);
    for (const t of SESSION_AGENT_TYPES) {
      const mode = aliasExpansionModeFor(t);
      if (t === 'shell' || t === 'script') expect(mode).toBe('inline');
      else expect(mode).toBe('legend');
    }
  });

  it('defaults unknown types to inline (safe)', () => {
    expect(aliasExpansionModeFor('brand-new-agent')).toBe('inline');
  });
});

describe('expandForAgent — inline (raw executor)', () => {
  const resolved = { 'win服务器': 'ssh root@xxx -p2222' };

  it('substitutes resolved markers in place', () => {
    const r = expandForAgent('login ;;(win服务器) now', resolved, 'inline');
    expect(r.deliver).toBe(true);
    expect(r.text).toBe('login ssh root@xxx -p2222 now');
    expect(r.unresolved).toEqual([]);
  });

  it('fails closed when any marker is unresolved (no literal ;; to shell)', () => {
    const r = expandForAgent('run ;;(unknown) here', resolved, 'inline');
    expect(r.deliver).toBe(false);
    expect(r.reason).toBe(ALIAS_REASONS.UNRESOLVED_FAILCLOSED);
    expect(r.unresolved).toEqual(['unknown']);
    expect(r.text).toBe('');
  });

  it('is single-pass: does not re-expand a substituted value', () => {
    const r = expandForAgent(';;(a)', { a: ';;(b)' }, 'inline');
    expect(r.deliver).toBe(true);
    expect(r.text).toBe(';;(b)');
  });
});

describe('expandForAgent — legend (NL/LLM)', () => {
  it('prepends directive + one line per distinct marker, keeps body markers', () => {
    const r = expandForAgent('use ;;(host) and ;;(host)', { host: 'ssh h', unused: 'z' }, 'legend');
    expect(r.deliver).toBe(true);
    expect(r.text.startsWith(ALIAS_LEGEND_DIRECTIVE)).toBe(true);
    expect((r.text.match(/;;\(host\): ssh h/g) ?? []).length).toBe(1);
    expect(r.text.endsWith('use ;;(host) and ;;(host)')).toBe(true);
  });

  it('leaves unresolved markers literal and still delivers (no legend when none resolved)', () => {
    const r = expandForAgent('a ;;(missing) b', {}, 'legend');
    expect(r.deliver).toBe(true);
    expect(r.text).toBe('a ;;(missing) b');
    expect(r.unresolved).toEqual(['missing']);
  });
});

describe('sanitizeResolvedAliasValue (daemon enforcement point)', () => {
  it('strips ESC / ANSI control sequences', () => {
    const out = sanitizeResolvedAliasValue(`${ESC}[31mred${ESC}[0m`);
    expect(out).toBe('[31mred[0m');
    expect(out).not.toContain(ESC);
  });

  it('strips bare CR (\\r) and other C0/C1 controls but keeps the visible text', () => {
    expect(sanitizeResolvedAliasValue('line1\rline2')).toBe('line1line2');
    // BEL (U+0007) and a C1 control (U+0085 NEL) are removed.
    expect(sanitizeResolvedAliasValue('a\x07b\x85c')).toBe('abc');
  });

  it('removes NUL', () => {
    expect(sanitizeResolvedAliasValue(`a${NUL}b`)).toBe('ab');
    expect(sanitizeResolvedAliasValue(`a${NUL}b`)).not.toContain(NUL);
  });

  it('KEEPS newline and tab (OQ5: multi-line inline shell values allowed)', () => {
    expect(sanitizeResolvedAliasValue('l1\nl2')).toBe('l1\nl2');
    expect(sanitizeResolvedAliasValue('a\tb')).toBe('a\tb');
    expect(sanitizeResolvedAliasValue('a\n\tb')).toBe('a\n\tb');
  });

  it('caps to ALIAS_VALUE_MAX code points', () => {
    const long = 'x'.repeat(ALIAS_VALUE_MAX + 50);
    const out = sanitizeResolvedAliasValue(long);
    expect([...out].length).toBe(ALIAS_VALUE_MAX);
  });

  it('caps on a code-point boundary without splitting a surrogate pair', () => {
    // '😀' is a single code point (surrogate pair in UTF-16).
    const long = '😀'.repeat(ALIAS_VALUE_MAX + 10);
    const out = sanitizeResolvedAliasValue(long);
    expect([...out].length).toBe(ALIAS_VALUE_MAX);
    // No lone surrogate at the tail — every char round-trips as a full emoji.
    expect(out.endsWith('😀')).toBe(true);
  });

  it('NFC-normalizes the value', () => {
    // 'é' as e + combining acute (NFD) normalizes to the single-code-point NFC form.
    const nfd = 'é';
    const out = sanitizeResolvedAliasValue(nfd);
    expect(out).toBe('é');
    expect([...out].length).toBe(1);
  });
});

describe('expandForAgent — sanitizes injected values (control/ANSI stripped)', () => {
  it('inline: substituted value no longer contains a raw ESC', () => {
    const r = expandForAgent('run ;;(cmd)', { cmd: `ssh ${ESC}[31mhost${ESC}[0m` }, 'inline');
    expect(r.deliver).toBe(true);
    expect(r.text).not.toContain(ESC);
    expect(r.text).toBe('run ssh [31mhost[0m');
  });

  it('inline: NUL in a resolved value never reaches the agent-bound text', () => {
    const r = expandForAgent(';;(a)', { a: `x${NUL}y` }, 'inline');
    expect(r.deliver).toBe(true);
    expect(r.text).toBe('xy');
    expect(r.text).not.toContain(NUL);
  });

  it('legend: legend line value is sanitized (ESC stripped) before use', () => {
    const r = expandForAgent('use ;;(host)', { host: `h${ESC}[0m` }, 'legend');
    expect(r.deliver).toBe(true);
    expect(r.text).not.toContain(ESC);
    // The single-lined legend value is the sanitized text.
    expect(r.text).toContain(';;(host): h[0m');
  });
});
