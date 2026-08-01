import { describe, expect, it } from 'vitest';
import { formatToolDuration, truncateToolLabel } from '../src/util/tool-duration.js';

describe('formatToolDuration', () => {
  it('keeps sub-second detail, so a fast tool does not read as 0s', () => {
    expect(formatToolDuration(0)).toBe('0.0s');
    expect(formatToolDuration(412)).toBe('0.4s');
    expect(formatToolDuration(9_849)).toBe('9.8s');
  });

  it('drops the decimal once it stops being informative', () => {
    expect(formatToolDuration(10_000)).toBe('10s');
    expect(formatToolDuration(59_999)).toBe('59s');
  });

  it('switches to m/s and pads so the width stays stable while ticking', () => {
    expect(formatToolDuration(60_000)).toBe('1m00s');
    expect(formatToolDuration(65_000)).toBe('1m05s');
    expect(formatToolDuration(3_599_000)).toBe('59m59s');
  });

  it('switches to h/m for genuinely long tools', () => {
    expect(formatToolDuration(3_600_000)).toBe('1h00m');
    expect(formatToolDuration(3_600_000 + 5 * 60_000)).toBe('1h05m');
  });

  it('clamps a negative duration instead of rendering it', () => {
    // Clock skew or a rehydrated event can put the start in the future.
    expect(formatToolDuration(-5_000)).toBe('0.0s');
  });
});

describe('truncateToolLabel', () => {
  it('leaves a label that already fits', () => {
    expect(truncateToolLabel('Bash npm test', 44)).toBe('Bash npm test');
  });

  it('marks a cut label so it does not read as the whole command', () => {
    expect(truncateToolLabel('abcdefghij', 5)).toBe('abcde…');
  });

  it('never splits a surrogate pair at the cut', () => {
    const cut = truncateToolLabel('😀'.repeat(10), 3);
    expect([...cut].filter((c) => c === '😀')).toHaveLength(3);
    const lone = [...cut].filter((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= 0xD800 && cp <= 0xDFFF;
    });
    expect(lone).toEqual([]);
  });

  it('counts by code point, not UTF-16 unit, so CJK is not cut early', () => {
    expect(truncateToolLabel('搜索关键词测试', 4)).toBe('搜索关键…');
  });
});
