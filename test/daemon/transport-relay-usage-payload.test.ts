import { describe, expect, it } from 'vitest';
import { __testing__ } from '../../src/daemon/transport-relay.js';

const { normalizeUsageUpdatePayload } = __testing__;

/**
 * Regression for round-2 audit finding A3 (discussion 0699ea64-3e6).
 *
 * `normalizeUsageUpdatePayload` was silently dropping `output_tokens` from
 * the upstream `ProviderUsageUpdate.usage`, so every transport-SDK turn
 * landed in `context_turn_usage` with `output_tokens=0`. That broke the
 * commit's promise of "记录 SDK token 消耗" for the entire SDK family
 * (codex-sdk, claude-code-sdk via onComplete metadata, cursor-headless,
 * and any future SDK that goes through transport-relay).
 *
 * The fix maps `usage.output_tokens` → `payload.outputTokens`. This test
 * pins:
 *   - presence: outputTokens propagates when set
 *   - absence: undefined output_tokens → field omitted (NOT zero)
 *   - bounds: negative values rejected (defensive vs malformed providers)
 */

describe('normalizeUsageUpdatePayload — outputTokens propagation', () => {
  it('maps usage.output_tokens through to payload.outputTokens', () => {
    const payload = normalizeUsageUpdatePayload(
      'deck_test',
      {
        input_tokens: 1500,
        output_tokens: 320,
        cache_read_input_tokens: 500,
      },
      'gpt-5-codex',
    );
    expect(payload).toBeDefined();
    expect(payload!.outputTokens).toBe(320);
    expect(payload!.inputTokens).toBe(1500);
    expect(payload!.cacheTokens).toBe(500);
  });

  it('omits outputTokens when upstream usage has no output_tokens', () => {
    const payload = normalizeUsageUpdatePayload(
      'deck_test',
      { input_tokens: 100 },
      'm',
    );
    expect(payload).toBeDefined();
    // Critical: must be absent, not zero — analytics queries must distinguish
    // "0 known output" from "unknown output", and downstream recordTurnUsage
    // skip-when-empty logic relies on field absence.
    expect('outputTokens' in payload!).toBe(false);
  });

  it('rejects negative output_tokens (malformed provider)', () => {
    const payload = normalizeUsageUpdatePayload(
      'deck_test',
      { input_tokens: 100, output_tokens: -1 as number },
      'm',
    );
    expect(payload).toBeDefined();
    expect('outputTokens' in payload!).toBe(false);
  });

  it('preserves all existing fields alongside new outputTokens', () => {
    const payload = normalizeUsageUpdatePayload(
      'deck_test',
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        model_context_window: 128_000,
      },
      'claude-sonnet-4-5',
    );
    expect(payload).toMatchObject({
      inputTokens: 1000,
      cacheTokens: 200,
      outputTokens: 500,
      model: 'claude-sonnet-4-5',
      contextWindow: 128_000,
    });
  });

  it('handles zero output_tokens explicitly (turn produced no text)', () => {
    // Edge case: a provider may legitimately report output_tokens=0 for an
    // immediate-cancel or refusal turn. We MUST persist that as 0, not omit,
    // so the analytics row reflects "we actually got back 0 output tokens"
    // vs "we don't know".
    const payload = normalizeUsageUpdatePayload(
      'deck_test',
      { input_tokens: 50, output_tokens: 0 },
      'm',
    );
    expect(payload).toBeDefined();
    expect(payload!.outputTokens).toBe(0);
  });
});
