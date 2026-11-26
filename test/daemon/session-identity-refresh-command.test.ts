import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';

const { syncForCommandMock } = vi.hoisted(() => ({
  syncForCommandMock: vi.fn(),
}));

vi.mock('../../src/daemon/session-identity-sync.js', () => ({
  syncSessionIdentitiesForCommand: syncForCommandMock,
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

describe('session.identity.refresh web command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the matching command ack only after runtime convergence resolves', async () => {
    let finish!: (value: {
      commandId: string; sessionName: string; status: 'ok';
    }) => void;
    syncForCommandMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const serverLink = { send: vi.fn() };
    const command = {
      type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
      sessionName: 'deck_proj_brain',
      commandId: 'identity-refresh-1',
    };

    handleWebCommand(command, serverLink as never);
    expect(serverLink.send).not.toHaveBeenCalled();
    finish({ commandId: command.commandId, sessionName: command.sessionName, status: 'ok' });

    await vi.waitFor(() => expect(serverLink.send).toHaveBeenCalledWith({
      type: MSG_COMMAND_ACK,
      commandId: command.commandId,
      session: command.sessionName,
      status: 'ok',
    }));
  });
});
