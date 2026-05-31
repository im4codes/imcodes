import { describe, expect, it } from 'vitest';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  SDK_SUBAGENT_REDACTED_VALUE,
  SDK_SUBAGENT_SAFE_RAW_MAX_TOTAL_BYTES,
  buildSdkSubagentSafeDetail,
  buildSdkSubagentMinimalReplayDetail,
  isSdkSubagentDetail,
  normalizeSdkSubagentCanonicalKey,
  parseSdkSubagentDetail,
  sdkSubagentDedupSignature,
  type SdkSubagentDetail,
} from '../../shared/sdk-subagent-status.js';

function makeDetail(overrides: Partial<SdkSubagentDetail> = {}): SdkSubagentDetail {
  return {
    kind: SDK_SUBAGENT_DETAIL_KIND,
    summary: 'Safe summary',
    meta: {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
      canonicalKey: 'claude:deck:task-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      taskId: 'task-1',
    },
    ...overrides,
  };
}

describe('sdk-subagent-status shared contract', () => {
  it('rejects malformed enum values instead of accepting any string', () => {
    const detail = makeDetail({
      meta: {
        ...makeDetail().meta,
        provider: 'future-provider' as never,
      },
    });

    expect(isSdkSubagentDetail(detail)).toBe(false);
    expect(parseSdkSubagentDetail(detail)).toEqual({ kind: 'malformed-sdk', reason: 'provider' });
  });

  it('sanitizes safe details by stripping prompt-like fields and normal raw payloads', () => {
    const detail = makeDetail({
      summary: 'Safe summary',
      input: { action: 'diagnostic', description: 'SECRET child prompt' },
      output: 'done sk-1234567890abcdef',
      raw: {
        childPrompt: 'SECRET child prompt',
        nested: { authorization: 'Bearer abcdefghijklmnop' },
      },
      meta: {
        ...makeDetail().meta,
        description: 'SECRET prompt',
        error: 'token leaked',
        childStatusSummary: 'running:1',
      },
    });

    const safe = buildSdkSubagentSafeDetail(detail);

    expect(safe.raw).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(JSON.stringify(safe)).not.toContain('token leaked');
    expect(safe.input).toEqual({ action: 'diagnostic' });
    expect(safe.meta.childStatusSummary).toBe('running:1');
  });

  it('allows redacted diagnostic raw payloads when explicitly requested', () => {
    const safe = buildSdkSubagentSafeDetail(makeDetail({
      meta: {
        ...makeDetail().meta,
        normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
        active: false,
        terminal: true,
        diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
      },
      raw: {
        messages: ['secret'],
        publicField: 'visible',
      },
    }), { allowRaw: true });

    expect(safe.raw).toMatchObject({
      messages: SDK_SUBAGENT_REDACTED_VALUE,
      publicField: 'visible',
    });
  });

  it('bounds diagnostic raw payloads with a global byte budget', () => {
    const wideRaw: Record<string, string> = {};
    for (let index = 0; index < 32; index += 1) {
      wideRaw[`field_${index}`] = 'x'.repeat(SDK_SUBAGENT_SAFE_RAW_MAX_TOTAL_BYTES);
    }
    const safe = buildSdkSubagentSafeDetail(makeDetail({
      meta: {
        ...makeDetail().meta,
        normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
        active: false,
        terminal: true,
        diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
      },
      raw: wideRaw,
    }), { allowRaw: true });

    expect(safe.raw).toEqual({
      truncated: true,
      originalBytesBucket: expect.any(String),
    });
    expect(JSON.stringify(safe.raw).length).toBeLessThan(256);
  });

  it('normalizes and bounds canonical keys and child counts during parsing', () => {
    const parsed = parseSdkSubagentDetail(makeDetail({
      input: { action: 'fan out', receiverCount: 10_000 },
      meta: {
        ...makeDetail().meta,
        canonicalKey: `claude:${'session with spaces/'.repeat(20)}:${'task'.repeat(80)}`,
        receiverCount: 10_000,
        runningChildCount: 9_999,
        receiverIndex: 1_234,
      },
    }));

    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.detail.meta.canonicalKey).toBe(normalizeSdkSubagentCanonicalKey(parsed.detail.meta.canonicalKey));
    expect(parsed.detail.meta.canonicalKey.length).toBeLessThanOrEqual(192);
    expect(parsed.detail.input?.receiverCount).toBe(999);
    expect(parsed.detail.meta.receiverCount).toBe(999);
    expect(parsed.detail.meta.runningChildCount).toBe(999);
    expect(parsed.detail.meta.receiverIndex).toBe(999);
  });

  it('builds minimal replay detail with only flat SDK status metadata', () => {
    const minimal = buildSdkSubagentMinimalReplayDetail(makeDetail({
      raw: { prompt: 'SECRET_PROMPT' },
      input: { action: 'start', description: 'SECRET_PROMPT' },
      output: 'large output',
      meta: {
        ...makeDetail().meta,
        parentToolUseId: 'tool-1',
        receiverCount: 3,
        runningChildCount: 2,
        childStatusSummary: 'running:2 completed:1',
      },
    }));

    expect(minimal).toEqual({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: 'Safe summary',
      meta: expect.objectContaining({
        canonicalKey: 'claude:deck:task-1',
        normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
        receiverCount: 3,
        runningChildCount: 2,
        childStatusSummary: 'running:2 completed:1',
      }),
    });
    expect(JSON.stringify(minimal)).not.toContain('SECRET_PROMPT');
    expect(JSON.stringify(minimal)).not.toContain('parentToolUseId');
    expect(JSON.stringify(minimal)).not.toContain('large output');
  });

  it('excludes raw-only changes from SDK sub-agent dedup signatures', () => {
    const base = makeDetail({
      raw: { uuid: 'one' },
      meta: { ...makeDetail().meta, diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE },
    });
    const changedRaw = makeDetail({
      raw: { uuid: 'two' },
      meta: { ...makeDetail().meta, diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE },
    });

    expect(sdkSubagentDedupSignature({ name: 'Agent', status: 'running', detail: base }))
      .toBe(sdkSubagentDedupSignature({ name: 'Agent', status: 'running', detail: changedRaw }));
  });
});
