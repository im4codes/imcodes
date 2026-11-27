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
  hasPcm16SpeechEnergy,
  isValidVoiceHotwordProjectKey,
  mergeVoiceHotwordRawText,
  mergeVoiceHotwords,
  normalizeVoiceHotwordProjectKey,
  normalizeVoiceHotwordRawText,
  parseVoiceHotwordsInput,
  sanitizeRemoteVoiceHotwords,
  sanitizeVoiceHotwordText,
  setOwnDictValue,
  stripVoiceHotwordHallucination,
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

  it('strips multi-term hotword hallucination loops and silent-audio single echoes while preserving real speech', () => {
    const compiled = mergeVoiceHotwords({
      projectRaw: 'IM.codes\nCodex\nClaude\nwork\ntree\n错别词 => IM.codes',
    });

    // Exact reproduced user counterexample: alternating CJK comma/period, 4 occurrences
    expect(stripVoiceHotwordHallucination('IM.codes，IM.codes。IM.codes，IM.codes。', compiled)).toBe('');
    expect(stripVoiceHotwordHallucination('IM.codes，IM.codes。IM.codes，IM.codes。', ['IM.codes'])).toBe('');
    expect(stripVoiceHotwordHallucination('IM.codes IM.codes', ['IM.codes'])).toBe('');
    expect(stripVoiceHotwordHallucination('IM.codes, Codex, Claude', compiled)).toBe('');
    // Case-insensitive & alias trigger matching
    expect(stripVoiceHotwordHallucination('im.codes！codex？错别词。', compiled)).toBe('');
    expect(stripVoiceHotwordHallucination('「IM.codes」\n(Codex)...', compiled)).toBe('');

    // Fullwidth width/punctuation variants and immediate same-term concatenation
    expect(stripVoiceHotwordHallucination('IM．codes，IM．codes。', compiled)).toBe('');
    expect(stripVoiceHotwordHallucination('ＩＭ．ｃｏｄｅｓ，IM.codes！', ['IM.codes'])).toBe('');
    expect(stripVoiceHotwordHallucination('IM.codesIM.codes', compiled)).toBe('');
    expect(stripVoiceHotwordHallucination('IM．codesIM.codes', compiled)).toBe('');
    expect(stripVoiceHotwordHallucination('打开 IM．codes 看下 worktree', compiled, { silentAudio: true })).toBe('打开 IM．codes 看下 worktree');

    // Single hotword echo: stripped ONLY when silentAudio=true, preserved on normal speech
    expect(stripVoiceHotwordHallucination('IM.codes', compiled, { silentAudio: true })).toBe('');
    expect(stripVoiceHotwordHallucination('IM．codes。', ['IM.codes'], { silentAudio: true })).toBe('');
    expect(stripVoiceHotwordHallucination('IM.codes', compiled, { silentAudio: false })).toBe('IM.codes');
    expect(stripVoiceHotwordHallucination('IM.codes', compiled)).toBe('IM.codes');

    // Compound ASCII words ('worktree') must NOT match separate ASCII hotwords ('work', 'tree')
    expect(stripVoiceHotwordHallucination('worktree', compiled, { silentAudio: true })).toBe('worktree');
    expect(stripVoiceHotwordHallucination('worktree', ['work', 'tree'], { silentAudio: true })).toBe('worktree');
    expect(stripVoiceHotwordHallucination('work, tree', compiled, { silentAudio: false })).toBe('');
    expect(stripVoiceHotwordHallucination('IM.codesIM.codes', ['IM.codes'])).toBe('');

    // Normal speech containing hotwords (including multiple hotwords) MUST remain intact
    const intactCases = [
      'IM.codes 的热词有 bug',
      '打开 IM.codes 再看看 IM.codes',
      '在 IM.codes 里配置 Codex 和 Claude',
      'worktree',
      '...',
      '   ',
      '',
    ];
    for (const sample of intactCases) {
      expect(stripVoiceHotwordHallucination(sample, compiled, { silentAudio: true })).toBe(sample);
      expect(stripVoiceHotwordHallucination(sample, compiled, { silentAudio: false })).toBe(sample);
    }

    // Empty hotwords never strip anything
    expect(stripVoiceHotwordHallucination('IM.codes，IM.codes。IM.codes，IM.codes。', [])).toBe('IM.codes，IM.codes。IM.codes，IM.codes。');

    // Leading / trailing repeated-hotword edge hallucination stripping
    expect(
      stripVoiceHotwordHallucination('IM.codes，IM.codes。你答的对，就这么来。', compiled),
    ).toBe('你答的对，就这么来。');
    expect(
      stripVoiceHotwordHallucination(
        '我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。IM.codes，IM.codes。',
        compiled,
      ),
    ).toBe('我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。');
    expect(
      stripVoiceHotwordHallucination('我要的是速度 IM.codes IM.codes', compiled),
    ).toBe('我要的是速度');
    expect(
      stripVoiceHotwordHallucination('我要的是速度，IM.codes，IM.codes。', compiled),
    ).toBe('我要的是速度');
    expect(
      stripVoiceHotwordHallucination(
        'ＩＭ．ｃｏｄｅｓ，IM.codes。你答的对，就这么来。Codex, Codex!',
        ['IM.codes', 'Codex'],
      ),
    ).toBe('你答的对，就这么来。');
    expect(
      stripVoiceHotwordHallucination('IM.codesIM.codes 你好', ['IM.codes']),
    ).toBe('你好');
    expect(
      stripVoiceHotwordHallucination('我要的是速度IM.codes，IM.codes。', ['IM.codes']),
    ).toBe('我要的是速度');
    // >= 3 distinct hotwords adjacent to sentence end strip, while comma-listed tools stay intact
    expect(
      stripVoiceHotwordHallucination('IM.codes, Claude, Codex。开始工作', ['IM.codes', 'Claude', 'Codex']),
    ).toBe('开始工作');
    expect(
      stripVoiceHotwordHallucination('开始工作。IM.codes, Claude, Codex。', ['IM.codes', 'Claude', 'Codex']),
    ).toBe('开始工作。');
    expect(
      stripVoiceHotwordHallucination('请你对比 IM.codes, Claude, Codex。', ['IM.codes', 'Claude', 'Codex']),
    ).toBe('请你对比 IM.codes, Claude, Codex。');
    // Unicode combining marks & surrogate-pair emoji safety on boundaries
    expect(
      stripVoiceHotwordHallucination('IM.codes，IM.codes。Café👍🏽，IM.codes，IM.codes。', ['IM.codes']),
    ).toBe('Café👍🏽');
    expect(
      stripVoiceHotwordHallucination('e\u0301, e\u0301。你好', ['é']),
    ).toBe('你好');
    // Edge negative safety: single hotword or partial-identifier boundary must remain intact
    expect(stripVoiceHotwordHallucination('IM.codes is great', ['IM.codes'])).toBe('IM.codes is great');
    expect(stripVoiceHotwordHallucination('Use IM.codes', ['IM.codes'])).toBe('Use IM.codes');
    expect(stripVoiceHotwordHallucination('testcode, code', ['code'])).toBe('testcode, code');
    expect(stripVoiceHotwordHallucination('code, codeReview', ['code'])).toBe('code, codeReview');
    expect(stripVoiceHotwordHallucination('Check foo.bar.baz', ['foo', 'bar'])).toBe('Check foo.bar.baz');
    expect(stripVoiceHotwordHallucination('foo.bar.baz', ['foo', 'bar'])).toBe('foo.bar.baz');
    expect(stripVoiceHotwordHallucination('我想要你的代码，代码', ['代码'])).toBe('我想要你的代码，代码');
    expect(stripVoiceHotwordHallucination('你好，你好吗', ['你好'])).toBe('你好，你好吗');
    expect(stripVoiceHotwordHallucination('IM.codes、Codex 都要支持', ['IM.codes', 'Codex'])).toBe('IM.codes、Codex 都要支持');
    expect(stripVoiceHotwordHallucination('IM.codes 和 IM.codes 的区别', ['IM.codes'])).toBe('IM.codes 和 IM.codes 的区别');
    expect(
      stripVoiceHotwordHallucination('IM.codes，IM.codes。你好世界。IM.codes，IM.codes。', ['IM.codes']),
    ).toBe('你好世界。');

    // Cross-platform shared matrix: non-adjacent A/B/A preservation, preceding sentence protection,
    // adjacent A/A & sentence-bound A/B/C, Hangul Jamo composition, NFD vs NFC, distinct accents, emoji.
    expect(
      stripVoiceHotwordHallucination('IM.codes, Codex, IM.codes 都是我在用的工具', ['IM.codes', 'Codex']),
    ).toBe('IM.codes, Codex, IM.codes 都是我在用的工具');
    expect(
      stripVoiceHotwordHallucination('Codex。IM.codes，IM.codes。你好', ['IM.codes', 'Codex']),
    ).toBe('Codex。IM.codes，IM.codes。你好');
    expect(
      stripVoiceHotwordHallucination('IM.codes，IM.codes。Codex。你好', ['IM.codes', 'Codex']),
    ).toBe('Codex。你好');
    expect(
      stripVoiceHotwordHallucination('打开 Codex，IM.codes，IM.codes。', ['IM.codes', 'Codex']),
    ).toBe('打开 Codex');
    expect(
      stripVoiceHotwordHallucination('先看。Codex。IM.codes, Claude, Qwen。', ['IM.codes', 'Codex', 'Claude', 'Qwen']),
    ).toBe('先看。Codex。');
    expect(stripVoiceHotwordHallucination('가, 가', ['가'])).toBe('');
    expect(stripVoiceHotwordHallucination('가, 가。你好', ['가'])).toBe('你好');
    expect(stripVoiceHotwordHallucination('Café, Cafe\u0301。你好', ['Café'])).toBe('你好');
    expect(stripVoiceHotwordHallucination('code\u0301, code。你好', ['code'])).toBe('code\u0301, code。你好');
    expect(stripVoiceHotwordHallucination('cod\u0301, code。你好', ['code'])).toBe('cod\u0301, code。你好');
    expect(stripVoiceHotwordHallucination('IM.codes', null, { silentAudio: true })).toBe('IM.codes');

    // Performance bound: 60 hotwords across ~1000 chars stays sub-millisecond (including shared-prefix unmatchable text)
    const rules60 = Array.from({ length: 60 }, (_, i) => `HotwordTerm_${i}`).join('\n');
    const compiled60 = mergeVoiceHotwords({ projectRaw: rules60 });
    const echoText = Array.from({ length: 60 }, (_, i) => `HotwordTerm_${i}`).join(', ');
    const normalText = `Please verify HotwordTerm_0 with ${'real speech context '.repeat(45)}HotwordTerm_59`;
    expect(normalText.length).toBeGreaterThanOrEqual(900);
    expect(stripVoiceHotwordHallucination(echoText, compiled60)).toBe('');

    const sharedPrefixRawTerms = Array.from({ length: 60 }, (_, i) => `a${i}`);
    const repeatedPrefixUnmatched = 'a'.repeat(1000);
    const groupTerms = Array.from({ length: 60 }, (_, i) => `global task ${String(i).padStart(2, '0')}`);
    const groupUnmatched = `${'global task '.repeat(80)}x`;
    const dotATerms = [
      ...Array.from({ length: 12 }, (_, i) => '.a'.repeat(i + 1)),
      ...Array.from({ length: 48 }, (_, i) => `tool${i}`),
    ];
    const dotAEcho500 = '.a'.repeat(500);
    const dotAUnmatched500 = `${'.a'.repeat(500)}x`;
    expect(stripVoiceHotwordHallucination(dotAEcho500, dotATerms)).toBe('');
    expect(stripVoiceHotwordHallucination(dotAUnmatched500, dotATerms)).toBe(dotAUnmatched500);

    // Warm caches before timing
    for (let i = 0; i < 10; i += 1) {
      stripVoiceHotwordHallucination(echoText, compiled60);
      stripVoiceHotwordHallucination(normalText, compiled60);
      stripVoiceHotwordHallucination(repeatedPrefixUnmatched, sharedPrefixRawTerms);
      stripVoiceHotwordHallucination(groupUnmatched, groupTerms);
      stripVoiceHotwordHallucination(dotAEcho500, dotATerms);
      stripVoiceHotwordHallucination(dotAUnmatched500, dotATerms);
    }

    const start = performance.now();
    const iterations = 100;
    for (let i = 0; i < iterations; i += 1) {
      expect(stripVoiceHotwordHallucination(echoText, compiled60)).toBe('');
      expect(stripVoiceHotwordHallucination(normalText, compiled60)).toBe(normalText);
      expect(stripVoiceHotwordHallucination(repeatedPrefixUnmatched, sharedPrefixRawTerms)).toBe(repeatedPrefixUnmatched);
      expect(stripVoiceHotwordHallucination(groupUnmatched, groupTerms)).toBe(groupUnmatched);
      expect(stripVoiceHotwordHallucination(dotAEcho500, dotATerms)).toBe('');
      expect(stripVoiceHotwordHallucination(dotAUnmatched500, dotATerms)).toBe(dotAUnmatched500);
    }
    const avgPerCallMs = (performance.now() - start) / (iterations * 6);
    expect(avgPerCallMs).toBeLessThan(1);
  });

  it('detects PCM16 speech energy safely across silence, faint noise, quiet speech, empty, and odd-byte buffers', () => {
    // Empty, 1-byte, odd trailing byte, and zero-filled buffers
    expect(hasPcm16SpeechEnergy(new Uint8Array(0))).toBe(false);
    expect(hasPcm16SpeechEnergy(new Uint8Array([0xff]))).toBe(false);
    expect(hasPcm16SpeechEnergy(new Uint8Array(3200))).toBe(false);

    // Odd-byte trailing silence with non-zero noise below threshold does not throw
    const faintNoise = new Uint8Array(3201);
    for (let i = 0; i < 1600; i += 1) {
      const val = i % 2 === 0 ? 100 : -100; // ~0.00305 amplitude (< 0.005 RMS, < 0.015 peak)
      faintNoise[i * 2] = val & 0xff;
      faintNoise[i * 2 + 1] = (val >> 8) & 0xff;
    }
    faintNoise[3200] = 0xab;
    expect(hasPcm16SpeechEnergy(faintNoise, 16_000)).toBe(false);

    // Quiet speech peak (~0.03) inside mostly quiet buffer passes
    const quietSpeechPeak = new Uint8Array(3200);
    const quietSample = Math.round(0.03 * 32768);
    quietSpeechPeak[1600] = quietSample & 0xff;
    quietSpeechPeak[1601] = (quietSample >> 8) & 0xff;
    expect(hasPcm16SpeechEnergy(quietSpeechPeak, 16_000)).toBe(true);

    // Sustained soft speech (peak ~0.01 < 0.015, RMS ~0.007 >= 0.005) straddling 50ms window boundary passes
    const softSustained = new Uint8Array(3200); // 100ms
    const softSample = Math.round(0.008 * 32768);
    for (let i = 400; i < 1200; i += 1) {
      softSustained[i * 2] = softSample & 0xff;
      softSustained[i * 2 + 1] = (softSample >> 8) & 0xff;
    }
    expect(hasPcm16SpeechEnergy(softSustained, 16_000)).toBe(true);
  });
});
