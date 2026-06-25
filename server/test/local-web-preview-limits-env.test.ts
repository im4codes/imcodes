import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-N1 — env-overridable preview timers / per-user cap.
 *
 * Three previously-hardcoded `PREVIEW_LIMITS` constants are now env-overridable
 * via the same `previewLimitFromEnv(name, default)` pattern used by the
 * `PREVIEW_MAX_INFLIGHT_*` ceilings:
 *   - STREAM_IDLE_TIMEOUT_MS                       ← PREVIEW_STREAM_IDLE_TIMEOUT_MS      (default 120000)
 *   - RESPONSE_START_TIMEOUT_MS                    ← PREVIEW_RESPONSE_START_TIMEOUT_MS   (default 30000)
 *   - MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER      ← PREVIEW_MAX_ACTIVE_PER_USER_PER_SERVER (default 8)
 *
 * The override is read at MODULE-EVAL time (inside `previewLimitFromEnv`), so a
 * static `import` would be hoisted and capture the compiled-in default BEFORE
 * any env stub. Mirroring `local-web-preview-inflight.test.ts`, each case must
 * `vi.stubEnv(...)` → `vi.resetModules()` (done in beforeEach) → then
 * DYNAMICALLY `await import('../../shared/preview-types.js')` so the fresh
 * module evaluation observes the stubbed env.
 *
 * T-N1.3 note: proving these SMALL-threshold overrides take effect is exactly
 * what lets the timing tests (V-stream-idle / V-response-start) drive a stream
 * to its idle/response-start deadline in milliseconds instead of waiting the
 * real 120s / 30s. Those timing tests are NOT re-implemented here — this file
 * only verifies the override mechanism (small value wins, default otherwise,
 * invalid value falls back), which is the seam they depend on.
 */

describe('T-N1: env-overridable preview limits (timers + per-user/server cap)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── T-N1.2: env override takes effect with a SMALL threshold ───────────────
  it('STREAM_IDLE_TIMEOUT_MS honors a small PREVIEW_STREAM_IDLE_TIMEOUT_MS override', async () => {
    vi.stubEnv('PREVIEW_STREAM_IDLE_TIMEOUT_MS', '5000');
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS).toBe(5000);
  });

  it('RESPONSE_START_TIMEOUT_MS honors a small PREVIEW_RESPONSE_START_TIMEOUT_MS override', async () => {
    vi.stubEnv('PREVIEW_RESPONSE_START_TIMEOUT_MS', '5000');
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS).toBe(5000);
  });

  it('MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER honors a small PREVIEW_MAX_ACTIVE_PER_USER_PER_SERVER override', async () => {
    vi.stubEnv('PREVIEW_MAX_ACTIVE_PER_USER_PER_SERVER', '2');
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER).toBe(2);
  });

  // ── No env stub → each constant equals its documented compiled-in default ──
  it('falls back to the documented defaults when no env override is set', async () => {
    // No vi.stubEnv here — beforeEach reset modules so this is a clean eval.
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS).toBe(30_000);
    expect(PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER).toBe(8);
  });

  // ── Invalid env → default (previewLimitFromEnv: only finite >0 integers win) ─
  // Covers each non-finite/non-positive/empty form the parser must reject.
  it.each([
    ['abc', 'non-numeric'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['', 'empty string'],
  ])('STREAM_IDLE_TIMEOUT_MS ignores invalid value %j (%s) and uses the default', async (bad) => {
    vi.stubEnv('PREVIEW_STREAM_IDLE_TIMEOUT_MS', bad);
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
  });

  it.each([
    ['abc', 'non-numeric'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['', 'empty string'],
  ])('RESPONSE_START_TIMEOUT_MS ignores invalid value %j (%s) and uses the default', async (bad) => {
    vi.stubEnv('PREVIEW_RESPONSE_START_TIMEOUT_MS', bad);
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS).toBe(30_000);
  });

  it.each([
    ['abc', 'non-numeric'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['', 'empty string'],
  ])('MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER ignores invalid value %j (%s) and uses the default', async (bad) => {
    vi.stubEnv('PREVIEW_MAX_ACTIVE_PER_USER_PER_SERVER', bad);
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER).toBe(8);
  });
});
