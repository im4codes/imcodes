import { describe, expect, it } from 'vitest';
import { formatToolDuration } from '../src/util/tool-duration.js';

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
