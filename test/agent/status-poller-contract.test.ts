import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusPoller } from '../../src/agent/status-poller.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const capturePaneMock = vi.fn();
const detectStatusMultiMock = vi.fn();
const getDriverMock = vi.fn();
const timelineEmitMock = vi.fn();
const loggerDebugMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock('../../src/agent/tmux.js', () => ({
  capturePane: (...args: unknown[]) => capturePaneMock(...args),
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatusMulti: (...args: unknown[]) => detectStatusMultiMock(...args),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getDriver: (...args: unknown[]) => getDriverMock(...args),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: (...args: unknown[]) => timelineEmitMock(...args),
  },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    debug: (...args: unknown[]) => loggerDebugMock(...args),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: (...args: unknown[]) => loggerErrorMock(...args),
  },
}));

function session(name = 'deck_alpha_brain'): SessionRecord {
  return {
    name,
    projectName: 'alpha',
    projectRole: 'brain',
    agentType: 'claude-code',
    projectDir: '/repo',
    state: 'running',
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
}

async function poll(poller: StatusPoller): Promise<void> {
  await (poller as unknown as { pollSessions: () => Promise<void> }).pollSessions();
}

describe('StatusPoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturePaneMock.mockResolvedValue(['prompt']);
    detectStatusMultiMock.mockResolvedValue('working');
    getDriverMock.mockReturnValue({ isOverlay: vi.fn(() => false) });
  });

  it('fires idle callbacks only on idle transitions and emits thinking transitions', async () => {
    const poller = new StatusPoller({ pollIntervalMs: 10 });
    const idle = vi.fn(async () => undefined);
    poller.addSession(session());
    poller.onIdle(idle);

    detectStatusMultiMock.mockResolvedValueOnce('working');
    await poll(poller);
    expect(idle).not.toHaveBeenCalled();

    detectStatusMultiMock.mockResolvedValueOnce('idle');
    await poll(poller);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(loggerDebugMock).toHaveBeenCalledWith({ session: 'deck_alpha_brain' }, 'Polling detected idle');

    detectStatusMultiMock.mockResolvedValueOnce('idle');
    await poll(poller);
    expect(idle).toHaveBeenCalledTimes(1);

    detectStatusMultiMock.mockResolvedValueOnce('thinking');
    await poll(poller);
    expect(timelineEmitMock).toHaveBeenCalledWith(
      'deck_alpha_brain',
      'assistant.thinking',
      { text: '' },
      { source: 'terminal-parse', confidence: 'medium' },
    );

    poller.removeSession('deck_alpha_brain');
    detectStatusMultiMock.mockResolvedValueOnce('idle');
    await poll(poller);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('logs overlay detections and polling errors', async () => {
    const poller = new StatusPoller({ pollIntervalMs: 10 });
    poller.addSession(session('deck_alpha_worker'));

    getDriverMock.mockReturnValueOnce({ isOverlay: vi.fn(() => true) });
    detectStatusMultiMock.mockResolvedValueOnce('working');
    await poll(poller);
    expect(loggerDebugMock).toHaveBeenCalledWith({ session: 'deck_alpha_worker' }, 'Overlay detected');

    capturePaneMock.mockRejectedValueOnce(new Error('tmux gone'));
    await poll(poller);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { session: 'deck_alpha_worker', err: expect.any(Error) },
      'Status poll error',
    );
  });

  it('logs idle callback errors without breaking polling', async () => {
    const poller = new StatusPoller({ pollIntervalMs: 10 });
    poller.addSession(session('deck_alpha_worker'));

    const failingIdle = vi.fn(async () => {
      throw new Error('callback failed');
    });
    poller.onIdle(failingIdle);
    await (poller as unknown as { triggerIdle: (record: SessionRecord) => Promise<void> })
      .triggerIdle(session('deck_alpha_worker'));
    expect(failingIdle).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      { session: 'deck_alpha_worker', err: expect.any(Error) },
      'Idle callback error',
    );
  });

  it('starts and stops its interval timer', () => {
    vi.useFakeTimers();
    try {
      const poller = new StatusPoller({ pollIntervalMs: 25 });
      poller.start();
      vi.advanceTimersByTime(25);
      expect(capturePaneMock).toHaveBeenCalledTimes(0);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
