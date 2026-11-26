import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_AVAILABILITY_MSG } from '../../shared/agent-availability.js';
import { AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';

const { statQueue, accessMock, statMock } = vi.hoisted(() => {
  const queue: Array<(p: string) => Promise<{ isFile(): boolean }>> = [];
  const accessFn = vi.fn(async () => undefined);
  const statFn = vi.fn(async (p: string) => {
    for (const hook of queue) {
      const res = await hook(p);
      if (res) return res;
    }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
  return { statQueue: queue, accessMock: accessFn, statMock: statFn };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...orig,
    stat: (...args: unknown[]) => statMock(String(args[0])),
    access: (...args: unknown[]) => accessMock(String(args[0])),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));
vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn(),
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

import {
  detectInstalledAgents,
  __resetAgentAvailabilityCacheForTests,
} from '../../src/agent/agent-availability.js';
import {
  handleWebCommand,
  __resetDetectAgentsOrderForTests,
} from '../../src/daemon/command-handler.js';

describe('agent-availability concurrent forceRefresh ordering', () => {
  beforeEach(() => {
    __resetAgentAvailabilityCacheForTests();
    __resetDetectAgentsOrderForTests();
    statQueue.length = 0;
    vi.clearAllMocks();
  });

  it('prevents a slow initial default probe from overwriting cache or broadcasting over a faster forceRefresh', async () => {
    let agyCallCount = 0;
    let releaseFirstDefaultAgy!: (installed: boolean) => void;

    statQueue.push(async (filePath: string) => {
      if (filePath.endsWith('/agy')) {
        agyCallCount += 1;
        if (agyCallCount === 1) {
          // First default probe is delayed and later resolves to missing (false).
          const installed = await new Promise<boolean>((resolve) => {
            releaseFirstDefaultAgy = resolve;
          });
          if (installed) return { isFile: () => true };
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        // Subsequent forced probe resolves immediately to installed (true).
        return { isFile: () => true };
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const sentFrames: Array<Record<string, unknown>> = [];
    const serverLink = {
      send: vi.fn((frame: Record<string, unknown>) => { sentFrames.push(frame); }),
      sendBinary: vi.fn(),
      sendTimelineEvent: vi.fn(),
      daemonVersion: '0.1.0',
    };

    // Start initial default probe via command handler (delayed).
    handleWebCommand({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: false }, serverLink as any);
    await new Promise((r) => setTimeout(r, 10));

    // Trigger manual refresh before the delayed default finishes.
    handleWebCommand({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: true }, serverLink as any);
    await new Promise((r) => setTimeout(r, 30));

    expect(sentFrames).toHaveLength(1);
    expect((sentFrames[0] as any).agents[AGY_SDK_PROVIDER_ID]?.installed).toBe(true);

    // Now resolve the stale earlier default probe to ENOENT (false).
    releaseFirstDefaultAgy(false);
    await new Promise((r) => setTimeout(r, 30));

    // Stale earlier probe must NOT broadcast a second (older) snapshot to browsers!
    expect(sentFrames).toHaveLength(1);

    // Subsequent cached read must retain the forced refresh result (true).
    const cached = await detectInstalledAgents({ forceRefresh: false });
    expect(cached[AGY_SDK_PROVIDER_ID]?.installed).toBe(true);
  });

  it('broadcasts forced refresh epoch 2 to browsers even when a second browser sends a normal detect request while forceRefresh is in flight on warm stale cache, and coalesces concurrent forceRefresh probes', async () => {
    let phase: 'warm' | 'forced' = 'warm';
    let forcedStatCalls = 0;
    let releaseForcedAgy!: () => void;
    const forcedGate = new Promise<void>((resolve) => {
      releaseForcedAgy = resolve;
    });

    statQueue.push(async (filePath: string) => {
      if (filePath.endsWith('/agy')) {
        if (phase === 'warm') {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        forcedStatCalls += 1;
        await forcedGate;
        return { isFile: () => true };
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const sentFrames: Array<Record<string, unknown>> = [];
    const serverLink = {
      send: vi.fn((frame: Record<string, unknown>) => { sentFrames.push(frame); }),
      sendBinary: vi.fn(),
      sendTimelineEvent: vi.fn(),
      daemonVersion: '0.1.0',
    };

    // 1. Warm cache at epoch 1 with agy=false.
    handleWebCommand({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: false }, serverLink as any);
    await vi.waitFor(() => expect(sentFrames).toHaveLength(1));
    expect((sentFrames[0] as any).agents[AGY_SDK_PROVIDER_ID]?.installed).toBe(false);

    // 2. Browser 1 triggers forceRefresh (seq=2, epoch=2, pending on forcedGate).
    phase = 'forced';
    handleWebCommand({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: true }, serverLink as any);
    await vi.waitFor(() => expect(forcedStatCalls).toBe(1));

    // 3. While forceRefresh epoch 2 is pending, Browser 2 sends a normal detect (seq=3) AND Browser 3 sends a concurrent forceRefresh (seq=4).
    handleWebCommand({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: false }, serverLink as any);
    handleWebCommand({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: true }, serverLink as any);
    await new Promise((r) => setTimeout(r, 20));

    // Concurrent forceRefresh coalesced onto the single in-flight forced epoch 2 scan:
    expect(forcedStatCalls).toBe(1);

    // 4. Complete epoch 2 with agy=true:
    releaseForcedAgy();
    await vi.waitFor(() => {
      const latest = sentFrames[sentFrames.length - 1] as any;
      expect(latest?.agents?.[AGY_SDK_PROVIDER_ID]?.installed).toBe(true);
    });
  });
});
