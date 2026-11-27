import { describe, expect, it } from 'vitest';
import {
  VOICE_HOTWORDS_MAX_ALIASES,
  VOICE_HOTWORDS_MAX_CONTEXT_CHARS,
  VOICE_HOTWORDS_MAX_PROJECTS,
  VOICE_HOTWORDS_MAX_TERMS,
  applyVoiceHotwordPostProcess,
  canStoreVoiceHotwordProjectKey,
  coerceVoiceHotwordsSyncRecord,
  createNullProtoDict,
  decodeVoiceHotwordProjectKey,
  encodeVoiceHotwordProjectKey,
  entriesToVoiceHotwordRawText,
  formatVoiceHotwordsContext,
  getOwnDictValue,
  hasOwnDictKey,
  isValidVoiceHotwordProjectKey,
  mergeVoiceHotwordRawText,
  mergeVoiceHotwords,
  normalizeVoiceHotwordProjectKey,
  normalizeVoiceHotwordRawText,
  parseVoiceHotwordsInput,
  sanitizeRemoteVoiceHotwords,
  sanitizeVoiceHotwordText,
  setOwnDictValue,
} from '../../shared/voice-hotwords.js';

describe('shared voice hotwords', () => {
  it('parses plain terms and both alias syntaxes while stripping control characters', () => {
    const parsed = parseVoiceHotwordsInput([
      'IM.codes',
      '错别词 => 正确词',
      'im codes -> IM.codes',
      '  worktree\u0000\u0007  ',
      '',
      'codex-sdk',
    ].join('\n'));

    expect(parsed.terms).toEqual(['IM.codes', '正确词', 'IM.codes', 'worktree', 'codex-sdk']);
    expect(parsed.replacements).toEqual([
      { from: '错别词', to: '正确词' },
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
    expect(merged.asrTerms).toEqual(['IM.codes', 'worktree', 'Antigravity', 'im codes']);
    expect(merged.contextText).toBe('IM.codes, worktree, Antigravity, im codes');
    expect(merged.replacements).toEqual([{ from: 'im codes', to: 'IM.codes' }]);

    // Flood with 500 lines and oversized aliases
    const hugeLines = Array.from({ length: 500 }, (_, i) => `CustomTerm_${i}_${'x'.repeat(80)}`);
    const hugeAliases = Array.from({ length: 200 }, (_, i) => `alias_${i} => Target_${i}`);
    const bounded = mergeVoiceHotwords({
      projectRaw: [...hugeLines, ...hugeAliases].join('\n'),
      globalRaw: 'GlobalFallback',
    });

    expect(bounded.terms.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_TERMS);
    expect(bounded.asrTerms.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_TERMS);
    expect(bounded.contextText.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_CONTEXT_CHARS);
    expect(bounded.replacements.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_ALIASES);
    for (const term of bounded.terms) {
      expect(term.length).toBeLessThanOrEqual(64);
    }
  });

  it('places target terms in terms and front of asrTerms, and from triggers at back of asrTerms and in contextText', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'Kubernetes\n库伯 => Kubernetes\nK8s -> Kubernetes\nPrometheus',
    });

    // terms: only canonical terms and alias targets (1 line = 1 word for UI)
    expect(compiled.terms).toEqual(['Kubernetes', 'Prometheus']);
    // asrTerms: canonical terms first, then low-priority from triggers
    expect(compiled.asrTerms).toEqual(['Kubernetes', 'Prometheus', '库伯', 'K8s']);
    expect(compiled.contextText).toBe('Kubernetes, Prometheus, 库伯, K8s');
    expect(compiled.replacements).toEqual([
      { from: '库伯', to: 'Kubernetes' },
      { from: 'K8s', to: 'Kubernetes' },
    ]);
  });

  it('prioritizes all canonical terms over from triggers when approaching 60 terms budget', () => {
    // 58 canonical terms + 5 aliases whose targets add 2 more terms to reach 60 terms
    const baseTerms = Array.from({ length: 58 }, (_, i) => `NormTerm_${i}`);
    const aliases = Array.from({ length: 5 }, (_, i) => `Trigger_${i} => Target_${i}`);
    const compiled = mergeVoiceHotwords({
      projectRaw: [...baseTerms, ...aliases].join('\n'),
    });

    expect(compiled.terms.length).toBe(60);
    expect(compiled.terms.slice(0, 58)).toEqual(baseTerms);
    expect(compiled.terms.slice(58)).toEqual(['Target_0', 'Target_1']);
    // asrTerms is capped at 60 and contains all 60 terms; triggers never displace canonical terms
    expect(compiled.asrTerms.length).toBe(60);
    expect(compiled.asrTerms).toEqual(compiled.terms);

    // When canonical terms stop at 58 and targets already exist, remaining budget is filled by from triggers
    const compiledWithRoom = mergeVoiceHotwords({
      projectRaw: [...baseTerms, 'Trigger_A => NormTerm_0', 'Trigger_B => NormTerm_1', 'Trigger_C => NormTerm_2'].join('\n'),
    });
    expect(compiledWithRoom.terms.length).toBe(58);
    expect(compiledWithRoom.asrTerms.length).toBe(60);
    expect(compiledWithRoom.asrTerms.slice(0, 58)).toEqual(baseTerms);
    expect(compiledWithRoom.asrTerms.slice(58)).toEqual(['Trigger_A', 'Trigger_B']);
  });

  it('strictly bounds contextText to 1000 characters without truncating existing canonical terms', () => {
    // Build canonical terms totaling ~960 chars
    const chunks = Array.from({ length: 30 }, (_, i) => `LongCanonicalTerm_${i}_${'y'.repeat(15)}`);
    const longAlias = `${'z'.repeat(60)} => ShortTarget`;
    const compiled = mergeVoiceHotwords({
      projectRaw: [...chunks, longAlias].join('\n'),
    });

    expect(compiled.terms).toContain('ShortTarget');
    expect(compiled.contextText.length).toBeLessThanOrEqual(VOICE_HOTWORDS_MAX_CONTEXT_CHARS);
    for (const term of compiled.terms) {
      expect(compiled.asrTerms).toContain(term);
    }
  });

  it('prevents shadowed or protected global alias from triggers from leaking into asrTerms', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'Kubernetes\n库伯 => Kubernetes',
      globalRaw: '库伯 => WrongK8s\n全局专名 => GlobalTarget\nKubernetes => ShadowedK8s',
    });

    expect(compiled.terms).toEqual(['Kubernetes', 'GlobalTarget']);
    expect(compiled.asrTerms).toEqual(['Kubernetes', 'GlobalTarget', '库伯', '全局专名']);
    expect(compiled.contextText).toBe('Kubernetes, GlobalTarget, 库伯, 全局专名');
    expect(compiled.asrTerms).not.toContain('WrongK8s');
    expect(compiled.asrTerms).not.toContain('ShadowedK8s');
  });

  it('deduplicates from triggers case-insensitively and when from matches an existing term', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'kubernetes => Kubernetes\nk8s => Kubernetes\nK8S => Kubernetes',
    });

    // 'kubernetes' matches target 'Kubernetes' case-insensitively -> not duplicated in asrTerms
    // 'K8S' matches 'k8s' case-insensitively -> not duplicated in asrTerms
    expect(compiled.terms).toEqual(['Kubernetes']);
    expect(compiled.asrTerms).toEqual(['Kubernetes', 'k8s']);
    expect(compiled.contextText).toBe('Kubernetes, k8s');

    // Post processing still works accurately
    expect(applyVoiceHotwordPostProcess('deploy on k8s cluster', compiled)).toBe('deploy on Kubernetes cluster');
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
        '错别词 => IM.codes',
        'im codes -> IM.codes',
        'worktree',
        'codex-sdk',
        'C++',
        'foo.bar[0]',
      ].join('\n'),
    });

    // Alias replacement + ASCII word-boundary case normalization + punctuation adjacency + CJK adjacency
    expect(applyVoiceHotwordPostProcess('我在用错别词和im codes管理WorkTree，接入CODEX-SDK。', compiled))
      .toBe('我在用IM.codes和IM.codes管理worktree，接入codex-sdk。');

    // Regex metacharacters (`C++`, `foo.bar[0]`) never throw or break matching
    expect(applyVoiceHotwordPostProcess('compile c++ and check foo.bar[0] output', compiled))
      .toBe('compile C++ and check foo.bar[0] output');

    // URLs (including parenthesized paths with CJK), inline/fenced code, and compound identifiers are untouched
    expect(
      applyVoiceHotwordPostProcess(
        'Visit https://worktree.example.com/wiki/Foo_(WorkTree)/错别词 and [doc](https://example.com/imcodes_(CODEX-SDK)/错别词) or check `WorkTree` and ```ts\nconst x = "错别词 WorkTree";\n``` plus src/worktree_dir/im.codes.ts',
        compiled,
      ),
    ).toBe(
      'Visit https://worktree.example.com/wiki/Foo_(WorkTree)/错别词 and [doc](https://example.com/imcodes_(CODEX-SDK)/错别词) or check `WorkTree` and ```ts\nconst x = "错别词 WorkTree";\n``` plus src/worktree_dir/im.codes.ts',
    );
  });

  it('prevents global aliases from overriding project canonical terms and handles long lines linearly', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'IM.codes\nWorkTree',
      globalRaw: 'im.codes => WrongGlobal\nworktree => BadTree\n错别词 => IM.codes',
    });

    expect(applyVoiceHotwordPostProcess('Please check im.codes and worktree via 错别词 today.', compiled))
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

  it('preserves valid URLs containing single quotes and nested parens while correcting surrounding prose in linear time', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'WorkTree\nIM.codes\n错别词 => IM.codes',
    });

    const singleQuotedPathUrl = "https://en.wikipedia.org/wiki/O'Brien_(worktree)/错别词";
    expect(() => new URL(singleQuotedPathUrl)).not.toThrow();

    const text = `See ${singleQuotedPathUrl}, '${singleQuotedPathUrl}', and worktree for 错别词 today.`;
    expect(applyVoiceHotwordPostProcess(text, compiled))
      .toBe(`See ${singleQuotedPathUrl}, '${singleQuotedPathUrl}', and WorkTree for IM.codes today.`);

    // Unbalanced parens at scale inside URL candidate still run linearly
    const manyParensUrl = `https://example.com/${'('.repeat(200)}worktree/${')'.repeat(400)} 错别词`;
    const start = performance.now();
    const trimmed = applyVoiceHotwordPostProcess(manyParensUrl, compiled);
    expect(performance.now() - start).toBeLessThan(20);
    expect(trimmed).toContain('IM.codes');
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

  it('encodes, decodes, normalizes, and validates project keys consistently', () => {
    expect(encodeVoiceHotwordProjectKey('codedeck', 'srv-1')).toBe('srv:srv-1::codedeck');
    expect(encodeVoiceHotwordProjectKey('codedeck', 'srv-2')).toBe('srv:srv-2::codedeck');
    // Raw projectName with reserved srv:...::... shape STILL binds the provided serverId
    expect(encodeVoiceHotwordProjectKey('srv:srv-1::codedeck', 'srv-2')).toBe('srv:srv-2::srv:srv-1::codedeck');
    expect(decodeVoiceHotwordProjectKey('srv:srv-2::srv:srv-1::codedeck')).toEqual({
      serverId: 'srv-2',
      projectName: 'srv:srv-1::codedeck',
    });
    expect(encodeVoiceHotwordProjectKey('plain-proj', '')).toBe('plain-proj');
    expect(encodeVoiceHotwordProjectKey('   ')).toBeNull();
    expect(decodeVoiceHotwordProjectKey('srv:srv-1::codedeck')).toEqual({ serverId: 'srv-1', projectName: 'codedeck' });
    expect(decodeVoiceHotwordProjectKey('plain-proj')).toEqual({ serverId: null, projectName: 'plain-proj' });
    expect(normalizeVoiceHotwordProjectKey('srv:srv-1::codedeck')).toBe('srv:srv-1::codedeck');
    expect(normalizeVoiceHotwordProjectKey('plain-proj')).toBe('plain-proj');
    expect(normalizeVoiceHotwordProjectKey({ projectName: 'srv:other::app', serverId: 'srv/a' })).toBe('srv:srv%2Fa::srv:other::app');

    expect(isValidVoiceHotwordProjectKey('srv:srv-1::codedeck')).toBe(true);
    expect(isValidVoiceHotwordProjectKey('codedeck')).toBe(true);
    expect(isValidVoiceHotwordProjectKey('')).toBe(false);
    expect(isValidVoiceHotwordProjectKey(' codedeck')).toBe(false);
    expect(isValidVoiceHotwordProjectKey('bad\nkey')).toBe(false);
    expect(isValidVoiceHotwordProjectKey('x'.repeat(300))).toBe(false);
  });

  it('normalizes raw text and merges lines cleanly with case/alias deduplication', () => {
    expect(normalizeVoiceHotwordRawText('a\r\nb\u0000c')).toBe('a\nbc');
    expect(normalizeVoiceHotwordRawText('  \r\n  ')).toBe('');

    const merged = mergeVoiceHotwordRawText(
      'IM.codes\n错别词 => IM.codes\nWorkTree',
      'im.codes\n错别词 -> IM.codes\n  worktree \ncodex-sdk\nCODEX-SDK\n新术语 => NewTerm',
    );
    expect(merged).toBe('IM.codes\n错别词 => IM.codes\nWorkTree\ncodex-sdk\n新术语 => NewTerm');
  });

  it('handles prototype-colliding legacy project keys safely and preserves empty tombstones up to max projects', () => {
    const protoJson = '{"version":1,"user":{"raw":"GlobalTerm\\r\\n","updatedAt":100.8,"source":"mcp"},"projects":{"valid":{"raw":"ProjTerm","updatedAt":200,"source":"web"},"__proto__":{"raw":"ProtoTerm","updatedAt":210},"constructor":{"raw":"CtorTerm","updatedAt":220},"toString":{"raw":"StrTerm","updatedAt":230},"bad\\nkey":{"raw":"Ignored","updatedAt":300}},"shareWithOthers":{"enabled":true,"updatedAt":50}}';
    const coerced = coerceVoiceHotwordsSyncRecord(JSON.parse(protoJson));
    expect(Object.getPrototypeOf(coerced.projects)).toBeNull();
    expect(hasOwnDictKey(coerced.projects, '__proto__')).toBe(true);
    expect(getOwnDictValue(coerced.projects, '__proto__')).toEqual({ raw: 'ProtoTerm', updatedAt: 210 });
    expect(getOwnDictValue(coerced.projects, 'constructor')).toEqual({ raw: 'CtorTerm', updatedAt: 220 });
    expect(getOwnDictValue(coerced.projects, 'toString')).toEqual({ raw: 'StrTerm', updatedAt: 230 });
    expect(getOwnDictValue(coerced.projects, 'valueOf')).toBeUndefined();
    expect(hasOwnDictKey(coerced.projects, 'bad\nkey')).toBe(false);
    expect(coerced.user).toEqual({ raw: 'GlobalTerm\n', updatedAt: 100, source: 'mcp' });
    expect(coerced.shareWithOthers).toEqual({ enabled: true, updatedAt: 50 });

    expect(entriesToVoiceHotwordRawText(['  IM.codes ', '错别词 => IM.codes'])).toBe('IM.codes\n错别词 => IM.codes');

    const projects = createNullProtoDict<{ raw: string; updatedAt: number }>();
    setOwnDictValue(projects, 'tombOld', { raw: '', updatedAt: 10 });
    for (let i = 0; i < VOICE_HOTWORDS_MAX_PROJECTS - 1; i += 1) {
      setOwnDictValue(projects, `p${i}`, { raw: `Term${i}`, updatedAt: 100 + i });
    }
    expect(canStoreVoiceHotwordProjectKey(projects, 'tombOld')).toBe(true);
    expect(canStoreVoiceHotwordProjectKey(projects, 'brand-new')).toBe(false);
  });
});
