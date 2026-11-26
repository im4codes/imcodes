import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocketServer } from 'ws';
import { createServerWebSocketServer } from '../src/index.js';
import {
  MACHINE_EXEC_RESULT_MAX_WIRE_BYTES,
  SERVER_WS_MAX_PAYLOAD_BYTES,
} from '../src/ws/bridge.js';
import { FS_WRITE_OUTBOUND_WS_MAX_BYTES } from '../../shared/fs-write-limits.js';

describe('server WebSocket payload ceiling', () => {
  let wss: WebSocketServer | undefined;

  afterEach(() => {
    wss?.close();
    wss = undefined;
  });

  it('uses the bounded production maxPayload while retaining existing data-plane headroom', () => {
    wss = createServerWebSocketServer();
    expect(wss.options.maxPayload).toBe(SERVER_WS_MAX_PAYLOAD_BYTES);
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(FS_WRITE_OUTBOUND_WS_MAX_BYTES);
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(MACHINE_EXEC_RESULT_MAX_WIRE_BYTES);
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeLessThan(100 * 1024 * 1024);
  });
});
