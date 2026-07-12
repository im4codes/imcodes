import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { encodeEnrollmentBlob, parseEnrollmentBlob } from '../../src/node/enrollment.js';
import { createControlledNodeRuntime } from '../../src/node/runtime.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';

class MockSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  open(): void { this.readyState = 1; this.emit('open'); }
}

describe('controlled node enrollment and runtime', () => {
  it('round-trips an enrollment blob appended to arbitrary executable bytes', () => {
    const encoded = encodeEnrollmentBlob({ serverUrl: 'https://im.example/', enrollToken: 'once-123' });
    expect(parseEnrollmentBlob(Buffer.concat([Buffer.from('binary-prefix'), encoded]))).toEqual({
      serverUrl: 'https://im.example',
      enrollToken: 'once-123',
    });
    expect(parseEnrollmentBlob(Buffer.from('no marker'))).toBeNull();
    expect(parseEnrollmentBlob(Buffer.concat([encoded, Buffer.from('trailing-garbage')]))).toBeNull();
  });

  it('authenticates, executes only machine.exec, and returns a correlated result', async () => {
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket);
    runtime.start();
    socket.open();
    const authFrame = JSON.parse(socket.sent[0]!);
    expect(authFrame).toMatchObject({ type: 'auth', serverId: 'controlled-1' });
    // The node MUST NOT declare its own node_role as an authority claim.
    expect(authFrame.nodeRole).toBeUndefined();

    socket.emit('message', JSON.stringify({ type: 'session.send', correlationId: 'ignored', command: 'echo nope' }));
    socket.emit('message', JSON.stringify({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, correlationId: 'exec-1', idempotencyKey: 'exec-1', command: 'printf ok', shell: 'sh' }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: DAEMON_MSG.MACHINE_EXEC_RESULT,
      correlationId: 'exec-1',
      ok: true,
      exitCode: 0,
      stdout: 'ok',
    });
    runtime.stop();
  });
});
