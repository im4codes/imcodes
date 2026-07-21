import { describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import { sanitizeTimelineHistoryEventsForTransport } from '../../src/daemon/timeline-history-sanitize.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  SDK_SUBAGENT_DIAGNOSTIC,
} from '../../shared/sdk-subagent-status.js';

function event(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    eventId: 'evt',
    sessionId: 'deck_hist',
    ts: 1,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'tool.result',
    payload: {},
    ...overrides,
  };
}

describe('timeline history transport sanitization', () => {
  it('filters already-persisted Claude synthetic seed assistant text from history payloads', () => {
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'synthetic-seed',
        type: 'assistant.text',
        payload: { text: 'No response requested.', streaming: false },
      }),
      event({
        eventId: 'real-response',
        type: 'assistant.text',
        ts: 2,
        seq: 2,
        payload: { text: 'real response', streaming: false },
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventId).toBe('real-response');
    expect(result.events[0]?.payload.text).toBe('real response');
  });

  it('preserves full chat text and streaming typewriter updates in history payloads', () => {
    const userText = `user:${'u'.repeat(80 * 1024)}`;
    const streamingText = `typing:${'t'.repeat(80 * 1024)}`;
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'user-long-text',
        type: 'user.message',
        payload: { text: userText },
      }),
      event({
        eventId: 'assistant-streaming-long-text',
        type: 'assistant.text',
        ts: 2,
        seq: 2,
        payload: { text: streamingText, streaming: true },
      }),
    ], {
      maxResponseBytes: 256 * 1024,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.payload.text).toBe(userText);
    expect(result.events[1]?.payload.text).toBe(streamingText);
    expect(JSON.stringify(result.events)).not.toContain('history truncated');
    expect(result.truncatedEvents).toBe(0);
    expect(result.detailRefs).toEqual([]);
  });

  it('caps large tool payloads before history responses leave the daemon', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'tool-big',
        payload: {
          output: huge,
          detail: {
            output: huge,
            raw: {
              aggregatedOutput: huge,
              nested: { output: huge },
            },
          },
        },
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.truncatedEvents).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.events[0]), 'utf8')).toBeLessThan(40 * 1024);
    expect(JSON.stringify(result.events[0])).toContain('history truncated');
  });

  it('adds opaque detail refs for omitted large renderable fields', () => {
    const refs: unknown[] = [];
    const huge = 'x'.repeat(32 * 1024);
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'tool-detail-ref',
        payload: {
          output: huge,
          detail: {
            output: huge,
          },
        },
      }),
    ], {
      detailSink: {
        put: (input) => {
          refs.push(input);
          return {
            detailId: 'opaque-detail-1',
            eventId: input.eventId,
            fieldPath: input.fieldPath,
            previewBytes: input.previewBytes,
            expiresAt: 123,
          };
        },
      },
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sessionName: 'deck_hist',
      eventId: 'tool-detail-ref',
      fieldPath: 'payload.output',
    });
    expect(result.detailRefs).toEqual([expect.objectContaining({
      detailId: 'opaque-detail-1',
      eventId: 'tool-detail-ref',
      fieldPath: 'payload.output',
    })]);
  });

  it('deduplicates duplicated provider payload detail refs without storing the same full value twice', () => {
    const refs: Array<{ eventId: string; fieldPath: string; value: string }> = [];
    const duplicatedProviderText = `provider-result:${'p'.repeat(64 * 1024)}`;
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'tool-duplicated-provider-payload',
        payload: {
          output: duplicatedProviderText,
          detail: {
            output: duplicatedProviderText,
          },
        },
      }),
    ], {
      detailSink: {
        put: (input) => {
          refs.push({ eventId: input.eventId, fieldPath: input.fieldPath, value: input.value });
          return {
            detailId: `td_${refs.length}`,
            eventId: input.eventId,
            fieldPath: input.fieldPath,
            previewBytes: input.previewBytes,
            expiresAt: 123,
          };
        },
      },
    });

    expect(result.events).toHaveLength(1);
    expect(result.detailRefs).toHaveLength(1);
    expect(refs).toEqual([{
      eventId: 'tool-duplicated-provider-payload',
      fieldPath: 'payload.output',
      value: duplicatedProviderText,
    }]);
  });

  it('collects detail refs from the safe projection for SDK sub-agent events', () => {
    const refs: Array<{ fieldPath: string; value: string }> = [];
    const hugeRawOutput = `sdk-sensitive:${'s'.repeat(64 * 1024)}`;
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'sdk-safe-ref-source',
        type: 'tool.result',
        hidden: true,
        payload: {
          output: hugeRawOutput,
          detail: {
            kind: SDK_SUBAGENT_DETAIL_KIND,
            summary: 'SDK failed',
            raw: { prompt: hugeRawOutput },
            meta: {
              isSdkSubagent: true,
              schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
              provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
              providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
              canonicalKey: 'claude:deck_hist:task-safe-ref',
              normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
              active: false,
              terminal: true,
              taskId: 'task-safe-ref',
            },
          },
        },
      }),
    ], {
      detailSink: {
        put: (input) => {
          refs.push({ fieldPath: input.fieldPath, value: input.value });
          return {
            detailId: `td_${refs.length}`,
            eventId: input.eventId,
            fieldPath: input.fieldPath,
            previewBytes: input.previewBytes,
            expiresAt: 123,
          };
        },
      },
    });

    expect(result.events).toHaveLength(1);
    expect(result.detailRefs).toEqual([]);
    expect(refs).toEqual([]);
    expect(JSON.stringify(result.events[0])).not.toContain(hugeRawOutput);
    expect(JSON.stringify(result.events[0])).not.toContain('sdk-sensitive');
  });

  it('uses timeline order, not input order, when folding duplicate stable SDK event ids', () => {
    const newest = event({
      eventId: 'transport-tool:deck_hist:sdk-task:call',
      type: 'tool.call',
      ts: 10,
      seq: 10,
      hidden: true,
      payload: {
        tool: 'Agent',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: 'Newest progress',
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:deck_hist:task-order',
            normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
            active: true,
            terminal: false,
            taskId: 'task-order',
          },
        },
      },
    });
    const older = event({
      ...newest,
      ts: 1,
      seq: 1,
      payload: {
        tool: 'Agent',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: 'Older progress',
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:deck_hist:task-order',
            normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
            active: true,
            terminal: false,
            taskId: 'task-order',
          },
        },
      },
    });

    const result = sanitizeTimelineHistoryEventsForTransport([newest, older]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.payload.detail).toMatchObject({
      summary: 'Newest progress',
      meta: { canonicalKey: 'claude:deck_hist:task-order' },
    });
  });

  it('preserves token occupancy when newer metadata shares the usage event id', () => {
    const eventId = 'transport:deck_hist:msg-opencode:usage';
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId,
        type: 'usage.update',
        ts: 10,
        seq: 8,
        payload: {
          inputTokens: 22,
          cacheTokens: 36_608,
          outputTokens: 10,
          model: 'opencode/deepseek-v4-flash-free',
          contextWindow: 200_000,
          contextWindowSource: 'provider',
          streaming: false,
        },
      }),
      event({
        eventId,
        type: 'usage.update',
        ts: 10,
        seq: 14,
        payload: {
          model: 'opencode/deepseek-v4-flash-free',
          contextWindow: 1_000_000,
        },
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      seq: 14,
      payload: {
        inputTokens: 22,
        cacheTokens: 36_608,
        outputTokens: 10,
        model: 'opencode/deepseek-v4-flash-free',
        contextWindow: 1_000_000,
      },
    });
    expect(result.events[0]?.payload).not.toHaveProperty('contextWindowSource');
  });

  it('bounds diagnostic SDK raw payloads before history transport', () => {
    const wideRaw: Record<string, string | string[]> = {
      messages: ['secret child prompt'],
    };
    for (let index = 0; index < 32; index += 1) {
      wideRaw[`visible_${index}`] = 'x'.repeat(64 * 1024);
    }
    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'sdk-diagnostic-raw-budget',
        type: 'tool.result',
        hidden: true,
        payload: {
          detail: {
            kind: SDK_SUBAGENT_DETAIL_KIND,
            summary: 'Malformed payload',
            raw: wideRaw,
            meta: {
              isSdkSubagent: true,
              schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
              provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
              providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
              canonicalKey: 'claude:deck_hist:diagnostic',
              normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
              active: false,
              terminal: true,
              diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
            },
          },
        },
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(result.events[0]), 'utf8')).toBeLessThan(8 * 1024);
    expect(JSON.stringify(result.events[0])).not.toContain('secret child prompt');
    expect(result.events[0]?.payload.detail).toMatchObject({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      raw: {
        truncated: true,
        originalBytesBucket: expect.any(String),
      },
    });
  });

  it('bounds extremely wide synthetic objects without allocating a full transport payload', () => {
    const wideRaw: Record<string, unknown> = {};
    for (let index = 0; index < 2_000; index += 1) {
      wideRaw[`wide_${index}`] = `value-${index}`;
    }

    const result = sanitizeTimelineHistoryEventsForTransport([
      event({
        eventId: 'tool-wide-object',
        payload: {
          tool: 'synthetic-wide',
          output: 'short visible output',
          detail: {
            raw: wideRaw,
          },
        },
      }),
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.truncatedEvents).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.events[0]), 'utf8')).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_EVENT);
    const raw = (result.events[0]?.payload.detail as { raw?: Record<string, unknown> } | undefined)?.raw;
    expect(Object.keys(raw ?? {})).toHaveLength(32);
  });

  it('keeps the newest events when the history batch exceeds the response budget', () => {
    const events = Array.from({ length: 30 }, (_, index) => event({
      eventId: `assistant-${index}`,
      type: 'assistant.text',
      ts: index,
      seq: index,
      payload: { text: `${index}: ${'y'.repeat(20 * 1024)}`, streaming: false },
    }));

    const result = sanitizeTimelineHistoryEventsForTransport(events, {
      maxResponseBytes: 96 * 1024,
    });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.length).toBeLessThan(events.length);
    expect(result.droppedEvents).toBeGreaterThan(0);
    expect(result.events.at(-1)?.eventId).toBe('assistant-29');
  });

  it('does not register detail refs for events dropped by the response budget', () => {
    const registered: Array<{ eventId: string; fieldPath: string }> = [];
    const events = Array.from({ length: 120 }, (_, index) => event({
      eventId: `tool-${index}`,
      ts: index,
      seq: index,
      payload: { output: `${index}:${'x'.repeat(32 * 1024)}` },
    }));

    const result = sanitizeTimelineHistoryEventsForTransport(events, {
      maxResponseBytes: 64 * 1024,
      detailSink: {
        put: (input) => {
          registered.push({ eventId: input.eventId, fieldPath: input.fieldPath });
          return {
            detailId: `td_${input.eventId}`,
            eventId: input.eventId,
            fieldPath: input.fieldPath,
            previewBytes: input.previewBytes,
            expiresAt: 123,
          };
        },
      },
    });
    const selectedIds = new Set(result.events.map((entry) => entry.eventId));

    expect(result.droppedEvents).toBeGreaterThan(0);
    expect(selectedIds.has('tool-119')).toBe(true);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.every((ref) => selectedIds.has(ref.eventId))).toBe(true);
    expect(registered).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'tool-0' }),
    ]));
  });

  it('does not call raw toJSON hooks while shaping large timeline payloads', () => {
    const payloadToJson = vi.fn(() => {
      throw new Error('raw payload stringify should not run');
    });
    const eventToJson = vi.fn(() => {
      throw new Error('raw event stringify should not run');
    });
    const rawEvent = Object.assign(event({
      eventId: 'tool-to-json',
      payload: {
        output: 'z'.repeat(2 * 1024 * 1024),
        toJSON: payloadToJson,
      } as Record<string, unknown>,
    }), { toJSON: eventToJson });

    const result = sanitizeTimelineHistoryEventsForTransport([rawEvent], {
      maxResponseBytes: 128 * 1024,
    });

    expect(result.events).toHaveLength(1);
    expect(result.truncatedEvents).toBeGreaterThan(0);
    expect(payloadToJson).not.toHaveBeenCalled();
    expect(eventToJson).not.toHaveBeenCalled();
  });

  it('deduplicates stable event ids and strips normal SDK sub-agent raw fields for history', () => {
    const oldProgress = event({
      eventId: 'transport-tool:deck_hist:sdk-task:call',
      type: 'tool.call',
      ts: 1,
      seq: 1,
      hidden: true,
      payload: {
        tool: 'Agent',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: 'Old progress',
          raw: { prompt: 'SECRET_OLD_PROMPT' },
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:deck_hist:task-1',
            normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
            active: true,
            terminal: false,
            taskId: 'task-1',
            description: 'SECRET_DESCRIPTION',
          },
        },
      },
    });
    const latestProgress = event({
      ...oldProgress,
      ts: 2,
      seq: 2,
      payload: {
        tool: 'Agent',
        detail: {
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: 'Latest progress',
          raw: { prompt: 'SECRET_LATEST_PROMPT' },
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
            canonicalKey: 'claude:deck_hist:task-1',
            normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
            active: true,
            terminal: false,
            taskId: 'task-1',
            description: 'SECRET_DESCRIPTION',
          },
        },
      },
    });

    const result = sanitizeTimelineHistoryEventsForTransport([oldProgress, latestProgress]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.payload.detail).toMatchObject({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: 'Latest progress',
      meta: {
        canonicalKey: 'claude:deck_hist:task-1',
        normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
        active: true,
        terminal: false,
        taskId: 'task-1',
      },
    });
    expect(JSON.stringify(result.events[0])).not.toContain('SECRET');
    expect(JSON.stringify(result.events[0])).not.toContain('raw');
    expect(JSON.stringify(result.events[0])).not.toContain('description');
  });
});
