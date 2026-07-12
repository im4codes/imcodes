import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ACK_FAILURE_ACK_TIMEOUT,
  ACK_FAILURE_DAEMON_ERROR,
  ACK_FAILURE_DAEMON_OFFLINE,
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
  MSG_DAEMON_OFFLINE,
  MSG_DAEMON_ONLINE,
  type AckFailureReason,
  type CommandFailedMessage,
  type DaemonOfflineMessage,
  type DaemonOnlineMessage,
} from '../../shared/ack-protocol.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  MEMORY_MANAGEMENT_REQUEST_TYPES,
  MEMORY_MANAGEMENT_RESPONSE_TYPES,
  MEMORY_WS,
  isMemoryManagementRequestType,
  isMemoryManagementResponseType,
} from '../../shared/memory-ws.js';

describe('shared daemon/server/web wire protocol contracts', () => {
  it('pins ack reliability message names and failure reasons', () => {
    expect([
      MSG_COMMAND_ACK,
      MSG_COMMAND_FAILED,
      MSG_DAEMON_ONLINE,
      MSG_DAEMON_OFFLINE,
    ]).toEqual([
      'command.ack',
      'command.failed',
      'daemon.online',
      'daemon.offline',
    ]);

    expect([
      ACK_FAILURE_DAEMON_OFFLINE,
      ACK_FAILURE_ACK_TIMEOUT,
      ACK_FAILURE_DAEMON_ERROR,
    ] satisfies AckFailureReason[]).toEqual([
      'daemon_offline',
      'ack_timeout',
      'daemon_error',
    ]);
  });

  it('pins ack reliability payload shapes shared by server and web', () => {
    expectTypeOf<CommandFailedMessage>().toEqualTypeOf<{
      type: typeof MSG_COMMAND_FAILED;
      commandId: string;
      session: string;
      reason: AckFailureReason;
      retryable: boolean;
    }>();
    expectTypeOf<DaemonOnlineMessage>().toEqualTypeOf<{
      type: typeof MSG_DAEMON_ONLINE;
    }>();
    expectTypeOf<DaemonOfflineMessage>().toEqualTypeOf<{
      type: typeof MSG_DAEMON_OFFLINE;
    }>();
  });

  it('pins daemon lifecycle event and browser command vocabularies', () => {
    expect(DAEMON_MSG).toEqual({
      RECONNECTED: 'daemon.reconnected',
      DISCONNECTED: 'daemon.disconnected',
      UPGRADE_BLOCKED: 'daemon.upgrade_blocked',
      UPGRADING: 'daemon.upgrading',
      MACHINE_EXEC_RESULT: 'machine.exec_result',
    });

    expect(DAEMON_COMMAND_TYPES).toEqual({
      DAEMON_UPGRADE: 'daemon.upgrade',
      SERVER_DELETE: 'server.delete',
      SESSION_CANCEL: 'session.cancel',
      SESSION_EXECUTION_CLONES: 'session.execution_clones',
      SESSION_UPDATE_TRANSPORT_CONFIG: 'session.update_transport_config',
      SUBSESSION_UPDATE_TRANSPORT_CONFIG: 'subsession.update_transport_config',
      MACHINE_EXEC: 'machine.exec',
    });
  });

  it('keeps memory management request and response types explicitly paired', () => {
    const requestToResponse = [
      [MEMORY_WS.SEARCH, MEMORY_WS.SEARCH_RESPONSE],
      [MEMORY_WS.ARCHIVE, MEMORY_WS.ARCHIVE_RESPONSE],
      [MEMORY_WS.RESTORE, MEMORY_WS.RESTORE_RESPONSE],
      [MEMORY_WS.CREATE, MEMORY_WS.CREATE_RESPONSE],
      [MEMORY_WS.UPDATE, MEMORY_WS.UPDATE_RESPONSE],
      [MEMORY_WS.PIN, MEMORY_WS.PIN_RESPONSE],
      [MEMORY_WS.DELETE, MEMORY_WS.DELETE_RESPONSE],
      [MEMORY_WS.PERSONAL_QUERY, MEMORY_WS.PERSONAL_RESPONSE],
      [MEMORY_WS.PROJECT_RESOLVE, MEMORY_WS.PROJECT_RESOLVE_RESPONSE],
      [MEMORY_WS.FEATURES_QUERY, MEMORY_WS.FEATURES_RESPONSE],
      [MEMORY_WS.FEATURES_SET, MEMORY_WS.FEATURES_SET_RESPONSE],
      [MEMORY_WS.PREF_QUERY, MEMORY_WS.PREF_RESPONSE],
      [MEMORY_WS.PREF_CREATE, MEMORY_WS.PREF_CREATE_RESPONSE],
      [MEMORY_WS.PREF_UPDATE, MEMORY_WS.PREF_UPDATE_RESPONSE],
      [MEMORY_WS.PREF_DELETE, MEMORY_WS.PREF_DELETE_RESPONSE],
      [MEMORY_WS.SKILL_QUERY, MEMORY_WS.SKILL_RESPONSE],
      [MEMORY_WS.SKILL_REBUILD, MEMORY_WS.SKILL_REBUILD_RESPONSE],
      [MEMORY_WS.SKILL_READ, MEMORY_WS.SKILL_READ_RESPONSE],
      [MEMORY_WS.SKILL_DELETE, MEMORY_WS.SKILL_DELETE_RESPONSE],
      [MEMORY_WS.MD_INGEST_RUN, MEMORY_WS.MD_INGEST_RUN_RESPONSE],
      [MEMORY_WS.OBSERVATION_QUERY, MEMORY_WS.OBSERVATION_RESPONSE],
      [MEMORY_WS.OBSERVATION_UPDATE, MEMORY_WS.OBSERVATION_UPDATE_RESPONSE],
      [MEMORY_WS.OBSERVATION_DELETE, MEMORY_WS.OBSERVATION_DELETE_RESPONSE],
      [MEMORY_WS.OBSERVATION_PROMOTE, MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE],
      [MEMORY_WS.MCP_STATUS_QUERY, MEMORY_WS.MCP_STATUS_RESPONSE],
    ] as const;

    expect(MEMORY_MANAGEMENT_REQUEST_TYPES).toEqual(requestToResponse.map(([request]) => request));
    expect(new Set(MEMORY_MANAGEMENT_RESPONSE_TYPES)).toEqual(
      new Set(requestToResponse.map(([, response]) => response)),
    );

    for (const [request, response] of requestToResponse) {
      expect(isMemoryManagementRequestType(request)).toBe(true);
      expect(isMemoryManagementResponseType(response)).toBe(true);
      expect(isMemoryManagementResponseType(request)).toBe(false);
      expect(isMemoryManagementRequestType(response)).toBe(false);
    }
  });
});
