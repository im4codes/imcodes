import { describe, expect, it } from 'vitest';
import {
  USAGE_ANALYTICS_SCHEMA_VERSION,
  USAGE_UNSAFE_FIELD_NAMES,
  createCanonicalUsagePayloadHash,
  createEmptyUsageSummaryResponse,
  normalizeCostUsdMicros,
  usageDateUtcFromCreatedAtMs,
  validateUsageFactInput,
  validateUsageIngestEnvelopeInput,
  type UsageFact,
} from '../shared/usage-analytics.js';

const baseFact: UsageFact = {
  usageFactId: 'usage_1',
  createdAtMs: Date.UTC(2026, 6, 9, 23, 59, 59),
  sessionName: 'deck_app_brain',
  sessionKind: 'main',
  parentSessionName: null,
  metadataCompleteness: 'complete',
  provider: 'openai',
  agentType: 'codex-sdk',
  model: 'gpt-5',
  inputTokens: 10,
  cacheTokens: 2,
  outputTokens: 7,
  totalTokens: 19,
  contextWindow: 200_000,
  costUsdMicros: 1234,
  sourceEventId: 'evt_1',
};

describe('shared usage analytics contracts', () => {
  it('rejects body and fact attribution fields as authority', () => {
    const envelope = validateUsageIngestEnvelopeInput({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      userId: 'attacker',
      serverId: 'wrong-server',
      facts: [
        {
          ...baseFact,
          account: 'other-account',
          userId: 'other-user',
          serverId: 'body-server',
        },
      ],
    });

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.issues).toEqual(
        expect.arrayContaining([
          { field: 'userId', reason: 'attribution_forbidden' },
          { field: 'serverId', reason: 'attribution_forbidden' },
          { field: 'facts.0.account', reason: 'attribution_forbidden' },
          { field: 'facts.0.userId', reason: 'attribution_forbidden' },
          { field: 'facts.0.serverId', reason: 'attribution_forbidden' },
        ]),
      );
    }
  });

  it('normalizes token totals, date buckets, and cost micros', () => {
    const parsed = validateUsageFactInput({
      ...baseFact,
      totalTokens: undefined,
      costUsdMicros: null,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.totalTokens).toBe(19);
      expect(parsed.value.costUsdMicros).toBeNull();
      expect(usageDateUtcFromCreatedAtMs(parsed.value.createdAtMs)).toBe('2026-07-09');
    }

    const micros = validateUsageFactInput(baseFact);
    expect(micros.ok).toBe(true);
    if (micros.ok) {
      expect(micros.value.costUsdMicros).toBe(1234);
    }

    expect(normalizeCostUsdMicros(0.0000015)).toBe(2);
    expect(normalizeCostUsdMicros(-0.0000015)).toBe(-2);
    expect(() => validateUsageFactInput({ ...baseFact, inputTokens: 1.5 })).not.toThrow();
    const bad = validateUsageFactInput({ ...baseFact, inputTokens: 1.5 });
    expect(bad.ok).toBe(false);
  });

  it('excludes rejected private fields from hashes and reports no unsafe values', () => {
    const safeHash = createCanonicalUsagePayloadHash(baseFact);
    const withPrivateOnlyChange = validateUsageFactInput({
      ...baseFact,
      promptText: 'private prompt A',
      rawProviderPayload: { secret: 'private payload B' },
    });

    expect(withPrivateOnlyChange.ok).toBe(false);
    if (!withPrivateOnlyChange.ok) {
      expect(JSON.stringify(withPrivateOnlyChange.issues)).not.toContain('private prompt A');
      expect(JSON.stringify(withPrivateOnlyChange.issues)).not.toContain('private payload B');
      expect(withPrivateOnlyChange.issues).toEqual(
        expect.arrayContaining([
          { field: 'promptText', reason: 'unsafe' },
          { field: 'rawProviderPayload', reason: 'unsafe' },
        ]),
      );
    }

    expect(createCanonicalUsagePayloadHash({ ...baseFact })).toBe(safeHash);
    expect(createCanonicalUsagePayloadHash({ ...baseFact, outputTokens: 8, totalTokens: 20 })).not.toBe(safeHash);
  });

  it('returns a stable empty summary response shape', () => {
    const response = createEmptyUsageSummaryResponse({ serverId: 'server_1', order: 'desc' }, 123);

    expect(response.accountTotal).toMatchObject({
      factCount: 0,
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsdMicros: null,
      costCompleteness: 'unknown',
    });
    expect(response.byDate).toEqual([]);
    expect(response.byServer).toEqual([]);
    expect(response.byProviderModel).toEqual([]);
    expect(response.byMainSession).toEqual([]);
    expect(response.bySubSession).toEqual([]);
    expect(response.byParentSession).toEqual([]);
    expect(response.bySessionModelDate).toEqual([]);
    expect(response.meta).toEqual({
      from: null,
      to: null,
      generatedAtMs: 123,
      filters: { serverId: 'server_1', order: 'desc' },
      primaryBucket: 'byServer',
      partialBuckets: [],
      appliedLimits: {},
    });
  });

  it('rejects every privacy sentinel field without echoing sentinel values', () => {
    for (const field of USAGE_UNSAFE_FIELD_NAMES) {
      const sentinel = `private-${field}-value`;
      const parsed = validateUsageFactInput({
        ...baseFact,
        [field]: sentinel,
      });
      expect(parsed.ok, `${field} should be rejected`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues).toEqual(expect.arrayContaining([{ field, reason: 'unsafe' }]));
        expect(JSON.stringify(parsed.issues)).not.toContain(sentinel);
      }
    }
  });
});
