import { describe, expect, it } from 'vitest';
import {
  VOICE_HOTWORDS_MAX_ALIASES,
  VOICE_HOTWORDS_MAX_CONTEXT_CHARS,
  VOICE_HOTWORDS_MAX_TERMS,
  applyVoiceHotwordPostProcess,
  formatVoiceHotwordsContext,
  mergeVoiceHotwords,
  parseVoiceHotwordsInput,
  sanitizeRemoteVoiceHotwords,
  sanitizeVoiceHotwordText,
} from '../../shared/voice-hotwords.js';

describe('shared voice hotwords', () => {
  it('parses plain terms and both alias syntaxes while stripping control characters', () => {
    const parsed = parseVoiceHotwordsInput([
      'IM.codes',
      '爱码 => IM.codes',
      'im codes -> IM.codes',
      '  worktree\u0000\u0007  ',
      '',
      'codex-sdk',
    ].join('\n'));

    expect(parsed.terms).toEqual(['IM.codes', 'IM.codes', 'IM.codes', 'worktree', 'codex-sdk']);
    expect(parsed.replacements).toEqual([
      { from: '爱码', to: 'IM.codes' },
      { from: 'im codes', to: 'IM.codes' },
    ]);
  });

  it('merges project terms before global terms, deduplicates case-insensitively, and enforces strict budgets', () => {
    const projectLines = ['IM.codes', 'worktree', 'im codes => IM.codes'];
    const globalLines = ['im.codes', 'Antigravity', 'im codes => GlobalWrong'];

    const merged = mergeVoiceHotwords({
      projectRaw: projectLines.join('\n'),
      globalRaw: globalLines.join('\n'),
    });

    expect(merged.terms).toEqual(['IM.codes', 'worktree', 'Antigravity']);
    expect(merged.contextText).toBe('IM.codes, worktree, Antigravity');
    expect(merged.replacements).toEqual([{ from: 'im codes', to: 'IM.codes' }]);

    // Flood with 500 lines and oversized aliases
    const hugeLines = Array.from({ length: 500 }, (_, i) => `CustomTerm_${i}_${'x'.repeat(80)}`);
    const hugeAliases = Array.from({ length: 200 }, (_, i) => `alias_${i} => Target_${i}`);
    const bounded = mergeVoiceHotwords({
      projectRaw: [...hugeLines, ...hugeAliases].join('\n'),
      globalRaw: 'GlobalFallback',
    });

    expect(bounded.terms.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_TERMS);
    expect(bounded.contextText.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_CONTEXT_CHARS);
    expect(bounded.replacements.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_ALIASES);
    for (const term of bounded.terms) {
      expect(term.length).toBeLessThanOrEqual(64);
    }
  });

  it('sanitizes remote wire hotwords and rejects non-array / non-string payloads', () => {
    expect(sanitizeRemoteVoiceHotwords(undefined)).toEqual({ ok: true, hotwords: undefined });
    expect(sanitizeRemoteVoiceHotwords('IM.codes')).toEqual({ ok: false, message: 'Invalid hotwords' });
    expect(sanitizeRemoteVoiceHotwords([123])).toEqual({ ok: false, message: 'Invalid hotwords' });
    expect(sanitizeRemoteVoiceHotwords(['  IM.codes\u0000 ', 'im.codes', 'worktree', ''])).toEqual({
      ok: true,
      hotwords: ['IM.codes', 'worktree'],
    });
    expect(formatVoiceHotwordsContext(['IM.codes', 'worktree'])).toBe('IM.codes, worktree');
    expect(sanitizeVoiceHotwordText('a\n\tb\u0007')).toBe('a b');
  });

  it('performs deterministic post-processing without corrupting URLs or code identifiers and escapes regex metacharacters', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: [
        'IM.codes',
        '爱码 => IM.codes',
        'im codes -> IM.codes',
        'worktree',
        'codex-sdk',
        'C++',
        'foo.bar[0]',
      ].join('\n'),
    });

    // Alias replacement + ASCII word-boundary case normalization + punctuation adjacency + CJK adjacency
    expect(applyVoiceHotwordPostProcess('我在用爱码和im codes管理WorkTree，接入CODEX-SDK。', compiled))
      .toBe('我在用IM.codes和IM.codes管理worktree，接入codex-sdk。');

    // Regex metacharacters (`C++`, `foo.bar[0]`) never throw or break matching
    expect(applyVoiceHotwordPostProcess('compile c++ and check foo.bar[0] output', compiled))
      .toBe('compile C++ and check foo.bar[0] output');

    // URLs (including parenthesized paths with CJK), inline/fenced code, and compound identifiers are untouched
    expect(
      applyVoiceHotwordPostProcess(
        'Visit https://worktree.example.com/wiki/Foo_(WorkTree)/爱码 and [doc](https://example.com/imcodes_(CODEX-SDK)/爱码) or check `WorkTree` and ```ts\nconst x = "爱码 WorkTree";\n``` plus src/worktree_dir/im.codes.ts',
        compiled,
      ),
    ).toBe(
      'Visit https://worktree.example.com/wiki/Foo_(WorkTree)/爱码 and [doc](https://example.com/imcodes_(CODEX-SDK)/爱码) or check `WorkTree` and ```ts\nconst x = "爱码 WorkTree";\n``` plus src/worktree_dir/im.codes.ts',
    );
  });

  it('prevents global aliases from overriding project canonical terms and handles long lines linearly', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'IM.codes\nWorkTree',
      globalRaw: 'im.codes => WrongGlobal\nworktree => BadTree\n爱码 => IM.codes',
    });

    expect(applyVoiceHotwordPostProcess('Please check im.codes and worktree via 爱码 today.', compiled))
      .toBe('Please check IM.codes and WorkTree via IM.codes today.');

    // Pathological long line with repeated arrows / unpaired backticks finishes well within budget
    const pathological = `${'a '.repeat(4000)} ${'`'.repeat(500)} not_an_arrow => x`;
    const parsed = parseVoiceHotwordsInput(pathological);
    expect(parsed.terms.length).toBeLessThanOrEqual(1);
    const t0 = performance.now();
    const out = applyVoiceHotwordPostProcess(pathological, compiled);
    expect(performance.now() - t0).toBeLessThan(15);
    expect(out).toBe(pathological);
  });

  it('completes 60 rules across >=500 chars in well under 1ms', () => {
    const rules = Array.from({ length: 60 }, (_, i) => `wrongterm${i} => CorrectTerm_${i}`).join('\n');
    const compiled = mergeVoiceHotwords({ projectRaw: rules });
    const text = '请帮我检查 wrongterm0 和 wrongterm15 以及 wrongterm59 在这个项目里的运行情况，还有其它无关内容重复拼接。'.repeat(11);
    expect(text.length).toBeGreaterThanOrEqual(500);

    // Warm regex cache once, then measure execution
    const out = applyVoiceHotwordPostProcess(text, compiled);
    expect(out).toContain('CorrectTerm_0');
    expect(out).toContain('CorrectTerm_59');

    const iterations = 20;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      applyVoiceHotwordPostProcess(text, compiled);
    }
    const avgMs = (performance.now() - start) / iterations;
    expect(avgMs).toBeLessThan(1);
  });
});
