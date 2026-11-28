import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_AVAILABILITY_MSG } from '../../shared/agent-availability.js';

const {
  startProjectMock,
  launchTransportSessionMock,
  detectInstalledAgentsMock,
} = vi.hoisted(() => ({
  startProjectMock: vi.fn(),
  launchTransportSessionMock: vi.fn(),
  detectInstalledAgentsMock: vi.fn(async () => ({ 'agy-sdk': { installed: true }, codex: { installed: false } })),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: startProjectMock,
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: launchTransportSessionMock,
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn(),
}));

vi.mock('../../src/agent/agent-availability.js', () => ({
  detectInstalledAgents: detectInstalledAgentsMock,
  detectInstalledAgentsWithMetadata: vi.fn(async (opts?: { forceRefresh?: boolean }) => ({
    agents: await detectInstalledAgentsMock(opts),
    epoch: 1,
    checkedAt: Date.now(),
  })),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn(), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));
vi.mock('../../src/daemon/git-remote-clone.js', () => ({
  maybeCloneGitRemoteToDirectory: vi.fn(async ({ targetDir }: { targetDir: string }) => targetDir),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

describe('command-handler session.start directory creation & session.detect_agents', () => {
  let tempRoot: string;

  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'imcodes-start-dir-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates missing nested working directory on session.start without gitRemoteUrl', async () => {
    const targetDir = join(tempRoot, '.imcodes', 'projects', 'my_app');

    handleWebCommand({
      type: 'session.start',
      project: 'my-app',
      dir: targetDir,
      agentType: 'claude-code',
    }, serverLink as any);

    await vi.waitFor(async () => {
      const dirInfo = await stat(targetDir);
      expect(dirInfo.isDirectory()).toBe(true);
      expect(startProjectMock).toHaveBeenCalledWith(expect.objectContaining({
        name: 'my_app',
        dir: targetDir,
      }));
    }, { timeout: 3_000, interval: 10 });
  });

  it('does not pre-create targetDir when gitRemoteUrl is present', async () => {
    const targetDir = join(tempRoot, 'cloned-app');

    handleWebCommand({
      type: 'session.start',
      project: 'cloned-app',
      dir: targetDir,
      agentType: 'claude-code',
      gitRemoteUrl: 'https://github.com/acme/cloned-app.git',
    }, serverLink as any);

    await vi.waitFor(() => {
      expect(startProjectMock).toHaveBeenCalledWith(expect.objectContaining({
        dir: targetDir,
      }));
    }, { timeout: 3_000, interval: 10 });

    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('emits session.error cleanly when requested working directory points to a regular file', async () => {
    const filePath = join(tempRoot, 'regular-file');
    await writeFile(filePath, 'not a dir', 'utf8');

    handleWebCommand({
      type: 'session.start',
      project: 'file-proj',
      dir: filePath,
      agentType: 'claude-code',
    }, serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'session.error',
        project: 'file_proj',
      }));
    }, { timeout: 3_000, interval: 10 });

    expect(startProjectMock).not.toHaveBeenCalled();
    expect(launchTransportSessionMock).not.toHaveBeenCalled();
  });

  it('handles session.detect_agents and emits session.agents_availability', async () => {
    handleWebCommand({
      type: AGENT_AVAILABILITY_MSG.DETECT,
      forceRefresh: true,
    }, serverLink as any);

    await vi.waitFor(() => {
      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: AGENT_AVAILABILITY_MSG.RESULT,
        agents: { 'agy-sdk': { installed: true }, codex: { installed: false } },
        checkedAt: expect.any(Number),
      }));
    }, { timeout: 3_000, interval: 10 });

    expect(detectInstalledAgentsMock).toHaveBeenCalledWith({ forceRefresh: true });
  });
});
