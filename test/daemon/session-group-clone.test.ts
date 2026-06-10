import { mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_GROUP_CLONE_MSG, type SessionGroupCloneEvent } from '../../shared/session-group-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const {
  sessions,
  p2pConfigs,
  getSavedP2pConfigMock,
  upsertSavedP2pConfigMock,
  removeSavedP2pConfigMock,
  launchSessionMock,
  stopProjectMock,
  persistSessionRecordMock,
  persistSessionRecordAwaitedMock,
  startSubSessionMock,
  stopSubSessionMock,
  getPaneCwdMock,
  getCodexRuntimeConfigMock,
  getClaudeSdkRuntimeConfigMock,
  getQwenDisplayMetadataMock,
  getQwenOAuthQuotaUsageLabelMock,
  cloneGitRemoteToDirectoryMock,
} = vi.hoisted(() => {
  const sessions = new Map<string, SessionRecord>();
  const p2pConfigs = new Map<string, import('../../shared/p2p-modes.js').P2pSavedConfig>();
  return {
    sessions,
    p2pConfigs,
    getSavedP2pConfigMock: vi.fn((scope: string) => Promise.resolve(p2pConfigs.get(scope))),
    upsertSavedP2pConfigMock: vi.fn((scope: string, config: import('../../shared/p2p-modes.js').P2pSavedConfig) => {
      p2pConfigs.set(scope, config);
      return Promise.resolve();
    }),
    removeSavedP2pConfigMock: vi.fn((scope: string) => {
      p2pConfigs.delete(scope);
      return Promise.resolve();
    }),
    launchSessionMock: vi.fn(),
    stopProjectMock: vi.fn(),
    persistSessionRecordMock: vi.fn(),
    persistSessionRecordAwaitedMock: vi.fn(),
    startSubSessionMock: vi.fn(),
    stopSubSessionMock: vi.fn(),
    getPaneCwdMock: vi.fn(),
    getCodexRuntimeConfigMock: vi.fn(async () => ({})),
    getClaudeSdkRuntimeConfigMock: vi.fn(async () => ({})),
    getQwenDisplayMetadataMock: vi.fn(() => ({})),
    getQwenOAuthQuotaUsageLabelMock: vi.fn(() => undefined),
    cloneGitRemoteToDirectoryMock: vi.fn(),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string) => sessions.get(name),
  listSessions: () => [...sessions.values()],
  upsertSession: (record: SessionRecord) => {
    sessions.set(record.name, { ...record });
  },
  removeSession: (name: string) => {
    sessions.delete(name);
  },
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  launchSession: launchSessionMock,
  stopProject: stopProjectMock,
  persistSessionRecord: persistSessionRecordMock,
  persistSessionRecordAwaited: persistSessionRecordAwaitedMock,
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: startSubSessionMock,
  stopSubSession: stopSubSessionMock,
}));

vi.mock('../../src/agent/tmux.js', () => ({
  getPaneCwd: getPaneCwdMock,
}));

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: getCodexRuntimeConfigMock,
}));

vi.mock('../../src/agent/sdk-runtime-config.js', () => ({
  getClaudeSdkRuntimeConfig: getClaudeSdkRuntimeConfigMock,
}));

vi.mock('../../src/agent/provider-display.js', () => ({
  getQwenDisplayMetadata: getQwenDisplayMetadataMock,
}));

vi.mock('../../src/agent/provider-quota.js', () => ({
  getQwenOAuthQuotaUsageLabel: getQwenOAuthQuotaUsageLabelMock,
}));

vi.mock('../../src/store/p2p-config-store.js', () => ({
  getSavedP2pConfig: getSavedP2pConfigMock,
  upsertSavedP2pConfig: upsertSavedP2pConfigMock,
  removeSavedP2pConfig: removeSavedP2pConfigMock,
}));

vi.mock('../../src/daemon/git-remote-clone.js', () => ({
  GitRemoteCloneError: class GitRemoteCloneError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'GitRemoteCloneError';
      this.code = code;
    }
  },
  cloneGitRemoteToDirectory: cloneGitRemoteToDirectoryMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { handleSessionGroupCloneCancel, handleSessionGroupCloneCommand } = await import('../../src/daemon/session-group-clone.js');

let unique = 0;

function makeSession(partial: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role' | 'projectDir'>): SessionRecord {
  return {
    agentType: 'claude-code',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  };
}

function makeServerLink() {
  const sent: SessionGroupCloneEvent[] = [];
  const messages: object[] = [];
  return {
    sent,
    messages,
    link: {
      daemonVersion: 'test',
      getServerId: () => 'server-1',
      send: (msg: object) => {
        messages.push(msg);
        if ((msg as { type?: string }).type === SESSION_GROUP_CLONE_MSG.EVENT) {
          sent.push(msg as SessionGroupCloneEvent);
        }
      },
    },
  };
}

async function makeDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `imcodes-clone-${name}-`));
}

function installDefaultLaunchMocks(): void {
  launchSessionMock.mockImplementation(async (opts: {
    name: string;
    projectName: string;
    role: 'brain';
    agentType: string;
    projectDir: string;
    requestedModel?: string;
    qwenModel?: string;
    transportConfig?: Record<string, unknown>;
    ccPreset?: string;
    label?: string;
    description?: string;
    userCreated?: boolean;
  }) => {
    sessions.set(opts.name, makeSession({
      name: opts.name,
      projectName: opts.projectName,
      role: opts.role,
      agentType: opts.agentType,
      projectDir: opts.projectDir,
      requestedModel: opts.requestedModel,
      qwenModel: opts.qwenModel,
      transportConfig: opts.transportConfig,
      ccPreset: opts.ccPreset,
      label: opts.label,
      description: opts.description,
      userCreated: opts.userCreated,
      providerSessionId: 'fresh-provider-main',
      ccSessionId: 'fresh-cc-main',
    }));
  });
  startSubSessionMock.mockImplementation(async (sub: {
    id: string;
    type: string;
    cwd: string;
    parentSession?: string | null;
    requestedModel?: string | null;
    transportConfig?: Record<string, unknown> | null;
    ccPreset?: string | null;
    label?: string | null;
    description?: string | null;
  }) => {
    const name = `deck_sub_${sub.id}`;
    sessions.set(name, makeSession({
      name,
      projectName: name,
      role: 'w1',
      agentType: sub.type,
      projectDir: sub.cwd,
      parentSession: sub.parentSession ?? undefined,
      requestedModel: sub.requestedModel ?? undefined,
      transportConfig: sub.transportConfig ?? undefined,
      ccPreset: sub.ccPreset ?? undefined,
      label: sub.label ?? undefined,
      description: sub.description ?? undefined,
      userCreated: true,
      providerSessionId: `fresh-provider-${sub.id}`,
      ccSessionId: `fresh-cc-${sub.id}`,
    }));
  });
  stopProjectMock.mockImplementation(async (projectName: string) => {
    sessions.delete(`deck_${projectName}_brain`);
    return { ok: true, closed: [], failed: [] };
  });
  stopSubSessionMock.mockImplementation(async (sessionName: string) => {
    sessions.delete(sessionName);
    return { ok: true, closed: [], failed: [] };
  });
}

beforeEach(() => {
  sessions.clear();
  p2pConfigs.clear();
  vi.clearAllMocks();
  getSavedP2pConfigMock.mockImplementation((scope: string) => Promise.resolve(p2pConfigs.get(scope)));
  upsertSavedP2pConfigMock.mockImplementation((scope: string, config: import('../../shared/p2p-modes.js').P2pSavedConfig) => {
    p2pConfigs.set(scope, config);
    return Promise.resolve();
  });
  removeSavedP2pConfigMock.mockImplementation((scope: string) => {
    p2pConfigs.delete(scope);
    return Promise.resolve();
  });
  installDefaultLaunchMocks();
  getPaneCwdMock.mockRejectedValue(new Error('tmux unavailable'));
  cloneGitRemoteToDirectoryMock.mockImplementation(async ({ targetDir }: { targetDir: string }) => targetDir);
  persistSessionRecordAwaitedMock.mockResolvedValue(undefined);
});

afterEach(() => {
  sessions.clear();
  p2pConfigs.clear();
});

describe('daemon session group clone', () => {
  it('clones a role-compatible main session and active direct children without leaking transport config in events', async () => {
    const dir = await makeDir('basic');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
      label: 'CD Brain',
      description: 'main persona',
      requestedModel: 'opus',
      activeModel: 'opus-active',
      ccPreset: 'preset-a',
      presetContextWindow: 200000,
      transportConfig: { apiKey: 'SECRET_MAIN_KEY', headers: { authorization: 'Bearer secret' } },
      providerSessionId: 'source-provider-main',
      ccSessionId: 'source-cc-main',
    }));
    sessions.set('deck_sub_active', makeSession({
      name: 'deck_sub_active',
      projectName: 'deck_sub_active',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Worker A',
      description: 'worker persona',
      requestedModel: 'sonnet',
      activeModel: 'sonnet-active',
      ccPreset: 'preset-b',
      presetContextWindow: 100000,
      transportConfig: { clientSecret: 'SECRET_SUB_KEY' },
      providerSessionId: 'source-provider-sub',
      ccSessionId: 'source-cc-sub',
    }));
    sessions.set('deck_sub_stopped', makeSession({
      name: 'deck_sub_stopped',
      projectName: 'deck_sub_stopped',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      state: 'stopped',
    }));
    sessions.set('deck_sub_nested', makeSession({
      name: 'deck_sub_nested',
      projectName: 'deck_sub_nested',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_sub_active',
    }));
    p2pConfigs.set('server-1:deck_cd_brain', {
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
        deck_sub_active: { enabled: true, mode: 'review' },
      },
      rounds: 2,
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_sub_active',
      },
    });
    const { link, sent, messages } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-basic-${unique++}`,
    }, link as never);

    const main = sessions.get('deck_cd_1_brain');
    expect(main).toMatchObject({
      label: 'cd_1',
      description: 'main persona',
      requestedModel: 'opus',
      activeModel: 'opus-active',
      ccPreset: 'preset-a',
      presetContextWindow: 200000,
      userCreated: true,
    });
    expect(main?.providerSessionId).toBe('fresh-provider-main');
    expect(main?.ccSessionId).toBe('fresh-cc-main');

    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(clonedSub).toMatchObject({
      label: 'Worker A',
      description: 'worker persona',
      requestedModel: 'sonnet',
      activeModel: 'sonnet-active',
      ccPreset: 'preset-b',
      presetContextWindow: 100000,
      userCreated: true,
    });
    expect(clonedSub?.providerSessionId).not.toBe('source-provider-sub');
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'subsession.sync',
      id: clonedSub!.name.replace(/^deck_sub_/, ''),
      sessionType: clonedSub!.agentType,
      parentSession: 'deck_cd_1_brain',
      cwd: clonedSub!.projectDir,
      label: 'Worker A',
    }));
    expect(sent.at(-1)?.state).toBe('succeeded');
    expect(sent.at(-1)?.result?.skippedMembers).toEqual(expect.arrayContaining([
      { sessionName: 'deck_sub_stopped', reason: 'stopped' },
      { sessionName: 'deck_sub_nested', reason: 'nested' },
    ]));
    expect(p2pConfigs.get('server-1:deck_cd_1_brain')?.sessions).toEqual({
      deck_cd_1_brain: { enabled: true, mode: 'audit' },
      [clonedSub!.name]: { enabled: true, mode: 'review' },
    });

    const eventText = JSON.stringify(sent);
    expect(eventText).not.toContain('SECRET_MAIN_KEY');
    expect(eventText).not.toContain('SECRET_SUB_KEY');
    expect(eventText).not.toContain('authorization');
    expect(eventText).not.toContain('transportConfig');
  });

  it('copies daemon-local Team config saved under a source member scope', async () => {
    const dir = await makeDir('member-p2p-config');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_active', makeSession({
      name: 'deck_sub_active',
      projectName: 'deck_sub_active',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Worker A',
    }));
    p2pConfigs.set('server-1:deck_sub_active', {
      sessions: {
        deck_sub_active: { enabled: true, mode: 'audit' },
      },
      rounds: 2,
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_sub_active',
      },
    });
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-member-p2p-${unique++}`,
    }, link as never);

    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(clonedSub?.name).toBeDefined();
    expect(p2pConfigs.get('server-1:deck_cd_1_brain')).toMatchObject({
      sessions: {
        [clonedSub!.name]: { enabled: true, mode: 'audit' },
      },
      rounds: 2,
      contextReducer: {
        sessionName: clonedSub!.name,
      },
    });
    expect(sent.at(-1)).toMatchObject({ state: 'succeeded' });
  });

  it('preserves a non-English target project name as the cloned main display label', async () => {
    const dir = await makeDir('non-english-label');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
      label: 'Source Label',
    }));
    const { link } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      targetProjectName: '客户项目',
      idempotencyKey: `idem-non-english-label-${unique++}`,
    }, link as never);

    const main = [...sessions.values()].find((record) => record.role === 'brain' && record.name !== 'deck_cd_brain');
    expect(main).toMatchObject({
      name: 'deck_u5ba2_u6237_u9879_u76ee_brain',
      projectName: 'u5ba2_u6237_u9879_u76ee',
      label: '客户项目',
      userCreated: true,
    });
  });

  it('syncs every cloned active direct child through the sub-session DB path', async () => {
    const dir = await makeDir('sync-every-child');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_shell', makeSession({
      name: 'deck_sub_shell',
      projectName: 'deck_sub_shell',
      role: 'w1',
      agentType: 'shell',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Sh1',
    }));
    sessions.set('deck_sub_codex', makeSession({
      name: 'deck_sub_codex',
      projectName: 'deck_sub_codex',
      role: 'w1',
      agentType: 'codex-sdk',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Cx1',
    }));
    sessions.set('deck_sub_qwen', makeSession({
      name: 'deck_sub_qwen',
      projectName: 'deck_sub_qwen',
      role: 'w1',
      agentType: 'qwen',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Qw1',
      qwenModel: 'glm-5.1',
      requestedModel: 'glm-5.1',
    }));
    const { link, sent, messages } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-sync-${unique++}`,
    }, link as never);

    const result = sent.at(-1)?.result;
    const syncMessages = messages.filter((msg): msg is Record<string, unknown> =>
      (msg as { type?: string }).type === 'subsession.sync',
    );
    expect(result?.copiedSubSessionIds).toHaveLength(3);
    expect(syncMessages).toHaveLength(3);
    expect(syncMessages.map((msg) => msg.id).sort()).toEqual(
      result!.copiedSubSessionIds.map((entry) => entry.clonedId).sort(),
    );
    expect(syncMessages.every((msg) => msg.parentSession === 'deck_cd_1_brain')).toBe(true);
    expect(syncMessages.map((msg) => msg.sessionType).sort()).toEqual(['codex-sdk', 'qwen', 'shell']);
  });

  it('rejects blank targets, explicit target conflicts, and source role mismatches before creation', async () => {
    const dir = await makeDir('reject');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_p2p_design_review_brain', makeSession({
      name: 'deck_p2p_design_review_brain',
      projectName: 'p2p_design_review',
      role: 'brain',
      projectDir: dir,
    }));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-conflict-${unique++}`,
      targetProjectName: 'P2P Design Review',
    }, link as never);
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-blank-${unique++}`,
      targetProjectName: '   ',
    }, link as never);
    sessions.set('deck_bad_w1', makeSession({
      name: 'deck_bad_w1',
      projectName: 'bad',
      role: 'w1',
      projectDir: dir,
    }));
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_bad_w1',
      idempotencyKey: `idem-bad-source-${unique++}`,
    }, link as never);

    expect(launchSessionMock).not.toHaveBeenCalled();
    expect(sent.filter((event) => event.state === 'failed').map((event) => event.errorCode)).toEqual([
      'name_taken',
      'blank_target_project',
      'source_not_role_compatible',
    ]);
  });

  it('allocates default target names inside the project slug, including already-suffixed sources', async () => {
    const dir = await makeDir('default-names');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    const first = makeServerLink();
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-default-a-${unique++}`,
    }, first.link as never);
    const second = makeServerLink();
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-default-b-${unique++}`,
    }, second.link as never);

    expect(sessions.get('deck_cd_1_brain')).toBeTruthy();
    expect(sessions.get('deck_cd_2_brain')).toBeTruthy();

    sessions.set('deck_cd_1_brain', makeSession({
      name: 'deck_cd_1_brain',
      projectName: 'cd_1',
      role: 'brain',
      projectDir: dir,
    }));
    const suffixed = makeServerLink();
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_1_brain',
      idempotencyKey: `idem-default-c-${unique++}`,
    }, suffixed.link as never);

    expect(sessions.get('deck_cd_1_1_brain')).toBeTruthy();
  });

  it('skips server-visible unavailable names during default target allocation', async () => {
    const dir = await makeDir('server-visible-names');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    const { link } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-server-visible-${unique++}`,
      unavailableSessionNames: ['deck_cd_1_brain'],
    }, link as never);

    expect(sessions.get('deck_cd_1_brain')).toBeUndefined();
    expect(sessions.get('deck_cd_2_brain')).toBeTruthy();
  });

  it('keeps concurrent default allocations conflict-safe with active reservations', async () => {
    const dir = await makeDir('concurrent');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    let releaseFirstLaunch!: () => void;
    const firstLaunchStarted = new Promise<void>((resolve) => {
      launchSessionMock.mockImplementationOnce(async (opts: Parameters<typeof launchSessionMock>[0]) => {
        resolve();
        await new Promise<void>((release) => { releaseFirstLaunch = release; });
        sessions.set(opts.name, makeSession({
          name: opts.name,
          projectName: opts.projectName,
          role: opts.role,
          agentType: opts.agentType,
          projectDir: opts.projectDir,
          userCreated: true,
        }));
      });
    });
    const first = makeServerLink();
    const second = makeServerLink();
    const running = handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-concurrent-a-${unique++}`,
    }, first.link as never);
    await firstLaunchStarted;
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-concurrent-b-${unique++}`,
    }, second.link as never);
    releaseFirstLaunch();
    await running;

    expect(sessions.get('deck_cd_1_brain')).toBeTruthy();
    expect(sessions.get('deck_cd_2_brain')).toBeTruthy();
  });

  it('fails active incomplete child candidates before creating cloned resources', async () => {
    const dir = await makeDir('incomplete');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_missing_cwd', makeSession({
      name: 'deck_sub_missing_cwd',
      projectName: 'deck_sub_missing_cwd',
      role: 'w1',
      projectDir: '',
      parentSession: 'deck_cd_brain',
      state: 'running',
    }));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-incomplete-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'incomplete_clone_spec' });
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it('fails active unsupported child candidates before creating cloned resources', async () => {
    const dir = await makeDir('unsupported');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_unsupported', makeSession({
      name: 'deck_sub_unsupported',
      projectName: 'deck_sub_unsupported',
      role: 'w1',
      agentType: 'not-a-real-agent',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      state: 'idle',
    }));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-unsupported-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'unsupported_session_type' });
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it('preserves current sub-session cloneable fields available on daemon records', async () => {
    const dir = await makeDir('sub-fields');
    const resolvedDir = await realpath(dir);
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_shell', makeSession({
      name: 'deck_sub_shell',
      projectName: 'deck_sub_shell',
      role: 'w1',
      agentType: 'shell',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Shell Worker',
      description: 'keeps shell settings',
      requestedModel: 'shell-requested',
      activeModel: 'shell-active',
      qwenModel: 'qwen-model',
      effort: 'high',
      ccPreset: 'preset-shell',
      presetContextWindow: 50000,
      transportConfig: { endpoint: 'local' },
      shellBin: 'bash',
    } as Partial<SessionRecord> as SessionRecord));
    const { link } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-sub-fields-${unique++}`,
    }, link as never);

    expect(startSubSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'shell',
      cwd: resolvedDir,
      label: 'Shell Worker',
      description: 'keeps shell settings',
      requestedModel: 'shell-requested',
      transportConfig: { endpoint: 'local' },
      ccPreset: 'preset-shell',
      effort: 'high',
      shellBin: 'bash',
      parentSession: 'deck_cd_1_brain',
    }));
    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(clonedSub).toMatchObject({
      label: 'Shell Worker',
      description: 'keeps shell settings',
      requestedModel: 'shell-requested',
      activeModel: 'shell-active',
      qwenModel: 'qwen-model',
      effort: 'high',
      ccPreset: 'preset-shell',
      presetContextWindow: 50000,
      transportConfig: { endpoint: 'local' },
    });
  });

  it('preserves active direct sub-session launch order from the daemon session list', async () => {
    const dir = await makeDir('sub-order');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_reviewer', makeSession({
      name: 'deck_sub_reviewer',
      projectName: 'deck_sub_reviewer',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Reviewer',
    }));
    sessions.set('deck_sub_implementer', makeSession({
      name: 'deck_sub_implementer',
      projectName: 'deck_sub_implementer',
      role: 'w2',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Implementer',
    }));
    sessions.set('deck_sub_summarizer', makeSession({
      name: 'deck_sub_summarizer',
      projectName: 'deck_sub_summarizer',
      role: 'w3',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      label: 'Summarizer',
    }));
    const { link } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-sub-order-${unique++}`,
    }, link as never);

    expect(startSubSessionMock.mock.calls.map((call) => call[0].label)).toEqual([
      'Reviewer',
      'Implementer',
      'Summarizer',
    ]);
  });

  it('launches cloned sub-sessions concurrently instead of awaiting each one sequentially', async () => {
    const dir = await makeDir('sub-parallel');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    for (const label of ['Reviewer', 'Implementer', 'Summarizer'] as const) {
      const name = `deck_sub_${label.toLowerCase()}`;
      sessions.set(name, makeSession({
        name,
        projectName: name,
        role: 'w1',
        projectDir: dir,
        parentSession: 'deck_cd_brain',
        label,
      }));
    }
    const { link } = makeServerLink();

    // Each launch parks on a manually released promise. If launches were
    // sequential, the second startSubSession would never be invoked while the
    // first is still pending and peak in-flight would stay at 1.
    let inFlight = 0;
    let peakInFlight = 0;
    const defaultImpl = startSubSessionMock.getMockImplementation()!;
    const releases: Array<() => void> = [];
    startSubSessionMock.mockImplementation(async (sub: Parameters<typeof defaultImpl>[0]) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      inFlight -= 1;
      await defaultImpl(sub);
    });

    const clonePromise = handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-sub-parallel-${unique++}`,
    }, link as never);

    await vi.waitFor(() => {
      expect(releases.length).toBe(3);
    });
    expect(peakInFlight).toBe(3);
    for (const release of releases) release();
    await clonePromise;

    expect(startSubSessionMock).toHaveBeenCalledTimes(3);
    expect([...sessions.values()].filter((record) => record.parentSession === 'deck_cd_1_brain')).toHaveLength(3);
  });

  it('persists Qwen preset fields for main and sub-session clones and retargets cloned-root P2P config', async () => {
    const dir = await makeDir('qwen-preset-persist');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      projectDir: dir,
      requestedModel: 'qwen3-coder-plus',
      activeModel: 'qwen3-coder-plus',
      qwenModel: 'qwen3-coder-plus',
      ccPreset: 'Qwen Max',
      presetContextWindow: 262144,
      transportConfig: {
        baseURL: 'https://dashscope.example.test',
        apiKey: 'SECRET_QWEN_KEY',
        headers: { 'X-Client': 'source-main', sessionKey: 'SOURCE_MAIN_HEADER_SESSION_KEY' },
        nested: { region: 'cn', sessionId: 'SOURCE_MAIN_NESTED_SESSION_ID' },
        routes: [{ name: 'primary', threadId: 'SOURCE_MAIN_ROUTE_THREAD_ID' }],
        sessionKey: 'SOURCE_MAIN_SESSION_KEY',
        bindExistingKey: 'SOURCE_MAIN_BIND_KEY',
        resumeId: 'SOURCE_MAIN_RESUME_ID',
        providerSessionId: 'SOURCE_MAIN_PROVIDER_SESSION_ID',
      },
    }));
    sessions.set('deck_sub_qwen', makeSession({
      name: 'deck_sub_qwen',
      projectName: 'deck_sub_qwen',
      role: 'w1',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
      requestedModel: 'qwen3-coder-flash',
      activeModel: 'qwen3-coder-flash',
      qwenModel: 'qwen3-coder-flash',
      ccPreset: 'Qwen Worker',
      presetContextWindow: 131072,
      transportConfig: {
        baseURL: 'https://dashscope-worker.example.test',
        apiKey: 'SECRET_WORKER_KEY',
        nested: { region: 'us', providerResumeId: 'SOURCE_SUB_PROVIDER_RESUME_ID' },
        routes: [{ name: 'worker', sdkSessionId: 'SOURCE_SUB_SDK_SESSION_ID' }],
        session_id: 'SOURCE_SUB_SESSION_ID',
        ccSessionId: 'SOURCE_SUB_CC_SESSION_ID',
      },
    }));
    p2pConfigs.set('server-1:deck_cd_brain', {
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
        deck_sub_qwen: { enabled: true, mode: 'review' },
      },
      rounds: 2,
    });
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-qwen-preset-${unique++}`,
    }, link as never);

    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(sessions.get('deck_cd_1_brain')).toMatchObject({
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      requestedModel: 'qwen3-coder-plus',
      activeModel: 'qwen3-coder-plus',
      qwenModel: 'qwen3-coder-plus',
      ccPreset: 'Qwen Max',
      presetContextWindow: 262144,
      transportConfig: {
        baseURL: 'https://dashscope.example.test',
        apiKey: 'SECRET_QWEN_KEY',
        headers: { 'X-Client': 'source-main' },
        nested: { region: 'cn' },
        routes: [{ name: 'primary' }],
      },
      userCreated: true,
    });
    expect(clonedSub).toMatchObject({
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      requestedModel: 'qwen3-coder-flash',
      activeModel: 'qwen3-coder-flash',
      qwenModel: 'qwen3-coder-flash',
      ccPreset: 'Qwen Worker',
      presetContextWindow: 131072,
      transportConfig: {
        baseURL: 'https://dashscope-worker.example.test',
        apiKey: 'SECRET_WORKER_KEY',
        nested: { region: 'us' },
        routes: [{ name: 'worker' }],
      },
      userCreated: true,
    });
    const clonedTransportText = JSON.stringify([
      sessions.get('deck_cd_1_brain')?.transportConfig,
      clonedSub?.transportConfig,
      launchSessionMock.mock.calls.at(-1)?.[0]?.transportConfig,
      startSubSessionMock.mock.calls.at(-1)?.[0]?.transportConfig,
    ]);
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_SESSION_KEY');
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_BIND_KEY');
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_RESUME_ID');
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_PROVIDER_SESSION_ID');
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_HEADER_SESSION_KEY');
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_NESTED_SESSION_ID');
    expect(clonedTransportText).not.toContain('SOURCE_MAIN_ROUTE_THREAD_ID');
    expect(clonedTransportText).not.toContain('SOURCE_SUB_SESSION_ID');
    expect(clonedTransportText).not.toContain('SOURCE_SUB_CC_SESSION_ID');
    expect(clonedTransportText).not.toContain('SOURCE_SUB_PROVIDER_RESUME_ID');
    expect(clonedTransportText).not.toContain('SOURCE_SUB_SDK_SESSION_ID');
    expect(persistSessionRecordAwaitedMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_cd_1_brain',
      ccPreset: 'Qwen Max',
      presetContextWindow: 262144,
      qwenModel: 'qwen3-coder-plus',
    }), 'deck_cd_1_brain');
    expect(persistSessionRecordAwaitedMock).toHaveBeenCalledWith(expect.objectContaining({
      name: clonedSub?.name,
      ccPreset: 'Qwen Worker',
      presetContextWindow: 131072,
      qwenModel: 'qwen3-coder-flash',
    }), clonedSub?.name);
    expect(p2pConfigs.get('server-1:deck_cd_1_brain')?.sessions).toEqual({
      deck_cd_1_brain: { enabled: true, mode: 'audit' },
      [clonedSub!.name]: { enabled: true, mode: 'review' },
    });
    expect(JSON.stringify(sent)).not.toContain('SECRET_QWEN_KEY');
    expect(JSON.stringify(sent)).not.toContain('SECRET_WORKER_KEY');
  });

  it('applies a whole-group cwd override using daemon-host realpath', async () => {
    const sourceDir = await makeDir('source');
    const targetDir = await makeDir('target');
    const linkPath = join(await makeDir('link'), 'checkout');
    await symlink(targetDir, linkPath);
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: sourceDir,
    }));
    sessions.set('deck_sub_active', makeSession({
      name: 'deck_sub_active',
      projectName: 'deck_sub_active',
      role: 'w1',
      projectDir: '',
      parentSession: 'deck_cd_brain',
    }));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-cwd-${unique++}`,
      cwdOverride: linkPath,
    }, link as never);

    expect(sent.at(-1)?.state).toBe('succeeded');
    const resolvedTargetDir = await realpath(targetDir);
    expect(sessions.get('deck_cd_1_brain')?.projectDir).toBe(resolvedTargetDir);
    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(clonedSub?.projectDir).toBe(resolvedTargetDir);
  });

  it('clones an optional git remote into the cwd override before copying the group', async () => {
    const sourceDir = await makeDir('remote-source');
    const requestedTargetDir = join(await makeDir('remote-parent'), 'checkout');
    const clonedTargetDir = await makeDir('remote-cloned');
    cloneGitRemoteToDirectoryMock.mockResolvedValueOnce(clonedTargetDir);
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: sourceDir,
    }));
    sessions.set('deck_sub_active', makeSession({
      name: 'deck_sub_active',
      projectName: 'deck_sub_active',
      role: 'w1',
      projectDir: '',
      parentSession: 'deck_cd_brain',
    }));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-remote-cwd-${unique++}`,
      cwdOverride: requestedTargetDir,
      gitRemoteUrl: 'https://github.com/acme/copied.git',
    }, link as never);

    expect(cloneGitRemoteToDirectoryMock).toHaveBeenCalledWith({
      gitRemoteUrl: 'https://github.com/acme/copied.git',
      targetDir: requestedTargetDir,
    });
    expect(sent.at(-1)?.state).toBe('succeeded');
    expect(sessions.get('deck_cd_1_brain')?.projectDir).toBe(clonedTargetDir);
    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(clonedSub?.projectDir).toBe(clonedTargetDir);
  });

  it('uses the live process pane cwd when an active sub-session has no persisted cwd', async () => {
    const mainDir = await makeDir('live-pane-main');
    const liveSubDir = await makeDir('live-pane-sub');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: mainDir,
    }));
    sessions.set('deck_sub_shell', makeSession({
      name: 'deck_sub_shell',
      projectName: 'deck_sub_shell',
      role: 'w1',
      agentType: 'shell',
      projectDir: '',
      parentSession: 'deck_cd_brain',
      state: 'idle',
    }));
    getPaneCwdMock.mockResolvedValueOnce(liveSubDir);
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-live-cwd-${unique++}`,
    }, link as never);

    const resolvedSubDir = await realpath(liveSubDir);
    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(sent.at(-1)?.state).toBe('succeeded');
    expect(getPaneCwdMock).toHaveBeenCalledWith('deck_sub_shell');
    expect(clonedSub?.projectDir).toBe(resolvedSubDir);
  });

  it('preserves source directories by default and reports non-active child skip reasons', async () => {
    const mainDir = await makeDir('preserve-main');
    const subDir = await makeDir('preserve-sub');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: mainDir,
    }));
    sessions.set('deck_sub_active', makeSession({
      name: 'deck_sub_active',
      projectName: 'deck_sub_active',
      role: 'w1',
      projectDir: subDir,
      parentSession: 'deck_cd_brain',
      state: 'idle',
    }));
    for (const [name, state] of [
      ['deck_sub_stopped', 'stopped'],
      ['deck_sub_error', 'error'],
      ['deck_sub_closed', 'closed'],
    ] as const) {
      sessions.set(name, makeSession({
        name,
        projectName: name,
        role: 'w1',
        projectDir: subDir,
        parentSession: 'deck_cd_brain',
        state: state as SessionRecord['state'],
      }));
    }
    sessions.set('deck_sub_hidden', makeSession({
      name: 'deck_sub_hidden',
      projectName: 'deck_sub_hidden',
      role: 'w1',
      projectDir: subDir,
      parentSession: 'deck_cd_brain',
      state: 'idle',
      hidden: true,
    } as Partial<SessionRecord> as SessionRecord));
    sessions.set('deck_sub_nested', makeSession({
      name: 'deck_sub_nested',
      projectName: 'deck_sub_nested',
      role: 'w1',
      projectDir: subDir,
      parentSession: 'deck_sub_active',
      state: 'idle',
    }));
    sessions.set('deck_sub_orphan', makeSession({
      name: 'deck_sub_orphan',
      projectName: 'deck_sub_orphan',
      role: 'w1',
      projectDir: subDir,
      parentSession: 'deck_missing_brain',
      state: 'idle',
    }));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-skipped-${unique++}`,
    }, link as never);

    const resolvedMainDir = await realpath(mainDir);
    const resolvedSubDir = await realpath(subDir);
    expect(sessions.get('deck_cd_1_brain')?.projectDir).toBe(resolvedMainDir);
    const clonedSub = [...sessions.values()].find((record) => record.parentSession === 'deck_cd_1_brain');
    expect(clonedSub?.projectDir).toBe(resolvedSubDir);
    expect(sent.at(-1)?.result?.skippedMembers).toEqual(expect.arrayContaining([
      { sessionName: 'deck_sub_stopped', reason: 'stopped' },
      { sessionName: 'deck_sub_error', reason: 'error' },
      { sessionName: 'deck_sub_closed', reason: 'closed' },
      { sessionName: 'deck_sub_hidden', reason: 'hidden' },
      { sessionName: 'deck_sub_nested', reason: 'nested' },
      { sessionName: 'deck_sub_orphan', reason: 'server_only_orphan' },
    ]));
  });

  it('rejects invalid default and override directories before clone creation', async () => {
    const validDir = await makeDir('valid-cwd');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: join(validDir, 'missing-source'),
    }));
    const invalidSource = makeServerLink();
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-invalid-source-${unique++}`,
    }, invalidSource.link as never);

    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: validDir,
    }));
    const invalidOverride = makeServerLink();
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-invalid-override-${unique++}`,
      cwdOverride: 'relative/path',
    }, invalidOverride.link as never);

    expect(invalidSource.sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'invalid_cwd' });
    expect(invalidOverride.sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'invalid_cwd' });
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it('rolls back when a directory becomes unusable before a cloned member launches', async () => {
    const dir = await makeDir('cwd-race');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_active', makeSession({
      name: 'deck_sub_active',
      projectName: 'deck_sub_active',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
    }));
    startSubSessionMock.mockRejectedValueOnce(new Error('cwd disappeared before launch'));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-cwd-race-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'internal_error' });
    expect(sessions.get('deck_cd_1_brain')).toBeUndefined();
    expect(stopProjectMock).toHaveBeenCalledWith('cd_1', link);
  });

  it('rolls back already-created resources when a later sub-session launch fails', async () => {
    const dir = await makeDir('mid-sub-fail');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    sessions.set('deck_sub_a', makeSession({
      name: 'deck_sub_a',
      projectName: 'deck_sub_a',
      role: 'w1',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
    }));
    sessions.set('deck_sub_b', makeSession({
      name: 'deck_sub_b',
      projectName: 'deck_sub_b',
      role: 'w2',
      projectDir: dir,
      parentSession: 'deck_cd_brain',
    }));
    startSubSessionMock
      .mockImplementationOnce(async (sub: Parameters<typeof startSubSessionMock>[0]) => {
        const name = `deck_sub_${sub.id}`;
        sessions.set(name, makeSession({
          name,
          projectName: name,
          role: 'w1',
          agentType: sub.type,
          projectDir: sub.cwd,
          parentSession: sub.parentSession ?? undefined,
          userCreated: true,
        }));
      })
      .mockRejectedValueOnce(new Error('sub launch failed'));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-sub-fail-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'internal_error' });
    expect(sessions.get('deck_cd_1_brain')).toBeUndefined();
    expect([...sessions.values()].filter((record) => record.parentSession === 'deck_cd_1_brain')).toHaveLength(0);
    expect(stopSubSessionMock).toHaveBeenCalledTimes(1);
    expect(stopProjectMock).toHaveBeenCalledWith('cd_1', link);
  });

  it('rolls back cloned sessions when daemon-local P2P config writing fails', async () => {
    const dir = await makeDir('p2p-fail');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    p2pConfigs.set('server-1:deck_cd_brain', {
      sessions: { deck_cd_brain: { enabled: true, mode: 'audit' } },
      rounds: 1,
    });
    upsertSavedP2pConfigMock.mockRejectedValueOnce(new Error('p2p write failed'));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-p2p-fail-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'internal_error' });
    expect(sessions.get('deck_cd_1_brain')).toBeUndefined();
    expect(p2pConfigs.get('server-1:deck_cd_1_brain')).toBeUndefined();
    expect(stopProjectMock).toHaveBeenCalledWith('cd_1', link);
  });

  it('treats server DB unique conflicts as name_taken and rolls back local resources', async () => {
    const dir = await makeDir('server-db-conflict');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    persistSessionRecordAwaitedMock.mockRejectedValueOnce(new Error('persistSessionToWorker non-ok response: 409 unique constraint'));
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-db-conflict-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'name_taken' });
    expect(sessions.get('deck_cd_1_brain')).toBeUndefined();
    expect(stopProjectMock).toHaveBeenCalledWith('cd_1', link);
  });

  it('returns cleanup_required with resource identifiers when rollback cannot clean everything', async () => {
    const dir = await makeDir('cleanup-required');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    p2pConfigs.set('server-1:deck_cd_brain', {
      sessions: { deck_cd_brain: { enabled: true, mode: 'audit' } },
      rounds: 1,
    });
    upsertSavedP2pConfigMock.mockRejectedValueOnce(new Error('daemon p2p write failed'));
    stopProjectMock.mockResolvedValueOnce({
      ok: false,
      closed: [],
      failed: [{ sessionName: 'deck_cd_1_brain', stage: 'runtime', message: 'still running' }],
    });
    const { link, sent } = makeServerLink();

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: `idem-cleanup-required-${unique++}`,
    }, link as never);

    expect(sent.at(-1)).toMatchObject({
      state: 'cleanup_required',
      errorCode: 'cleanup_required',
      cleanupRequired: true,
      cleanupResources: expect.arrayContaining([
        expect.objectContaining({
          kind: 'daemon_session',
          id: 'deck_cd_1_brain',
          sessionName: 'deck_cd_1_brain',
          retriable: true,
        }),
        expect.objectContaining({
          kind: 'provider_session',
          id: 'fresh-provider-main',
          sessionName: 'deck_cd_1_brain',
        }),
      ]),
    });
  });

  it('rejects reused idempotency keys when the request fingerprint changes', async () => {
    const dir = await makeDir('idempotency-conflict');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    const { link, sent } = makeServerLink();
    const idempotencyKey = `idem-fingerprint-${unique++}`;

    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey,
      targetProjectName: 'cd_1',
    }, link as never);
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey,
      targetProjectName: 'cd_2',
    }, link as never);

    expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'idempotency_conflict' });
    expect(launchSessionMock).toHaveBeenCalledTimes(1);
    expect(sessions.get('deck_cd_2_brain')).toBeUndefined();
  });

  it('deduplicates concurrent submissions for the same idempotency key', async () => {
    const dir = await makeDir('dedupe');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    let releaseLaunch!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      launchSessionMock.mockImplementationOnce(async (opts: Parameters<typeof launchSessionMock>[0]) => {
        resolve();
        await new Promise<void>((release) => { releaseLaunch = release; });
        sessions.set(opts.name, makeSession({
          name: opts.name,
          projectName: opts.projectName,
          role: opts.role,
          agentType: opts.agentType,
          projectDir: opts.projectDir,
          userCreated: true,
        }));
      });
    });
    const { link } = makeServerLink();
    const idempotencyKey = `idem-dedupe-${unique++}`;

    const first = handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey,
    }, link as never);
    await launchStarted;
    await handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey,
    }, link as never);
    releaseLaunch();
    await first;

    expect(launchSessionMock).toHaveBeenCalledTimes(1);
    expect(sessions.get('deck_cd_1_brain')).toBeTruthy();
  });

  it('rolls back a cloned main session when cancellation lands during creation', async () => {
    const dir = await makeDir('cancel');
    sessions.set('deck_cd_brain', makeSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      projectDir: dir,
    }));
    let releaseLaunch!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      launchSessionMock.mockImplementationOnce(async (opts: Parameters<typeof launchSessionMock>[0]) => {
        resolve();
        await new Promise<void>((release) => { releaseLaunch = release; });
        sessions.set(opts.name, makeSession({
          name: opts.name,
          projectName: opts.projectName,
          role: opts.role,
          agentType: opts.agentType,
          projectDir: opts.projectDir,
          userCreated: true,
        }));
      });
    });
    const { link, sent } = makeServerLink();
    const idempotencyKey = `idem-cancel-${unique++}`;

    const running = handleSessionGroupCloneCommand({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey,
    }, link as never);
    await launchStarted;
    handleSessionGroupCloneCancel({
      type: SESSION_GROUP_CLONE_MSG.CANCEL,
      idempotencyKey,
    }, link as never);
    releaseLaunch();
    await running;

    expect(sent.at(-1)?.state).toBe('cancelled');
    expect(sessions.get('deck_cd_1_brain')).toBeUndefined();
    expect(stopProjectMock).toHaveBeenCalledWith('cd_1', link);
  });
});
