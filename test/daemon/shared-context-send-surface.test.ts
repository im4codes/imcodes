import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

const {
  getSessionMock,
  listSessionsMock,
  getTransportRuntimeMock,
  detectStatusAsyncMock,
  timelineEmitMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listSessionsMock: vi.fn(() => []),
  getTransportRuntimeMock: vi.fn(),
  detectStatusAsyncMock: vi.fn(),
  timelineEmitMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  listSessions: listSessionsMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: getTransportRuntimeMock,
  sessionName: vi.fn((project: string, role: string) => `deck_${project}_${role}`),
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatus: vi.fn(() => 'idle'),
  detectStatusAsync: detectStatusAsyncMock,
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
  capturePane: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: vi.fn(() => vi.fn()),
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestSnapshot: vi.fn(),
    invalidateSize: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: timelineEmitMock,
    on: vi.fn(() => () => {}),
    off: vi.fn(),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: vi.fn(),
  stopSubSession: vi.fn(),
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn(),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: vi.fn(),
  cancelP2pRun: vi.fn(),
  getP2pRun: vi.fn(() => undefined),
  listP2pRuns: vi.fn(() => []),
  serializeP2pRun: vi.fn(),
}));

vi.mock('../../src/daemon/repo-handler.js', () => ({
  handleRepoCommand: vi.fn(),
}));

vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));

vi.mock('../../src/daemon/preview-relay.js', () => ({
  handlePreviewCommand: vi.fn(),
}));

vi.mock('../../src/daemon/provider-sessions.js', () => ({
  listProviderSessions: vi.fn(() => []),
}));

vi.mock('../../src/daemon/watcher-controls.js', () => ({
  refreshSessionWatcher: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { executeCronJob } from '../../src/daemon/cron-executor.js';
import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';
import { CRON_MSG, type CronDispatchMessage } from '../../shared/cron-types.js';

function postSend(port: number, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(data)),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(responseBody),
      }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function makeSession(overrides: Record<string, unknown>) {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'claude-code',
    runtimeType: 'process',
    projectDir: '/proj',
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeCronMessage(command: string): CronDispatchMessage {
  return {
    type: CRON_MSG.DISPATCH,
    jobId: 'job-1',
    jobName: 'shared-context-parity',
    serverId: 'srv-1',
    projectName: 'myapp',
    targetRole: 'brain',
    action: { type: 'command', command },
  };
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('shared-context send-surface parity integration', () => {
  let server: http.Server;
  let port: number;
  let runtime: { providerSessionId: string; pendingCount: number; send: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    runtime = {
      providerSessionId: 'provider-session',
      pendingCount: 0,
      send: vi.fn(() => 'sent'),
      getStatus: vi.fn(() => 'idle'),
    };
    getTransportRuntimeMock.mockReturnValue(runtime);
    detectStatusAsyncMock.mockResolvedValue('idle');
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_transport_brain') return makeSession({ name: 'deck_transport_brain', runtimeType: 'transport', agentType: 'codex-sdk' });
      if (name === 'deck_proj_brain') return makeSession({ name: 'deck_proj_brain' });
      if (name === 'deck_proj_w1') return makeSession({ name: 'deck_proj_w1', role: 'w1', runtimeType: 'transport', agentType: 'openclaw' });
      if (name === 'deck_myapp_brain') return makeSession({ name: 'deck_myapp_brain', projectName: 'myapp', runtimeType: 'transport', projectDir: '/myapp' });
      return null;
    });
    listSessionsMock.mockReturnValue([
      makeSession({ name: 'deck_proj_brain' }),
      makeSession({ name: 'deck_proj_w1', role: 'w1', runtimeType: 'transport', agentType: 'openclaw' }),
    ]);
    const started = await startHookServer(vi.fn());
    server = started.server;
    port = started.port;
  });

  afterEach(() => {
    server.close();
  });

  it('routes interactive, hook/CLI, and cron transport sends through the same raw-message runtime boundary', async () => {
    const command = 'use the normalized shared context contract';

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: command,
      commandId: 'cmd-1',
    }, {
      send: vi.fn(),
      sendBinary: vi.fn(),
      sendTimelineEvent: vi.fn(),
      daemonVersion: '0.1.0',
    } as never);
    await flushAsync();

    const hookResponse = await postSend(port, {
      from: 'deck_proj_brain',
      to: 'deck_proj_w1',
      message: command,
    });
    expect(hookResponse.status).toBe(200);
    expect(hookResponse.body.ok).toBe(true);

    await executeCronJob(makeCronMessage(command), {
      send: vi.fn(),
      sendTimelineEvent: vi.fn(),
      daemonVersion: '0.1.0',
    } as never);

    expect(runtime.send).toHaveBeenCalledTimes(3);
    expect(runtime.send.mock.calls.map((call: unknown[]) => call[0])).toEqual([command, command, command]);
    expect(runtime.send.mock.calls.every((call: unknown[]) => typeof call[0] === 'string')).toBe(true);
  });
});
