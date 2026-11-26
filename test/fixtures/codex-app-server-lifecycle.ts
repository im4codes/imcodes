import type { TimelineActivityEvent } from '../../shared/session-activity-types.js';

export const CODEX_APP_SERVER_SCHEMA_BASELINE_NOTE =
  'Generated Codex app-server schema is not available from the deployed CLI in local CI; these fixtures are the maintained app-server lifecycle baseline.';

export const codexAppServerLifecycleReplay = [
  { source: 'app_server_jsonrpc', method: 'thread/resume', params: { threadId: 'thread-fixture' } },
  { source: 'app_server_jsonrpc', method: 'turn/start', params: { threadId: 'thread-fixture' } },
  { source: 'app_server_jsonrpc', method: 'item/started', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'ws-fixture', type: 'webSearch' } } },
  { source: 'app_server_jsonrpc', method: 'item/started', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'cmd-fixture', type: 'commandExecution' } } },
  { source: 'app_server_jsonrpc', method: 'item/completed', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'cmd-fixture', type: 'commandExecution', status: 'completed' } } },
  { source: 'app_server_jsonrpc', method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } } },
] as const;

export const codexLifecycleProjectionEvents: TimelineActivityEvent[] = [
  {
    type: 'session.state',
    payload: {
      state: 'running',
      activityGeneration: { scope: 'session', sessionName: 'deck_fixture', generation: 1 },
    },
  },
  {
    type: 'tool.call',
    payload: {
      toolCallId: 'ws-fixture',
      tool: 'WebSearch',
      activityGeneration: { scope: 'session', sessionName: 'deck_fixture', generation: 1 },
    },
  },
  {
    type: 'tool.result',
    payload: {
      toolCallId: 'ws-fixture',
      terminalStatus: 'succeeded',
      terminalReason: 'app_server_completed',
      synthetic: true,
      source: 'app_server_jsonrpc',
      decisionReason: 'app_server_completed',
      idempotencyKey: 'codex-terminal:deck_fixture:session:deck_fixture:1:tool:ws-fixture:succeeded:app_server_completed',
      activityGeneration: { scope: 'session', sessionName: 'deck_fixture', generation: 1 },
      turnId: 'turn-fixture',
      itemKind: 'web_search',
    },
  },
  {
    type: 'session.state',
    payload: {
      state: 'idle',
      authoritative: true,
      activityGeneration: { scope: 'session', sessionName: 'deck_fixture', generation: 1 },
      blockingWorkCount: 0,
      activeWorkCount: 0,
      activeToolCount: 0,
      pendingCount: 0,
      pendingVersion: 1,
      decisionReason: 'activity_reconciler_clear',
      clearInputs: [{ source: 'transport-runtime', reason: 'clear', count: 0 }],
    },
  },
];
