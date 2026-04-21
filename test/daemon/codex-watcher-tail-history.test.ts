import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: mocks.emit,
  },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/daemon/memory-inject.js', () => ({
  buildSessionBootstrapContext: vi.fn(async () => ''),
  buildCodexMemoryEntry: vi.fn(() => ''),
  readProcessedMemoryItems: vi.fn(async () => []),
}));

vi.mock('../../src/context/shared-context-flags.js', () => ({
  legacyInjectionDisabled: vi.fn(() => true),
}));

vi.mock('../../src/daemon/memory-context-timeline.js', () => ({
  buildMemoryContextTimelinePayload: vi.fn(() => null),
}));

vi.mock('../../src/store/session-store.js', () => ({
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/util/model-context.js', () => ({
  resolveContextWindow: vi.fn(() => 200000),
}));

vi.mock('../../src/daemon/watcher-controls.js', () => ({
  registerWatcherControl: vi.fn(),
  unregisterWatcherControl: vi.fn(),
}));

describe('codex-watcher tail history replay', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T12:00:00Z'));
    mocks.emit.mockClear();
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-codex-tail-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(async () => {
    const { stopWatching, resetParseStateForTests } = await import('../../src/daemon/codex-watcher.js');
    stopWatching('codex-tail-session');
    resetParseStateForTests();
    vi.useRealTimers();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('replays the tail of oversized rollout history instead of the head', async () => {
    const sessionDir = join(tempHome, '.codex', 'sessions', '2026', '04', '21');
    mkdirSync(sessionDir, { recursive: true });
    const projectDir = join(tempHome, 'project');
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(sessionDir, 'rollout-2026-04-21T12-00-00-12345678-1234-1234-1234-123456789abc.jsonl');

    const largePayload = 'x'.repeat(2048);
    const lines = [
      JSON.stringify({
        timestamp: '2026-04-21T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '12345678-1234-1234-1234-123456789abc',
          cwd: projectDir,
          cli_version: '0.118.0',
          source: 'cli',
          model_provider: 'openai',
        },
      }),
      ...Array.from({ length: 700 }, (_, index) => JSON.stringify({
        timestamp: `2026-04-21T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `tail-message-${index}:${largePayload}`,
          images: [],
          local_images: [],
        },
      })),
    ];
    writeFileSync(rolloutPath, lines.join('\n') + '\n', 'utf8');

    const { startWatching, stopWatching } = await import('../../src/daemon/codex-watcher.js');
    await startWatching('codex-tail-session', projectDir);

    await vi.waitFor(() => {
      expect(mocks.emit.mock.calls.length).toBeGreaterThan(0);
    });

    const payloads = mocks.emit.mock.calls
      .filter((call) => call[1] === 'user.message')
      .map((call) => String((call[2] as { text?: unknown }).text ?? ''));

    expect(payloads.some((text) => text.startsWith('tail-message-699:'))).toBe(true);
    expect(payloads.some((text) => text.startsWith('tail-message-0:'))).toBe(false);

    stopWatching('codex-tail-session');
  });
});
