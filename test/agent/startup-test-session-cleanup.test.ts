import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getPaneCwdMock,
  killSessionMock,
  listSessionsMock,
  loggerInfoMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  getPaneCwdMock: vi.fn(),
  killSessionMock: vi.fn(),
  listSessionsMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  getPaneCwd: getPaneCwdMock,
  killSession: killSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
  },
}));

describe('startup test-session cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('kills leaked test sessions by explicit name pattern and by test cwd heuristic', async () => {
    listSessionsMock.mockResolvedValue([
      'deck_modeawaree2eabc123_brain',
      'deck_storecheckabc123_brain',
      'deck_ccsdk_ab12cd_brain',
      'deck_realproj_brain',
    ]);
    getPaneCwdMock.mockImplementation(async (sessionName: string) => {
      if (sessionName === 'deck_ccsdk_ab12cd_brain') return '/tmp/ccsdk-main-e2e';
      if (sessionName === 'deck_realproj_brain') return '/Users/me/src/realproj';
      return '/tmp';
    });
    killSessionMock.mockResolvedValue(undefined);

    const { cleanupKnownTestTerminalSessions } = await import('../../src/agent/startup-test-session-cleanup.js');
    const killed = await cleanupKnownTestTerminalSessions();

    expect(killed).toEqual([
      'deck_modeawaree2eabc123_brain',
      'deck_storecheckabc123_brain',
      'deck_ccsdk_ab12cd_brain',
    ]);
    expect(killSessionMock).toHaveBeenCalledTimes(3);
    expect(killSessionMock).toHaveBeenCalledWith('deck_modeawaree2eabc123_brain');
    expect(killSessionMock).toHaveBeenCalledWith('deck_storecheckabc123_brain');
    expect(killSessionMock).toHaveBeenCalledWith('deck_ccsdk_ab12cd_brain');
    expect(killSessionMock).not.toHaveBeenCalledWith('deck_realproj_brain');
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ count: 3 }),
      'Cleaned leaked test terminal sessions on startup',
    );
  });
});
