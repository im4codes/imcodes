import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_GROUP_CLONE_MSG } from '../../shared/session-group-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const {
  getSessionMock,
  listSessionsMock,
  launchSessionMock,
  stopProjectMock,
  persistSessionRecordAwaitedMock,
  startSubSessionMock,
  stopSubSessionMock,
  getSavedP2pConfigMock,
  upsertSavedP2pConfigMock,
  removeSavedP2pConfigMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listSessionsMock: vi.fn(),
  launchSessionMock: vi.fn().mockResolvedValue(undefined),
  stopProjectMock: vi.fn().mockResolvedValue({ ok: true, closed: [], failed: [] }),
  persistSessionRecordAwaitedMock: vi.fn().mockResolvedValue(undefined),
  startSubSessionMock: vi.fn().mockResolvedValue(undefined),
  stopSubSessionMock: vi.fn().mockResolvedValue({ ok: true, closed: [], failed: [] }),
  getSavedP2pConfigMock: vi.fn().mockResolvedValue(undefined),
  upsertSavedP2pConfigMock: vi.fn().mockResolvedValue(undefined),
  removeSavedP2pConfigMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  listSessions: listSessionsMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  launchSession: launchSessionMock,
  stopProject: stopProjectMock,
  persistSessionRecord: vi.fn(),
  persistSessionRecordAwaited: persistSessionRecordAwaitedMock,
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: startSubSessionMock,
  stopSubSession: stopSubSessionMock,
}));

vi.mock('../../src/store/p2p-config-store.js', () => ({
  getSavedP2pConfig: getSavedP2pConfigMock,
  upsertSavedP2pConfig: upsertSavedP2pConfigMock,
  removeSavedP2pConfig: removeSavedP2pConfigMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeMain(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now();
  return {
    name: 'deck_cd_brain',
    projectName: 'cd',
    role: 'brain',
    agentType: 'qwen',
    projectDir: overrides.projectDir ?? '/tmp',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: now,
    updatedAt: now,
    runtimeType: 'transport',
    label: 'Source Label',
    ccPreset: 'MiniMax',
    qwenModel: 'minimax-m2',
    requestedModel: 'minimax-m2',
    presetContextWindow: 200000,
    transportConfig: { headers: { 'X-Api-Key': 'secret-value' } },
    providerSessionId: 'runtime-provider-session',
    providerResumeId: 'runtime-provider-resume',
    ccSessionId: 'runtime-cc-session',
    codexSessionId: 'runtime-codex-session',
    paneId: '%42',
    ...overrides,
  };
}

function makeLink() {
  return {
    getServerId: () => 'server-1',
    send: vi.fn(),
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'imcodes-clone-test-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('daemon session group clone engine', () => {
  it('launches a fresh role-compatible main clone and keeps transportConfig out of events', async () => {
    const source = makeMain({ projectDir: tempDir, state: 'running' });
    const resolvedTempDir = await realpath(tempDir);
    getSessionMock.mockImplementation((name: string) => name === source.name ? source : undefined);
    listSessionsMock.mockReturnValue([source]);
    launchSessionMock.mockImplementationOnce(async (opts) => {
      getSessionMock.mockImplementation((name: string) => {
        if (name === source.name) return source;
        if (name === opts.name) {
          return {
            ...source,
            name: opts.name,
            projectName: opts.projectName,
            role: opts.role,
            projectDir: opts.projectDir,
            providerSessionId: 'fresh-provider-session',
            providerResumeId: undefined,
            ccSessionId: 'fresh-cc-session',
            codexSessionId: undefined,
            paneId: undefined,
            userCreated: true,
          };
        }
        return undefined;
      });
    });

    const { handleSessionGroupCloneCommand } = await import('../../src/daemon/session-group-clone.js');
    const link = makeLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: source.name,
      targetProjectName: 'P2P Design Review',
      idempotencyKey: 'idem-1',
    }, link as never);

    expect(launchSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_p2p_design_review_brain',
      projectName: 'p2p_design_review',
      role: 'brain',
      agentType: 'qwen',
      projectDir: resolvedTempDir,
      fresh: true,
      userCreated: true,
      label: 'Source Label',
      ccPreset: 'MiniMax',
      qwenModel: 'minimax-m2',
    }));
    const serializedEvents = JSON.stringify(link.send.mock.calls.map((call) => call[0]));
    expect(serializedEvents).toContain('"state":"succeeded"');
    expect(serializedEvents).toContain('deck_p2p_design_review_brain');
    expect(serializedEvents).not.toContain('secret-value');
    expect(serializedEvents).not.toContain('runtime-provider-session');
    expect(serializedEvents).not.toContain('runtime-provider-resume');
    expect(serializedEvents).not.toContain('runtime-cc-session');
    expect(serializedEvents).not.toContain('runtime-codex-session');
    expect(serializedEvents).not.toContain('%42');
  });

  it('rejects blank target names before sanitizer fallback can create proj', async () => {
    const source = makeMain({ projectDir: tempDir });
    getSessionMock.mockImplementation((name: string) => name === source.name ? source : undefined);
    listSessionsMock.mockReturnValue([source]);

    const { handleSessionGroupCloneCommand } = await import('../../src/daemon/session-group-clone.js');
    const link = makeLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: source.name,
      targetProjectName: '   ',
      idempotencyKey: 'idem-blank',
    }, link as never);

    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(link.send.mock.calls.map((call) => call[0]))).toContain('blank_target_project');
  });

  it('rejects non-role-compatible source main sessions', async () => {
    const source = makeMain({ name: 'deck_cd_brain_1', projectDir: tempDir });
    getSessionMock.mockImplementation((name: string) => name === source.name ? source : undefined);
    listSessionsMock.mockReturnValue([source]);

    const { handleSessionGroupCloneCommand } = await import('../../src/daemon/session-group-clone.js');
    const link = makeLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: source.name,
      targetProjectName: 'copy',
      idempotencyKey: 'idem-role',
    }, link as never);

    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(link.send.mock.calls.map((call) => call[0]))).toContain('source_not_role_compatible');
  });
});
