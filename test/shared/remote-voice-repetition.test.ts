import { describe, expect, it } from 'vitest';
import {
  resolveSessionTranscriptResult,
  sanitizeAsrRepetitionLoop,
  sanitizeVoiceTranscriptWithHotwords,
  stripAsrControlTags,
} from '../../shared/remote-voice.js';

describe('stripAsrControlTags', () => {
  it('strips Qwen3-ASR language control prefixes (including LF/CRLF separators) and special tags without altering normal words', () => {
    const cases: Array<[string, string]> = [
      ['language None<asr_text>', ''],
      ['language\nNone<asr_text>', ''],
      ['language\r\nNone<asr_text>', ''],
      ['language\t\n  None\r\n<asr_text>', ''],
      ['language Chinese<asr_text>第一段检查。', '第一段检查。'],
      ['language\nChinese<asr_text>前文', '前文'],
      ['language\r\nChinese<asr_text>前文', '前文'],
      ['language English<asr_text>Hello world', 'Hello world'],
      ['Whiskey 五百五十。 language None<asr_text>十五x ray', 'Whiskey 五百五十。 十五x ray'],
      ['第一句。language None<asr_text>第二句', '第一句。第二句'],
      ['<|endoftext|>hello<asr_text><|zh|>', 'hello'],
      ['the language model is fast', 'the language model is fast'],
      ['the language\nmodel is fast', 'the language\nmodel is fast'],
      ['language None is just words', 'language None is just words'],
    ];
    for (const [raw, expected] of cases) {
      expect(stripAsrControlTags(raw)).toBe(expected);
    }
  });
});

describe('resolveSessionTranscriptResult', () => {
  it('preserves prior non-empty text across empty/tag-only isFinal while letting non-empty final win', () => {
    const s1 = resolveSessionTranscriptResult('第一段', false, '');
    expect(s1).toEqual({ emit: true, text: '第一段', nextLastNonEmptyText: '第一段' });

    const s2 = resolveSessionTranscriptResult('language\nNone<asr_text>', false, s1.nextLastNonEmptyText);
    expect(s2).toEqual({ emit: false, text: '', nextLastNonEmptyText: '第一段' });

    const s3 = resolveSessionTranscriptResult('language None<asr_text>', true, s2.nextLastNonEmptyText);
    expect(s3).toEqual({ emit: true, text: '第一段', nextLastNonEmptyText: '第一段' });

    const s4 = resolveSessionTranscriptResult('第一段。第二段。', true, s2.nextLastNonEmptyText);
    expect(s4).toEqual({ emit: true, text: '第一段。第二段。', nextLastNonEmptyText: '第一段。第二段。' });

    const emptySessionFinal = resolveSessionTranscriptResult('language None<asr_text>', true, '');
    expect(emptySessionFinal).toEqual({ emit: true, text: '', nextLastNonEmptyText: '' });
  });
});

describe('sanitizeAsrRepetitionLoop', () => {
  it('eliminates Qwen3-ASR control tags and tag-prefixed repetition bursts', () => {
    expect(sanitizeAsrRepetitionLoop('language None<asr_text>')).toBe('');
    expect(sanitizeAsrRepetitionLoop('language Chinese<asr_text>第一段检查。')).toBe('第一段检查。');
    expect(sanitizeAsrRepetitionLoop('language Chinese<asr_text>' + '想，他'.repeat(30))).toBe('');
    expect(sanitizeAsrRepetitionLoop('Whiskey 五百五十。 language None<asr_text>十五x ray')).toBe(
      'Whiskey 五百五十。 十五x ray',
    );
  });
  it('eliminates pure runaway repetition bursts matching the live screenshot counterexample', () => {
    expect(sanitizeAsrRepetitionLoop('想，他'.repeat(60))).toBe('');
    expect(sanitizeAsrRepetitionLoop('想，他'.repeat(60) + '想，')).toBe('');
    expect(sanitizeAsrRepetitionLoop('啊啊啊啊啊啊啊啊')).toBe('');
    expect(sanitizeAsrRepetitionLoop(',,,,,,,,')).toBe('');
  });

  it('strips trailing repetition loops while preserving real preceding speech', () => {
    expect(sanitizeAsrRepetitionLoop('明天开会讨论方案，想，他想，他想，他想，他想，他想，他')).toBe(
      '明天开会讨论方案，',
    );
    expect(sanitizeAsrRepetitionLoop('Please check the logs, you know you know you know you know you know you know')).toBe(
      'Please check the logs,',
    );
  });

  it('leaves normal speech, numbers, URLs, and short expressions untouched', () => {
    const unchanged = [
      '哈哈哈哈',
      '对对对',
      '好好好',
      '谢谢谢谢',
      '等等我看看',
      'yes yes yes',
      'really really good',
      '10000000',
      '2026-11-23',
      'https://example.com/aaa',
      'www.example.com',
      '好的...',
      '哈哈哈确实不错',
      '真的真的真的很有意思',
    ];
    for (const sample of unchanged) {
      expect(sanitizeAsrRepetitionLoop(sample)).toBe(sample);
    }
  });

  it('returns empty string for empty or whitespace-only inputs', () => {
    expect(sanitizeAsrRepetitionLoop('')).toBe('');
    expect(sanitizeAsrRepetitionLoop('   \n\t  ')).toBe('');
  });

  it('handles 2000+ character normal transcripts quickly in bounded O(n) time', () => {
    const sentence = '这是一段正常的中文和English混合语音识别测试内容，包含标点符号和数字12345。';
    const uniqueLongText = Array.from({ length: 60 }, (_, idx) => `第${idx + 1}条：${sentence}`).join('');
    expect(uniqueLongText.length).toBeGreaterThan(2400);

    // Warm-up to eliminate cold JIT compilation / engine tier-up overhead
    expect(sanitizeAsrRepetitionLoop(uniqueLongText)).toBe(uniqueLongText);

    // Multi-sample timing to guard against GC pauses or loaded CI scheduling jitter
    let minElapsedMs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = sanitizeAsrRepetitionLoop(uniqueLongText);
      const elapsedMs = performance.now() - start;
      expect(result).toBe(uniqueLongText);
      if (elapsedMs < minElapsedMs) {
        minElapsedMs = elapsedMs;
      }
    }

    expect(minElapsedMs).toBeLessThan(100);
  });
});

describe('sanitizeVoiceTranscriptWithHotwords & resolveSessionTranscriptResult hotwords order', () => {
  it('strips ASR control tags first, catches full hotword hallucinations before repetition-loop trimming, and runs a post-loop pass', () => {
    const hotwords = ['Codex', 'IM.codes'];

    // "Codex，" + 6x "IM.codes。" must collapse to "" instead of losing "IM.codes" to repetition loop first and leaving "Codex"
    expect(sanitizeVoiceTranscriptWithHotwords(`Codex，${'IM.codes。'.repeat(6)}`, hotwords)).toBe('');

    // Control tag before 4-repeat hotword echo must be stripped before hotword check
    expect(
      sanitizeVoiceTranscriptWithHotwords('language None<asr_text>IM.codes，IM.codes。IM.codes，IM.codes。', hotwords),
    ).toBe('');

    // Normal speech with control tag & hotwords stays intact
    expect(sanitizeVoiceTranscriptWithHotwords('language Chinese<asr_text>打开 IM.codes 再看看 Codex', hotwords)).toBe(
      '打开 IM.codes 再看看 Codex',
    );

    // Trailing repetition burst + real speech keeps real speech
    expect(
      sanitizeVoiceTranscriptWithHotwords(`打开 IM.codes，${'IM.codes。'.repeat(6)}`, hotwords),
    ).toBe('打开 IM.codes，');

    // resolveSessionTranscriptResult preserves prior real speech if a hallucinated final frame arrives
    const r1 = resolveSessionTranscriptResult('language Chinese<asr_text>打开 IM.codes', false, '', hotwords);
    expect(r1).toEqual({ emit: true, text: '打开 IM.codes', nextLastNonEmptyText: '打开 IM.codes' });
    const r2 = resolveSessionTranscriptResult(
      'language None<asr_text>IM.codes，IM.codes。IM.codes，IM.codes。',
      false,
      r1.nextLastNonEmptyText,
      hotwords,
    );
    expect(r2).toEqual({ emit: false, text: '', nextLastNonEmptyText: '打开 IM.codes' });
    const r3 = resolveSessionTranscriptResult(`Codex，${'IM.codes。'.repeat(6)}`, true, r2.nextLastNonEmptyText, hotwords);
    expect(r3).toEqual({ emit: true, text: '打开 IM.codes', nextLastNonEmptyText: '打开 IM.codes' });

    // Isolated single-hotword interim MUST be held back (emit: false) so legacy clients without
    // hotwords and end-only sessions never receive or resurrect it on echo/empty final or end.
    const p1 = resolveSessionTranscriptResult('IM.codes', false, '', ['IM.codes']);
    expect(p1).toEqual({ emit: false, text: '', nextLastNonEmptyText: '' });
    const p2EchoFinal = resolveSessionTranscriptResult('IM.codes，IM.codes。', true, p1.nextLastNonEmptyText, ['IM.codes']);
    expect(p2EchoFinal).toEqual({ emit: true, text: '', nextLastNonEmptyText: '' });
    const p2EmptyFinal = resolveSessionTranscriptResult('', true, p1.nextLastNonEmptyText, ['IM.codes']);
    expect(p2EmptyFinal).toEqual({ emit: true, text: '', nextLastNonEmptyText: '' });

    // Feed new relay frames through legacy baseline resolver (without hotwords): never resurrects "IM.codes"
    for (const seq of [
      [{ text: 'IM.codes', isFinal: false }, { text: 'IM.codes，IM.codes。', isFinal: true }],
      [{ text: 'IM.codes', isFinal: false }, { text: '', isFinal: true }],
      [{ text: 'IM.codes', isFinal: false }, { text: 'IM.codes，IM.codes。', isFinal: false }],
    ]) {
      let relayLast = '';
      let legacyLast = '';
      const relayFrames: Array<{ text: string; isFinal: boolean }> = [];
      const legacyOutputs: Array<{ text: string; isFinal: boolean }> = [];
      for (const f of seq) {
        const relayed = resolveSessionTranscriptResult(f.text, f.isFinal, relayLast, ['IM.codes']);
        relayLast = relayed.nextLastNonEmptyText;
        if (relayed.emit) relayFrames.push({ text: relayed.text, isFinal: f.isFinal });
      }
      for (const rf of relayFrames) {
        const consumed = resolveSessionTranscriptResult(rf.text, rf.isFinal, legacyLast);
        legacyLast = consumed.nextLastNonEmptyText;
        if (consumed.emit) legacyOutputs.push({ text: consumed.text, isFinal: rf.isFinal });
      }
      expect(legacyOutputs.every((o) => o.text === '')).toBe(true);
    }

    // Explicit audible single-hotword final still emits cleanly on both relay and legacy client
    const pSingleFinal = resolveSessionTranscriptResult('IM.codes', true, '', ['IM.codes']);
    expect(pSingleFinal).toEqual({ emit: true, text: 'IM.codes', nextLastNonEmptyText: '' });
    expect(resolveSessionTranscriptResult(pSingleFinal.text, true, '')).toEqual({
      emit: true,
      text: 'IM.codes',
      nextLastNonEmptyText: 'IM.codes',
    });

    // Baseline without hotwords keeps caching normal non-empty interims across empty final
    const b1 = resolveSessionTranscriptResult('IM.codes', false, '');
    expect(b1).toEqual({ emit: true, text: 'IM.codes', nextLastNonEmptyText: 'IM.codes' });
    expect(resolveSessionTranscriptResult('', true, b1.nextLastNonEmptyText)).toEqual({
      emit: true,
      text: 'IM.codes',
      nextLastNonEmptyText: 'IM.codes',
    });
  });
});
