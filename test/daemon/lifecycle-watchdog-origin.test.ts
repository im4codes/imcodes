/**
 * The Codex stale-turn watchdog sends `continue` on the session's behalf. That
 * row is the daemon's, not the human's: it must carry the system origin so the
 * chat renders it on the left (shared/chat-message-origin.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    readByTypesPreferred: vi.fn(),
    append: vi.fn(),
    cleanup: vi.fn(),
    truncateAll: vi.fn(),
    readPreferred: vi.fn(),
  },
}));
vi.mock('../../src/context/summary-compressor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/context/summary-compressor.js')>()),
  getStaleSessionCompressionRun: () => ({ runId: 'run-origin-1', trigger: 'test', eventCount: 1, startedAt: 0 }),
  resolveSessionCompressionWatchRuns: () => undefined,
}));
vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agent/session-manager.js')>()),
  getTransportRuntime: () => runtimeRef.current,
}));

const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { recoverCodexStalledSession, recoverMemoryCompressionStalledSession } = await import('../../src/daemon/lifecycle.js');
const { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS, classifyUserMessageOrigin } = await import('../../shared/chat-message-origin.js');

const SESSION = 'deck_watchdogorigin_brain';

afterEach(() => {
  vi.restoreAllMocks();
  runtimeRef.current = undefined;
  timelineEmitter.forgetSession(SESSION);
});

function activeRuntime(send: ReturnType<typeof vi.fn>) {
  return {
    send,
    cancel: vi.fn(async () => undefined),
    getDiagnosticSnapshot: () => ({
      sending: true,
      activeDispatchCount: 1,
      blockingWorkCount: 0,
      status: 'streaming',
      activeToolCount: 0,
      lastActivityAgeMs: 13 * 60_000,
      activityGeneration: 'gen-origin-1',
      pendingVersion: 1,
    }),
  };
}

function expectSystemContinue(emit: { mock: { calls: unknown[][] } }, send: ReturnType<typeof vi.fn>) {
  const row = emit.mock.calls.find(([session, type]) => session === SESSION && type === 'user.message');
  const payload = row?.[2] as Record<string, unknown>;
  expect(payload).toMatchObject({ text: 'continue', [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM });
  expect(classifyUserMessageOrigin(payload)).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
  expect(send).toHaveBeenCalledWith('continue', expect.any(String), undefined, undefined,
    expect.objectContaining({ messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM }));
}

describe('watchdog continue origin', () => {
  it('stamps the memory-compression watchdog continue as a system message', async () => {
    const send = vi.fn(() => 'sent' as const);
    runtimeRef.current = activeRuntime(send);
    const emit = vi.spyOn(timelineEmitter, 'emit');
    expect(await recoverMemoryCompressionStalledSession(SESSION, 7 * 60_000)).toBe(true);
    expectSystemContinue(emit, send);
  });

  it('stamps the Codex stale-turn continue as a system message on the row and the queued copy', async () => {
    const send = vi.fn(() => 'sent' as const);
    runtimeRef.current = {
      send,
      cancel: vi.fn(async () => undefined),
      getDiagnosticSnapshot: () => ({
        sending: true,
        activeDispatchCount: 1,
        blockingWorkCount: 0,
        status: 'streaming',
        activeToolCount: 0,
        lastActivityAgeMs: 13 * 60_000,
        activityGeneration: 'gen-origin-1',
        pendingVersion: 1,
      }),
    };
    const emit = vi.spyOn(timelineEmitter, 'emit');

    expect(await recoverCodexStalledSession({ name: SESSION, agentType: 'codex-sdk' })).toBe(true);

    const row = emit.mock.calls.find(([session, type]) => session === SESSION && type === 'user.message');
    const payload = row?.[2] as Record<string, unknown>;
    expect(payload).toMatchObject({ text: 'continue', [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM });
    expect(classifyUserMessageOrigin(payload)).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
    expect(send).toHaveBeenCalledWith('continue', expect.any(String), undefined, undefined,
      expect.objectContaining({ messageOrigin: CHAT_MESSAGE_ORIGINS.SYSTEM }));
  });
});
