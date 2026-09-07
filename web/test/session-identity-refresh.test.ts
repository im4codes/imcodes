import { describe, expect, it, vi } from 'vitest';
import { MSG_COMMAND_ACK } from '../../shared/ack-protocol.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { requestSessionIdentityRefresh } from '../src/session-identity-refresh.js';

function fakeWs() {
  const handlers = new Set<(message: any) => void>();
  return {
    send: vi.fn(),
    onMessage: vi.fn((handler: (message: any) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    emit(message: any) {
      handlers.forEach((handler) => handler(message));
    },
  };
}

describe('session identity runtime refresh acknowledgement', () => {
  it('waits for the exact daemon acknowledgement and ignores unrelated acks', async () => {
    const ws = fakeWs();
    let settled = false;
    const refresh = requestSessionIdentityRefresh(ws as never, 'deck_proj_brain', 1_000)
      .then(() => { settled = true; });
    const command = ws.send.mock.calls[0]?.[0];

    expect(command).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
      sessionName: 'deck_proj_brain',
      commandId: expect.any(String),
    });
    ws.emit({ type: MSG_COMMAND_ACK, commandId: 'other', session: 'deck_proj_brain', status: 'ok' });
    await Promise.resolve();
    expect(settled).toBe(false);

    ws.emit({ type: MSG_COMMAND_ACK, commandId: command.commandId, session: 'deck_proj_brain', status: 'ok' });
    await refresh;
    expect(settled).toBe(true);
  });

  it('rejects when the daemon reports that applying the identity failed', async () => {
    const ws = fakeWs();
    const refresh = requestSessionIdentityRefresh(ws as never, 'deck_proj_brain', 1_000);
    const command = ws.send.mock.calls[0]?.[0];
    ws.emit({
      type: MSG_COMMAND_ACK,
      commandId: command.commandId,
      session: 'deck_proj_brain',
      status: 'error',
      error: 'profile fetch failed',
    });
    await expect(refresh).rejects.toThrow('profile fetch failed');
  });
});
