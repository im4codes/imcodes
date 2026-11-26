import { describe, expect, it } from 'vitest';
import { sanitizeAsrRepetitionLoop, stripAsrControlTags } from '../../shared/remote-voice.js';

describe('stripAsrControlTags', () => {
  it('strips Qwen3-ASR language control prefixes and special tags without altering normal words', () => {
    expect(stripAsrControlTags('language None<asr_text>')).toBe('');
    expect(stripAsrControlTags('language Chinese<asr_text>第一段检查。')).toBe('第一段检查。');
    expect(stripAsrControlTags('language English<asr_text>Hello world')).toBe('Hello world');
    expect(stripAsrControlTags('Whiskey 五百五十。 language None<asr_text>十五x ray')).toBe(
      'Whiskey 五百五十。 十五x ray',
    );
    expect(stripAsrControlTags('第一句。language None<asr_text>第二句')).toBe('第一句。第二句');
    expect(stripAsrControlTags('<|endoftext|>hello<asr_text><|zh|>')).toBe('hello');
    expect(stripAsrControlTags('the language model is fast')).toBe('the language model is fast');
    expect(stripAsrControlTags('language None is just words')).toBe('language None is just words');
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

    const start = performance.now();
    const result = sanitizeAsrRepetitionLoop(uniqueLongText);
    const elapsedMs = performance.now() - start;

    expect(result).toBe(uniqueLongText);
    expect(elapsedMs).toBeLessThan(20); // typ. <1ms even on loaded CI runners
  });
});
