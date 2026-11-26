import { describe, expect, it } from 'vitest';
import { sanitizeAsrRepetitionLoop } from '../../shared/remote-voice.js';

describe('sanitizeAsrRepetitionLoop', () => {
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
