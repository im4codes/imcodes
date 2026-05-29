import { describe, expect, it } from 'vitest';

import { computeFollowThresholds } from '../src/components/chat-follow-thresholds.js';

describe('computeFollowThresholds', () => {
  it('uses the adaptive base thresholds when content is much taller than the viewport', () => {
    // Long chat: maxScroll (9600) is huge, so the short-content guard never
    // fires and the viewport-scaled base values apply unchanged.
    const ch = 1080;
    const { disengageThreshold, reengageThreshold } = computeFollowThresholds(ch, ch + 9600);
    expect(disengageThreshold).toBe(Math.max(180, Math.round(0.25 * ch))); // 270
    expect(reengageThreshold).toBe(Math.max(60, Math.round(0.10 * ch))); // 108
    expect(disengageThreshold).toBeGreaterThan(reengageThreshold);
  });

  it('keeps the floor of 180 / 60 for a normal pane with plenty of scroll', () => {
    const { disengageThreshold, reengageThreshold } = computeFollowThresholds(600, 600 + 2000);
    expect(disengageThreshold).toBe(180);
    expect(reengageThreshold).toBe(60);
  });

  // ── Regression: the reported bug ────────────────────────────────────────────
  // At certain window heights the content only slightly exceeds the viewport, so
  // the whole scrollable range is SMALLER than the fixed 180px disengage
  // threshold. Pre-fix, the user could never scroll up far enough to pause
  // follow-mode, so every reflow/stream tick snapped them back to the bottom.
  it('caps the disengage threshold below the scrollable range when content barely overflows', () => {
    const clientHeight = 400;
    const scrollHeight = 520; // maxScroll = 120, < 180 base disengage
    const maxScroll = scrollHeight - clientHeight;
    const { disengageThreshold, reengageThreshold } = computeFollowThresholds(clientHeight, scrollHeight);

    // The whole point: disengage must be REACHABLE — strictly less than the
    // maximum scrollable distance — or follow-mode can never be paused.
    expect(disengageThreshold).toBeLessThan(maxScroll);
    expect(disengageThreshold).toBe(60); // round(0.5 * 120)
    expect(reengageThreshold).toBe(24); // round(0.2 * 120)
    // Hysteresis band preserved.
    expect(disengageThreshold).toBeGreaterThan(reengageThreshold);
  });

  it('INVARIANT: across many short-content heights, follow-mode is always escapable', () => {
    for (let clientHeight = 200; clientHeight <= 1000; clientHeight += 50) {
      // Sweep the dangerous band: content from +10px to +400px over the viewport.
      for (let extra = 10; extra <= 400; extra += 10) {
        const scrollHeight = clientHeight + extra;
        const maxScroll = extra;
        const { disengageThreshold, reengageThreshold } = computeFollowThresholds(clientHeight, scrollHeight);
        // Escapable: a user CAN scroll up far enough to cross the disengage line.
        expect(disengageThreshold).toBeLessThanOrEqual(maxScroll);
        // Hysteresis intact: re-engage strictly closer to the bottom than disengage.
        expect(reengageThreshold).toBeLessThan(disengageThreshold);
        expect(reengageThreshold).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('does not crash or cap when content exactly fits (maxScroll = 0)', () => {
    const { disengageThreshold, reengageThreshold } = computeFollowThresholds(500, 500);
    // No scroll range -> guard is a no-op; base values returned (and unused,
    // since nothing can scroll).
    expect(disengageThreshold).toBe(180);
    expect(reengageThreshold).toBe(60);
  });
});
