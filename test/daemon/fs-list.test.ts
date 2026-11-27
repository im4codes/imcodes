/**
 * Tests for fs.ls command handler in command-handler.ts.
 * Exercises the handleFsList logic: allowlist enforcement, dir listing,
 * includeFiles flag, hidden-file sorting, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import path from 'path';
import * as fsp from 'node:fs/promises';

// ── Minimal ServerLink mock ────────────────────────────────────────────────
const sent: unknown[] = [];
const mockServerLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

const mockPreviewCoordinator = vi.hoisted(() => ({
  handle: vi.fn(),
  invalidate: vi.fn(),
}));
const mockLookupAttachment = vi.hoisted(() => vi.fn());

// ── Mock fs/promises ───────────────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));
const mockReaddir = vi.mocked(fsp.readdir);
const mockReadFile = vi.mocked(fsp.readFile);
const mockRealpath = vi.mocked(fsp.realpath);
const mockStat = vi.mocked(fsp.stat);

vi.mock('../../src/daemon/file-preview-read-coordinator.js', () => ({
  getDefaultPreviewReadCoordinator: vi.fn(() => mockPreviewCoordinator),
  __resetPreviewReadCoordinatorForTests: vi.fn(),
}), { virtual: true });

vi.mock('../../src/daemon/file-transfer-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/daemon/file-transfer-handler.js')>(),
  lookupAttachment: mockLookupAttachment,
}));

// ── Pull the handler function out of command-handler indirectly ────────────
// We test via handleWebCommand to keep the test at the public API level.
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import * as sessionStore from '../../src/store/session-store.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FS_SESSION_ROOT_PATH } from '../../src/shared/transport/fs.js';
import { __resetSessionFileReadGrantsForTests } from '../../src/daemon/session-file-read-grants.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

// Helper: make a Dirent-like object
function makeDirent(name: string, isDir: boolean, isSymbolicLink = false) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir && !isSymbolicLink,
    isSymbolicLink: () => isSymbolicLink,
  } as unknown as fsp.Dirent<string>;
}

/** Flush the microtask + macrotask queue so async handlers complete. */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

describe('fs.ls handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    // Restore send implementation after clearAllMocks resets it
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    mockPreviewCoordinator.handle.mockImplementation(() => {});
    mockLookupAttachment.mockReturnValue(undefined);
    mockStat.mockResolvedValue({ mtimeMs: 1, size: 0 } as any);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([]);
    __resetSessionFileReadGrantsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists all accessible Windows drive roots when browsing :drives: on Windows', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockReaddir.mockImplementation(async (dir: any) => {
      if (dir === 'C:\\' || dir === 'D:\\') return [] as any;
      throw new Error('ENOENT');
    });

    try {
      handleWebCommand({ type: 'fs.ls', path: ':drives:', requestId: 'req-win-drives' }, mockServerLink as any);
      await flushAsync();
      expect(sent[0]).toMatchObject({
        type: 'fs.ls_response',
        requestId: 'req-win-drives',
        status: 'ok',
        resolvedPath: '__imcodes_windows_drives__',
      });
      expect((sent[0] as any).entries).toEqual([
        { name: 'C:\\', path: 'C:\\', isDir: true, hidden: false },
        { name: 'D:\\', path: 'D:\\', isDir: true, hidden: false },
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('expands ~ to home directory on Windows (NOT to drives list)', async () => {
    // Regression: ~ must always mean home, not drives.
    // Drives are accessed via the explicit `:drives:` sentinel.
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const home = homedir();
    mockRealpath.mockResolvedValue(home as unknown as string);
    mockReaddir.mockResolvedValue([makeDirent('Documents', true), makeDirent('Desktop', true)] as any);

    try {
      handleWebCommand({ type: 'fs.ls', path: '~', requestId: 'req-win-home' }, mockServerLink as any);
      await flushAsync();
      const resp = sent[0] as any;
      expect(resp.status).toBe('ok');
      // Should be home, NOT __imcodes_windows_drives__
      expect(resp.resolvedPath).toBe(home);
      expect(resp.resolvedPath).not.toBe('__imcodes_windows_drives__');
      expect(resp.entries.map((e: any) => e.name)).toEqual(expect.arrayContaining(['Documents', 'Desktop']));
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('expands ~ to home directory on Linux', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const home = homedir();
    mockRealpath.mockResolvedValue(home as unknown as string);
    mockReaddir.mockResolvedValue([makeDirent('projects', true)] as any);

    try {
      handleWebCommand({ type: 'fs.ls', path: '~', requestId: 'req-lin-home' }, mockServerLink as any);
      await flushAsync();
      const resp = sent[0] as any;
      expect(resp.status).toBe('ok');
      expect(resp.resolvedPath).toBe(home);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('confines shared-session directory browsing to the owning project root', async () => {
    const projectDir = path.join(homedir(), 'project');
    const outsideDir = path.join(homedir(), 'other');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.ls',
      path: outsideDir,
      requestId: 'req-session-outside',
      sessionName: 'deck_project_brain',
    }, mockServerLink as any);
    await flushAsync();

    expect(mockReaddir).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'req-session-outside',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('resolves the virtual shared-session root without requiring projectDir in the browser payload', async () => {
    const projectDir = path.join(homedir(), 'private-project');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockRealpath.mockImplementation(async (target) => String(target));
    mockReaddir.mockResolvedValue([makeDirent('src', true)] as any);

    handleWebCommand({
      type: 'fs.ls',
      path: FS_SESSION_ROOT_PATH,
      requestId: 'req-session-root',
      sessionName: 'deck_project_brain',
    }, mockServerLink as any);
    await flushAsync();

    expect(mockReaddir).toHaveBeenCalledWith(projectDir, { withFileTypes: true });
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'req-session-root',
      path: FS_SESSION_ROOT_PATH,
      resolvedPath: projectDir,
      status: 'ok',
      entries: [expect.objectContaining({ name: 'src', isDir: true })],
    });
  });

  it('confines shared-session file previews to the owning project root', async () => {
    const projectDir = path.join(homedir(), 'project');
    const outsideFile = path.join(homedir(), 'other', 'secret.png');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockRealpath.mockImplementation(async (target) => String(target));
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false } as fsp.Stats);

    handleWebCommand({
      type: 'fs.read',
      path: outsideFile,
      requestId: 'read-session-outside',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'read-session-outside',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('allows an exact live registered upload with trusted same-session upload binding on both regular and chat read branches', async () => {
    const projectDir = path.join(homedir(), 'project');
    const uploadRoot = path.join(homedir(), '.imcodes', 'uploads');
    const uploadPath = path.join(uploadRoot, '392836a75fc67a4ff38c2dcedc9afe32.png');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockLookupAttachment.mockReturnValue({
      id: path.basename(uploadPath),
      daemonPath: uploadPath,
      source: 'upload',
      sessionName: 'deck_project_brain',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    const sharedActor = {
      origin: 'shared-tab',
      effectiveActorRole: 'participant',
      snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
    };

    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-shared-upload-regular',
      sessionName: 'deck_project_brain',
      sharedActor,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-shared-upload-chat',
      sessionName: 'deck_project_brain',
      chatFileReference: true,
      sharedActor,
    }, mockServerLink as any);
    await flushAsync();

    expect(sent).toEqual([]);
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(uploadPath, 'read-shared-upload-regular', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(uploadPath, 'read-shared-upload-chat', expect.any(Function));
  });

  it('rejects cross-session uploads, unbound legacy entries, and process/transport timeline text or legacy attachments for non-server shares while preserving owner and whole-server previews', async () => {
    const projectDirA = path.join(homedir(), 'project-a');
    const projectDirB = path.join(homedir(), 'project-b');
    const uploadRoot = path.join(homedir(), '.imcodes', 'uploads');
    const crossSessionUploadPath = path.join(uploadRoot, '992836a75fc67a4ff38c2dcedc9afe99.png');
    const unboundLegacyUploadPath = path.join(uploadRoot, '772836a75fc67a4ff38c2dcedc9afe77.png');
    vi.spyOn(sessionStore, 'getSession').mockImplementation((name) => {
      if (name === 'deck_session_a') return { name: 'deck_session_a', projectDir: projectDirA } as never;
      if (name === 'deck_session_b') return { name: 'deck_session_b', projectDir: projectDirB } as never;
      return undefined;
    });
    // Simulate both a real process user.message (no sharedActor) and a transport
    // user.message mentioning foreign/legacy uploads — neither may mint read access.
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockImplementation(async (targetSession) => {
      if (targetSession === 'deck_session_b') {
        return [
          {
            eventId: 'process-user-msg-no-shared-actor',
            sessionId: 'deck_session_b',
            ts: Date.now(),
            seq: 1,
            epoch: 1,
            source: 'daemon',
            confidence: 'high',
            type: 'user.message',
            payload: {
              text: `#1:(${unboundLegacyUploadPath}) #2:(${crossSessionUploadPath})`,
              attachments: [
                { id: path.basename(unboundLegacyUploadPath), daemonPath: unboundLegacyUploadPath },
                { id: path.basename(crossSessionUploadPath), daemonPath: crossSessionUploadPath },
              ],
            },
          },
          {
            eventId: 'transport-user-msg-with-shared-actor',
            sessionId: 'deck_session_b',
            ts: Date.now(),
            seq: 2,
            epoch: 1,
            source: 'daemon',
            confidence: 'high',
            type: 'user.message',
            payload: {
              text: `#1:(${unboundLegacyUploadPath})`,
              sharedActor: {
                origin: 'shared-tab',
                effectiveActorRole: 'participant',
                snapshot: { target: { kind: 'session', sessionName: 'deck_session_b' } },
              },
            },
          },
        ] as never;
      }
      return [] as never;
    });
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    const sharedActorB = {
      origin: 'shared-tab',
      effectiveActorRole: 'participant',
      snapshot: { target: { kind: 'session', sessionName: 'deck_session_b' } },
    };

    // 1) Cross-session entry bound to deck_session_a is rejected on deck_session_b across both branches.
    mockLookupAttachment.mockImplementation((target: string) => (
      target === crossSessionUploadPath
        ? {
            id: path.basename(crossSessionUploadPath),
            daemonPath: crossSessionUploadPath,
            source: 'upload',
            sessionName: 'deck_session_a',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          }
        : target === unboundLegacyUploadPath
          ? {
              id: path.basename(unboundLegacyUploadPath),
              daemonPath: unboundLegacyUploadPath,
              source: 'upload',
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            }
          : undefined
    ));

    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-cross-session-regular',
      sessionName: 'deck_session_b',
      sharedActor: sharedActorB,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-cross-session-chat',
      sessionName: 'deck_session_b',
      chatFileReference: true,
      sharedActor: sharedActorB,
    }, mockServerLink as any);
    // 2) Unbound legacy upload entry (no sessionName) is also rejected for shared-tab across both branches.
    handleWebCommand({
      type: 'fs.read',
      path: unboundLegacyUploadPath,
      requestId: 'read-unbound-legacy-regular',
      sessionName: 'deck_session_b',
      sharedActor: sharedActorB,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: unboundLegacyUploadPath,
      requestId: 'read-unbound-legacy-chat',
      sessionName: 'deck_session_b',
      chatFileReference: true,
      sharedActor: sharedActorB,
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({ type: 'fs.read_response', requestId: 'read-cross-session-regular', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
      expect.objectContaining({ type: 'fs.read_response', requestId: 'read-cross-session-chat', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
      expect.objectContaining({ type: 'fs.read_response', requestId: 'read-unbound-legacy-regular', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
      expect.objectContaining({ type: 'fs.read_response', requestId: 'read-unbound-legacy-chat', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
    ]);

    // 3) Owner legacy session preview (no sharedActor, unbound entry) and whole-server reads remain preserved.
    sent.length = 0;
    handleWebCommand({
      type: 'fs.read',
      path: unboundLegacyUploadPath,
      requestId: 'read-owner-legacy-chat',
      sessionName: 'deck_session_b',
      chatFileReference: true,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-whole-server-upload',
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-shared-server-upload',
      sharedActor: {
        origin: 'shared-server',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'server', serverId: 'srv-1' } },
      },
    }, mockServerLink as any);
    await flushAsync();
    expect(sent).toEqual([]);
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(unboundLegacyUploadPath, 'read-owner-legacy-chat', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(crossSessionUploadPath, 'read-whole-server-upload', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(crossSessionUploadPath, 'read-shared-server-upload', expect.any(Function));

    // 4) Owner and whole-server share participant can read cross-session registered uploads even when another sessionName is passed.
    sent.length = 0;
    mockPreviewCoordinator.handle.mockClear();
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-owner-cross-session-regular',
      sessionName: 'deck_session_b',
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-owner-cross-session-chat',
      sessionName: 'deck_session_b',
      chatFileReference: true,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-shared-server-cross-session-regular',
      sessionName: 'deck_session_b',
      sharedActor: {
        origin: 'shared-server',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'server', serverId: 'srv-1' } },
      },
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: crossSessionUploadPath,
      requestId: 'read-shared-server-cross-session-chat',
      sessionName: 'deck_session_b',
      chatFileReference: true,
      sharedActor: {
        origin: 'shared-server',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'server', serverId: 'srv-1' } },
      },
    }, mockServerLink as any);
    await flushAsync();
    expect(sent).toEqual([]);
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(crossSessionUploadPath, 'read-owner-cross-session-regular', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(crossSessionUploadPath, 'read-owner-cross-session-chat', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(crossSessionUploadPath, 'read-shared-server-cross-session-regular', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(crossSessionUploadPath, 'read-shared-server-cross-session-chat', expect.any(Function));
  });

  it('stamps sharedActor onto process user.message and blocks @upload attachment smuggling across sessions', async () => {
    const projectDirB = path.join(homedir(), 'project-proc-b');
    const uploadRoot = path.join(homedir(), '.imcodes', 'uploads');
    const foreignUpload = path.join(uploadRoot, '112836a75fc67a4ff38c2dcedc9afe11.txt');
    const sameSessionUpload = path.join(uploadRoot, '222836a75fc67a4ff38c2dcedc9afe22.txt');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({
      name: 'deck_proc_b',
      projectName: 'proj-b',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      projectDir: projectDirB,
      state: 'idle',
    } as never);
    mockLookupAttachment.mockImplementation((target: string) => {
      if (target === foreignUpload) {
        return {
          id: path.basename(foreignUpload),
          daemonPath: foreignUpload,
          source: 'upload',
          sessionName: 'deck_proc_a',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
      }
      if (target === sameSessionUpload) {
        return {
          id: path.basename(sameSessionUpload),
          daemonPath: sameSessionUpload,
          source: 'upload',
          sessionName: 'deck_proc_b',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
      }
      return undefined;
    });
    const emitSpy = vi.spyOn(timelineEmitter, 'emit');
    const sharedActor = {
      origin: 'shared-tab',
      effectiveActorRole: 'participant',
      snapshot: { target: { kind: 'session', sessionName: 'deck_proc_b' } },
    };

    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proc_b',
      commandId: 'cmd-proc-shared-1',
      text: `@${foreignUpload} @${sameSessionUpload} hello`,
      sharedActor,
    }, mockServerLink as any);
    await flushAsync();

    const userEventCall = emitSpy.mock.calls.find(
      ([session, type]) => session === 'deck_proc_b' && type === 'user.message',
    );
    expect(userEventCall).toBeDefined();
    expect(userEventCall?.[2]).toMatchObject({
      sharedActor,
      attachments: [expect.objectContaining({ id: path.basename(sameSessionUpload), daemonPath: sameSessionUpload })],
    });
    expect((userEventCall?.[2] as { attachments?: Array<{ daemonPath?: string }> }).attachments)
      .not.toContainEqual(expect.objectContaining({ daemonPath: foreignUpload }));
  });

  it('allows an assistant-published upload only in the publishing session across both read branches', async () => {
    const projectDirA = path.join(homedir(), 'project-a');
    const projectDirB = path.join(homedir(), 'project-b');
    const uploadRoot = path.join(homedir(), '.imcodes', 'uploads');
    const uploadPath = path.join(uploadRoot, '552836a75fc67a4ff38c2dcedc9afe55.pdf');
    vi.spyOn(sessionStore, 'getSession').mockImplementation((name) => {
      if (name === 'deck_pub_a') return { name: 'deck_pub_a', projectDir: projectDirA } as never;
      if (name === 'deck_pub_b') return { name: 'deck_pub_b', projectDir: projectDirB } as never;
      return undefined;
    });
    mockLookupAttachment.mockReturnValue({
      id: path.basename(uploadPath),
      daemonPath: uploadPath,
      source: 'upload',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockImplementation(async (targetSession) => {
      if (targetSession === 'deck_pub_a') {
        return [{
          eventId: 'assistant-published-upload',
          sessionId: 'deck_pub_a',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: `导出完成：\`${uploadPath}\`` },
        }] as never;
      }
      return [] as never;
    });
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    const sharedActorA = {
      origin: 'shared-tab',
      effectiveActorRole: 'participant',
      snapshot: { target: { kind: 'session', sessionName: 'deck_pub_a' } },
    };
    const sharedActorB = {
      origin: 'shared-tab',
      effectiveActorRole: 'participant',
      snapshot: { target: { kind: 'session', sessionName: 'deck_pub_b' } },
    };

    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-pub-b-regular',
      sessionName: 'deck_pub_b',
      sharedActor: sharedActorB,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-pub-b-chat',
      sessionName: 'deck_pub_b',
      chatFileReference: true,
      sharedActor: sharedActorB,
    }, mockServerLink as any);
    await flushAsync();
    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'fs.read_response',
        requestId: 'read-pub-b-regular',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
      }),
      expect.objectContaining({
        type: 'fs.read_response',
        requestId: 'read-pub-b-chat',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
      }),
    ]);

    sent.length = 0;
    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-pub-a-regular',
      sessionName: 'deck_pub_a',
      sharedActor: sharedActorA,
    }, mockServerLink as any);
    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-pub-a-chat',
      sessionName: 'deck_pub_a',
      chatFileReference: true,
      sharedActor: sharedActorA,
    }, mockServerLink as any);
    await flushAsync();
    expect(sent).toEqual([]);
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(uploadPath, 'read-pub-a-regular', expect.any(Function));
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(uploadPath, 'read-pub-a-chat', expect.any(Function));
  });

  it('keeps unregistered files in the upload directory outside shared-session reach', async () => {
    const projectDir = path.join(homedir(), 'project');
    const uploadPath = path.join(homedir(), '.imcodes', 'uploads', 'not-registered.png');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: uploadPath,
      requestId: 'read-unregistered-upload',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'read-unregistered-upload',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('previews one exact standalone file path published by the assistant in the shared session', async () => {
    const projectDir = path.join(homedir(), 'project');
    const publishedFile = path.join(homedir(), 'worktrees', 'release', 'public', 'templates', '承诺书.pdf');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'assistant-file-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: `文件已生成：\n${publishedFile}` },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: publishedFile,
      requestId: 'read-assistant-published-file',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(sent).toEqual([]);
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(
      publishedFile,
      'read-assistant-published-file',
      expect.any(Function),
    );
  });

  it('previews one exact out-of-project file published as a hidden-path Markdown link', async () => {
    const projectDir = path.join(homedir(), 'project');
    const publishedFile = path.join(homedir(), '交付包', '企享云外贸财税申报管理系统_代码.pdf');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'assistant-markdown-file-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: `[企享云外贸财税申报管理系统_代码.pdf](${publishedFile})` },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: publishedFile,
      requestId: 'read-assistant-markdown-file',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(sent).toEqual([]);
    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(
      publishedFile,
      'read-assistant-markdown-file',
      expect.any(Function),
    );
  });

  it('resolves an assistant relative reference daemon-side and returns the actual path metadata', async () => {
    const projectDir = path.join(homedir(), 'project');
    const resolvedFile = path.join(projectDir, 'dist', '报告.pdf');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({
      name: 'deck_project_brain', projectName: 'project', role: 'brain', projectDir,
    } as never);
    vi.spyOn(sessionStore, 'listSessions').mockReturnValue([]);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'assistant-relative-file-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(), seq: 1, epoch: 1, source: 'daemon', confidence: 'high',
      type: 'assistant.text',
      payload: { text: '[报告](dist/报告.pdf)' },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));
    mockPreviewCoordinator.handle.mockImplementation((realPath, requestId, send) => {
      send({ type: 'fs.read_response', requestId, path: realPath, status: 'ok', downloadId: 'dl-relative' });
    });

    handleWebCommand({
      type: 'fs.read', path: 'dist/报告.pdf', requestId: 'read-relative-chat-file',
      sessionName: 'deck_project_brain', chatFileReference: true,
    }, mockServerLink as any);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(
      resolvedFile,
      'read-relative-chat-file',
      expect.any(Function),
    );
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'fs.read_response', requestId: 'read-relative-chat-file', path: 'dist/报告.pdf',
      resolvedPath: resolvedFile, resolutionMatchCount: 1, downloadId: 'dl-relative',
    }));
  });

  it('still downloads an existing in-project file when only tool output mentioned it, not the assistant', async () => {
    // Pre-existing (pre-chatFileReference) behavior: any real file already
    // inside the session's own project root was downloadable without any
    // assistant grant. tool.call/tool.result text and ChatView's own
    // splitPathsAndUrls plain-text renderer never mint a grant (by design:
    // session-file-read-grants.ts only ingests assistant.text), yet the web
    // client now marks EVERY download click chatFileReference:true, including
    // clicks on paths rendered from tool output. That must not regress an
    // in-project download into forbidden_path just because it lacks a grant.
    const projectDir = path.join(homedir(), 'project');
    const toolOnlyFile = path.join(projectDir, 'dist', 'report.pdf');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({
      name: 'deck_project_brain', projectName: 'project', role: 'brain', projectDir,
    } as never);
    vi.spyOn(sessionStore, 'listSessions').mockReturnValue([]);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'tool-result-only',
      sessionId: 'deck_project_brain',
      ts: Date.now(), seq: 1, epoch: 1, source: 'daemon', confidence: 'high',
      type: 'tool.result',
      payload: { text: `wrote ${toolOnlyFile}` },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));
    mockPreviewCoordinator.handle.mockImplementation((realPath, requestId, send) => {
      send({ type: 'fs.read_response', requestId, path: realPath, status: 'ok', downloadId: 'dl-in-project' });
    });

    handleWebCommand({
      type: 'fs.read', path: toolOnlyFile, requestId: 'read-in-project-chat-file',
      sessionName: 'deck_project_brain', chatFileReference: true,
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(
      toolOnlyFile,
      'read-in-project-chat-file',
      expect.any(Function),
    );
    expect(sent).not.toContainEqual(expect.objectContaining({ status: 'error' }));
  });

  it('never authorizes a sensitive ~/.ssh file even when the assistant publishes its exact path', async () => {
    const projectDir = path.join(homedir(), 'project');
    const sensitiveFile = path.join(homedir(), '.ssh', 'id_rsa');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'assistant-sensitive-file-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: sensitiveFile },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: sensitiveFile,
      requestId: 'read-assistant-published-sensitive-file',
      sessionName: 'deck_project_brain',
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'read-assistant-published-sensitive-file',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('does not grant neighboring paths or paths written only by a participant', async () => {
    const projectDir = path.join(homedir(), 'project');
    const mentionedFile = path.join(homedir(), 'worktrees', 'release', 'public', 'templates', '承诺书.pdf');
    const neighboringFile = path.join(path.dirname(mentionedFile), '其他合同.pdf');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'participant-file-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'user.message',
      payload: { text: `打开 \`${neighboringFile}\`` },
    }, {
      eventId: 'assistant-other-file-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(),
      seq: 2,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: `已提供：\`${mentionedFile}\`` },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: neighboringFile,
      requestId: 'read-neighboring-file',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'read-neighboring-file',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('does not turn an assistant-published directory into a readable root', async () => {
    const projectDir = path.join(homedir(), 'project');
    const publishedDirectory = path.join(homedir(), 'worktrees', 'release', 'public', 'templates');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([{
      eventId: 'assistant-directory-path',
      sessionId: 'deck_project_brain',
      ts: Date.now(),
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: `模板目录：\`${publishedDirectory}\`` },
    }] as never);
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => false } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: publishedDirectory,
      requestId: 'read-assistant-published-directory',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'read-assistant-published-directory',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('rejects an upload-labeled registry entry outside the daemon upload root', async () => {
    const projectDir = path.join(homedir(), 'project');
    const outsidePath = path.join(homedir(), 'other', 'registry-poisoned.png');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockLookupAttachment.mockReturnValue({
      id: path.basename(outsidePath),
      daemonPath: outsidePath,
      source: 'upload',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(fsp.lstat).mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'fs.read',
      path: outsidePath,
      requestId: 'read-poisoned-upload',
      sessionName: 'deck_project_brain',
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName: 'deck_project_brain' } },
      },
    }, mockServerLink as any);
    await flushAsync();

    expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'read-poisoned-upload',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('confines shared-session file search to the owning project root', async () => {
    const projectDir = path.join(homedir(), 'project');
    const outsideDir = path.join(homedir(), 'other');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({
      type: 'file.search',
      query: 'secret',
      projectDir: outsideDir,
      requestId: 'search-session-outside',
      sessionName: 'deck_project_brain',
    }, mockServerLink as any);
    await flushAsync();

    expect(mockReaddir).not.toHaveBeenCalled();
    expect(sent[0]).toEqual({
      type: 'file.search_response',
      requestId: 'search-session-outside',
      results: [],
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('resolves the virtual shared-session root for file search', async () => {
    const projectDir = path.join(homedir(), 'private-search-project');
    vi.spyOn(sessionStore, 'getSession').mockReturnValue({ name: 'deck_project_brain', projectDir } as never);
    mockRealpath.mockImplementation(async (target) => String(target));
    mockReaddir.mockImplementation(async (target) => (
      String(target) === projectDir ? [makeDirent('README.md', false)] as any : [] as any
    ));

    handleWebCommand({
      type: 'file.search',
      query: '',
      projectDir: FS_SESSION_ROOT_PATH,
      requestId: 'search-session-root',
      sessionName: 'deck_project_brain',
    }, mockServerLink as any);
    await flushAsync();

    expect(mockReaddir).toHaveBeenCalledWith(projectDir, { withFileTypes: true });
    expect(sent[0]).toEqual({
      type: 'file.search_response',
      requestId: 'search-session-root',
      results: ['README.md'],
    });
  });

  it(':drives: sentinel returns error on non-Windows platforms', async () => {
    // The drives sentinel should not be a magic root on Linux/Mac;
    // it should fall through to normal path handling and fail safely.
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockRealpath.mockRejectedValue(new Error('ENOENT'));

    try {
      handleWebCommand({ type: 'fs.ls', path: ':drives:', requestId: 'req-lin-drives' }, mockServerLink as any);
      await flushAsync();
      const resp = sent[0] as any;
      expect(resp.status).toBe('error');
      // Must NOT pretend drives exist on non-Windows
      expect(resp.resolvedPath).not.toBe('__imcodes_windows_drives__');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('returns forbidden_path for denied directories like ~/.ssh', async () => {
    const denied = path.join(homedir(), '.ssh');
    mockRealpath.mockResolvedValue(denied as unknown as string);

    handleWebCommand({ type: 'fs.ls', path: denied, requestId: 'req-1' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'req-1',
      status: 'error',
      error: 'forbidden_path',
    });
  });

  it('lists directories only when includeFiles is false', async () => {
    const testDir = path.join(homedir(), 'test-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('src', true),
      makeDirent('README.md', false),
      makeDirent('.git', true),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-2', includeFiles: false }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries.map((e: any) => e.name)).toEqual(['src', '.git']);
    // README.md should not appear
    expect(resp.entries.every((e: any) => e.isDir)).toBe(true);
  });

  it('optionally attaches OpenSpec task stats while preserving plain fs.ls behavior', async () => {
    const changesDir = path.join(homedir(), 'repo', 'openspec', 'changes');
    mockRealpath.mockResolvedValue(changesDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('change-a', true),
      makeDirent('change-b', true),
      makeDirent('notes.md', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockReadFile.mockImplementation(async (target) => {
      const value = String(target);
      if (value.endsWith(path.join('change-a', 'tasks.md'))) {
        return [
          '- [x] Completed task',
          '- [ ] Remaining task',
          '```md',
          '- [ ] ignored fenced checkbox',
          '```',
        ].join('\n') as any;
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    handleWebCommand({ type: 'fs.ls', path: changesDir, requestId: 'req-openspec-plain', includeFiles: false }, mockServerLink as any);
    await flushAsync();
    expect((sent[0] as any).entries.every((entry: any) => entry.openSpecTaskStats === undefined)).toBe(true);
    expect(mockReadFile).not.toHaveBeenCalled();

    handleWebCommand({
      type: 'fs.ls',
      path: changesDir,
      requestId: 'req-openspec-tasks',
      includeFiles: false,
      includeOpenSpecTaskStats: true,
    }, mockServerLink as any);
    await flushAsync();

    const resp = sent[1] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries.find((entry: any) => entry.name === 'change-a').openSpecTaskStats).toEqual({
      total: 2,
      checked: 1,
      unchecked: 1,
    });
    expect(resp.entries.find((entry: any) => entry.name === 'change-b').openSpecTaskStats).toEqual({
      total: 0,
      checked: 0,
      unchecked: 0,
    });
  });

  it('isolates includeSymlinkNames in cache keys and excludes symlink names from default/scoped fs.ls', async () => {
    const projectsDir = path.join(homedir(), 'symlink-isolated-projects');
    mockRealpath.mockResolvedValue(projectsDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('real_proj', true),
      makeDirent('wu_lun', false, true),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: projectsDir, requestId: 'req-plain-sym', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    expect((sent[0] as any).entries.map((e: any) => e.name)).toEqual(['real_proj']);

    handleWebCommand({
      type: 'fs.ls',
      path: projectsDir,
      requestId: 'req-sym-names',
      includeFiles: true,
      includeSymlinkNames: true,
    }, mockServerLink as any);
    await flushAsync();
    expect((sent[1] as any).entries.map((e: any) => e.name)).toEqual(['real_proj', 'wu_lun']);

    // Plain fs.ls after includeSymlinkNames query still omits symlink entries
    handleWebCommand({ type: 'fs.ls', path: projectsDir, requestId: 'req-plain-sym-2', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    expect((sent[2] as any).entries.map((e: any) => e.name)).toEqual(['real_proj']);

    // Shared-tab scoped request must ignore includeSymlinkNames
    const getSessionSpy = vi.spyOn(sessionStore, 'getSession').mockReturnValue({
      name: 'deck_tab_main',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
      projectDir: projectsDir,
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });
    try {
      handleWebCommand({
        type: 'fs.ls',
        sessionName: 'deck_tab_main',
        path: projectsDir,
        requestId: 'req-tab-sym-ignored',
        includeFiles: true,
        includeSymlinkNames: true,
        sharedActor: {
          actorUserId: 'viewer-1',
          origin: 'shared-tab',
          snapshot: { target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_tab_main' }, effectiveRole: 'viewer' },
        },
      }, mockServerLink as any);
      await flushAsync();
      expect((sent[3] as any).entries.map((e: any) => e.name)).toEqual(['real_proj']);
    } finally {
      getSessionSpy.mockRestore();
    }
  });

  it('keeps non-preview fs.ls responsive while preview worker slots are blocked', async () => {
    const testDir = path.join(homedir(), 'responsive-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([makeDirent('src', true)] as unknown as fsp.Dirent<string>[]);
    const blockedPreviewReads: Array<{ path: unknown; requestId: unknown }> = [];
    mockPreviewCoordinator.handle.mockImplementation((previewPath: unknown, requestId: unknown) => {
      blockedPreviewReads.push({ path: previewPath, requestId });
    });

    handleWebCommand({ type: 'fs.read', path: path.join(testDir, 'huge.bin'), requestId: 'read-pending' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.read', path: path.join(testDir, 'huge-2.bin'), requestId: 'read-pending-2' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'ls-responsive', includeFiles: false }, mockServerLink as any);
    await flushAsync();

    expect(blockedPreviewReads).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'ls-responsive',
      status: 'ok',
      entries: [{ name: 'src', isDir: true }],
    });
  });

  it('reuses a hot directory listing cache for repeated requests', async () => {
    const testDir = path.join(homedir(), 'cached-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('src', true),
      makeDirent('README.md', false),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-cache-1', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-cache-2', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    expect(mockReaddir).toHaveBeenCalledTimes(1);
    expect((sent[0] as any).status).toBe('ok');
    expect((sent[1] as any).status).toBe('ok');
    expect((sent[1] as any).entries.map((e: any) => e.name)).toEqual(['src', 'README.md']);
  });

  it('includes files when includeFiles is true', async () => {
    const testDir = path.join(homedir(), 'test-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('src', true),
      makeDirent('README.md', false),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-3', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    const names = resp.entries.map((e: any) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
  });

  it('includes downloadId for allowed files when includeMetadata is true', async () => {
    const testDir = path.join(homedir(), 'metadata-allowed-dir');
    const filePath = path.join(testDir, 'README.md');
    mockRealpath.mockImplementation(async (target) => String(target));
    mockReaddir.mockResolvedValue([
      makeDirent('README.md', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockStat.mockResolvedValue({ size: 42, mtimeMs: 101 } as fsp.Stats);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-meta-allowed', includeFiles: true, includeMetadata: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries).toHaveLength(1);
    expect(resp.entries[0]).toMatchObject({
      name: 'README.md',
      path: filePath,
      size: 42,
      mime: 'text/markdown',
    });
    expect(resp.entries[0].downloadId).toEqual(expect.any(String));
  });

  it('omits downloadId for denied metadata entries without failing the listing', async () => {
    const testDir = path.join(homedir(), 'metadata-denied-dir');
    const filePath = path.join(testDir, 'id_rsa');
    const deniedRealPath = path.join(homedir(), '.ssh', 'id_rsa');
    mockRealpath.mockImplementation(async (target) => {
      const value = String(target);
      if (value === filePath) return deniedRealPath;
      return value;
    });
    mockReaddir.mockResolvedValue([
      makeDirent('id_rsa', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockStat.mockResolvedValue({ size: 99, mtimeMs: 202 } as fsp.Stats);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-meta-denied', includeFiles: true, includeMetadata: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries).toHaveLength(1);
    expect(resp.entries[0]).toMatchObject({
      name: 'id_rsa',
      path: filePath,
      size: 99,
    });
    expect(resp.entries[0].downloadId).toBeUndefined();
  });

  it('omits downloadId for Windows realpath fallback entries without failing the listing', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const testDir = path.join(homedir(), 'metadata-fallback-dir');
    mockRealpath.mockRejectedValue(new Error('expected reparse fallback'));
    mockReaddir.mockResolvedValue([
      makeDirent('fallback.txt', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockStat.mockResolvedValue({ size: 7, mtimeMs: 303 } as fsp.Stats);

    try {
      handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-meta-fallback', includeFiles: true, includeMetadata: true }, mockServerLink as any);
      await flushAsync();

      const resp = sent[0] as any;
      expect(resp.status).toBe('ok');
      expect(resp.entries).toHaveLength(1);
      expect(resp.entries[0]).toMatchObject({
        name: 'fallback.txt',
        size: 7,
      });
      expect(resp.entries[0].downloadId).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('fails closed for Windows realpath fallback when includeMetadata is false', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const testDir = path.join(homedir(), 'plain-fallback-dir');
    mockRealpath.mockRejectedValue(new Error('expected reparse fallback'));
    mockReaddir.mockResolvedValue([
      makeDirent('fallback.txt', false),
    ] as unknown as fsp.Dirent<string>[]);

    try {
      handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-plain-fallback', includeFiles: true, includeMetadata: false }, mockServerLink as any);
      await flushAsync();

      expect(mockReaddir).not.toHaveBeenCalled();
      expect(sent[0]).toMatchObject({
        type: 'fs.ls_response',
        requestId: 'req-plain-fallback',
        status: 'error',
        error: 'forbidden_path',
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('sorts: directories first, hidden last within each group', async () => {
    const testDir = path.join(homedir(), 'sorted-test');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('b-file.txt', false),
      makeDirent('.hidden-file', false),
      makeDirent('z-dir', true),
      makeDirent('.hidden-dir', true),
      makeDirent('a-dir', true),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-4', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    const names: string[] = resp.entries.map((e: any) => e.name);
    // dirs before files
    const firstFileIdx = names.findIndex((n: string) => !resp.entries[names.indexOf(n)].isDir);
    const lastDirIdx = [...resp.entries].reverse().findIndex((e: any) => e.isDir);
    const lastDirActualIdx = resp.entries.length - 1 - lastDirIdx;
    expect(firstFileIdx).toBeGreaterThan(lastDirActualIdx);
    // visible dirs before hidden dirs
    expect(names.indexOf('a-dir')).toBeLessThan(names.indexOf('z-dir'));
    expect(names.indexOf('z-dir')).toBeLessThan(names.indexOf('.hidden-dir'));
  });

  it('returns error when readdir throws', async () => {
    const testDir = path.join(homedir(), 'no-access');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-5' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'req-5',
      status: 'error',
      error: 'EACCES: permission denied',
    });
  });

  it('does not send a late ok response after fs.ls times out', async () => {
    vi.useFakeTimers();
    const testDir = path.join(homedir(), 'slow-dir');
    let resolveReaddir!: (value: fsp.Dirent<string>[]) => void;
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockReturnValue(new Promise((resolve) => {
      resolveReaddir = resolve as (value: fsp.Dirent<string>[]) => void;
    }) as unknown as ReturnType<typeof fsp.readdir>);

    try {
      handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-timeout', includeFiles: true }, mockServerLink as any);
      await vi.advanceTimersByTimeAsync(10_001);
      await Promise.resolve();

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'fs.ls_response',
        requestId: 'req-timeout',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT,
      });

      resolveReaddir([makeDirent('late.txt', false)] as unknown as fsp.Dirent<string>[]);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expands ~ to homedir', async () => {
    const expandedHome = homedir();
    mockRealpath.mockResolvedValue(expandedHome as unknown as string);
    mockReaddir.mockResolvedValue([] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: '~', requestId: 'req-6' }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.resolvedPath).toBe(expandedHome);
    expect(resp.status).toBe('ok');
  });

  it('silently ignores messages missing path or requestId', async () => {
    handleWebCommand({ type: 'fs.ls', path: '/tmp' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.ls', requestId: 'x' }, mockServerLink as any);
    // Small delay — no response should arrive
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
  });

  it('enforces session projectDir for tab-share fs.ls even when only sessionId/parentSession is provided, and fails closed when unresolvable or allowedRoot escapes', async () => {
    const projectDir = path.join(homedir(), 'shared-tab-proj');
    const getSessionSpy = vi.spyOn(sessionStore, 'getSession').mockImplementation((name: string) => (
      name === 'deck_tab_main'
        ? { name: 'deck_tab_main', projectName: 'proj', role: 'brain', agentType: 'codex', state: 'idle', projectDir, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 }
        : undefined
    ));
    try {
      const tabSharedActor = {
        actorUserId: 'viewer-1',
        origin: 'shared-tab',
        snapshot: { target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_tab_main' }, effectiveRole: 'viewer' },
      };

      // Outside path with sessionId only (no sessionName) MUST be blocked
      mockRealpath.mockImplementation(async (p) => String(p) as unknown as string);
      handleWebCommand({
        type: 'fs.ls',
        sessionId: 'deck_tab_main',
        path: homedir(),
        requestId: 'req-tab-escape-1',
        sharedActor: tabSharedActor,
      }, mockServerLink as any);
      await flushAsync();
      expect(sent[0]).toMatchObject({ requestId: 'req-tab-escape-1', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });

      // Client allowedRoot on a non-server share MUST fail closed
      handleWebCommand({
        type: 'fs.ls',
        sessionName: 'deck_tab_main',
        allowedRoot: homedir(),
        path: projectDir,
        requestId: 'req-tab-escape-2',
        sharedActor: tabSharedActor,
      }, mockServerLink as any);
      await flushAsync();
      expect(sent[1]).toMatchObject({ requestId: 'req-tab-escape-2', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });

      // Unknown session on a non-server share MUST fail closed (never skips containment)
      handleWebCommand({
        type: 'fs.ls',
        sessionId: 'deck_unknown',
        path: projectDir,
        requestId: 'req-tab-unknown',
        sharedActor: tabSharedActor,
      }, mockServerLink as any);
      await flushAsync();
      expect(sent[2]).toMatchObject({ requestId: 'req-tab-unknown', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });

      // Legitimate in-project listing using parentSession succeeds
      mockRealpath.mockResolvedValue(projectDir as unknown as string);
      mockReaddir.mockResolvedValue([] as unknown as fsp.Dirent<string>[]);
      handleWebCommand({
        type: 'fs.ls',
        parentSession: 'deck_tab_main',
        path: projectDir,
        requestId: 'req-tab-ok',
        sharedActor: tabSharedActor,
      }, mockServerLink as any);
      await flushAsync();
      expect(sent[3]).toMatchObject({ requestId: 'req-tab-ok', status: 'ok', resolvedPath: projectDir });

      // Whole-server share targetless fs.ls (directory picker) remains allowed
      const expandedHome = homedir();
      mockRealpath.mockResolvedValue(expandedHome as unknown as string);
      handleWebCommand({
        type: 'fs.ls',
        path: expandedHome,
        requestId: 'req-server-picker-ok',
        sharedActor: {
          actorUserId: 'part-1',
          origin: 'shared-server',
          snapshot: { target: { kind: 'server', serverId: 'srv-1' }, effectiveRole: 'participant' },
        },
      }, mockServerLink as any);
      await flushAsync();
      expect(sent[4]).toMatchObject({ requestId: 'req-server-picker-ok', status: 'ok', resolvedPath: expandedHome });
    } finally {
      getSessionSpy.mockRestore();
    }
  });

  it('allows device owners and whole-server shares to read outside-project files with sessionName while preserving tab-share, allowedRoot, sensitive-path, and not-found boundaries', async () => {
    const projectDir = path.join(homedir(), 'owner-proj');
    const allowedSubdir = path.join(projectDir, 'allowed-only');
    const outsideFile = path.join(homedir(), 'Desktop', 'outside-report.pdf');
    const missingOutsideFile = path.join(homedir(), 'Desktop', 'missing-report.pdf');
    const sshKey = path.join(homedir(), '.ssh', 'id_ed25519');
    const gnupgFile = path.join(homedir(), '.gnupg', 'secring.gpg');
    const pkiFile = path.join(homedir(), '.pki', 'nssdb', 'cert9.db');
    const relativeInProject = path.join(projectDir, 'docs', 'spec.md');

    const getSessionSpy = vi.spyOn(sessionStore, 'getSession').mockImplementation((name: string) => (
      name === 'deck_owner_session'
        ? { name: 'deck_owner_session', projectName: 'proj', role: 'brain', agentType: 'codex', state: 'idle', projectDir, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 }
        : undefined
    ));
    vi.spyOn(sessionStore, 'listSessions').mockReturnValue([]);
    const existingFiles = new Set([outsideFile, relativeInProject, sshKey, gnupgFile, pkiFile]);
    const existingDirs = new Set([projectDir]);
    vi.mocked(fsp.lstat).mockImplementation(async (target) => {
      const p = String(target);
      if (existingFiles.has(p)) {
        return { isSymbolicLink: () => false, isFile: () => true } as fsp.Stats;
      }
      if (existingDirs.has(p)) {
        return { isSymbolicLink: () => false, isFile: () => false } as fsp.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockResolvedValue([] as unknown as fsp.Dirent<string>[]);
    mockRealpath.mockImplementation(async (target) => {
      const p = String(target);
      if (existingFiles.has(p) || existingDirs.has(p)) {
        return p;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    try {
      const serverShareActor = {
        actorUserId: 'server-part-1',
        origin: 'shared-server',
        snapshot: { target: { kind: 'server', serverId: 'srv-1' }, effectiveRole: 'participant' },
      };
      const tabShareActor = {
        actorUserId: 'tab-viewer-1',
        origin: 'shared-tab',
        snapshot: { target: { kind: 'session', serverId: 'srv-1', sessionName: 'deck_owner_session' }, effectiveRole: 'viewer' },
      };

      // 1) Owner (no sharedActor) with sessionName reads outside-project file (chatFileReference: true & false) without assistant grant.
      handleWebCommand({
        type: 'fs.read',
        path: outsideFile,
        requestId: 'owner-outside-chat',
        sessionName: 'deck_owner_session',
        chatFileReference: true,
      }, mockServerLink as any);
      handleWebCommand({
        type: 'fs.read',
        path: outsideFile,
        requestId: 'owner-outside-regular',
        sessionName: 'deck_owner_session',
        chatFileReference: false,
      }, mockServerLink as any);
      // Owner relative path still resolves inside session projectDir.
      handleWebCommand({
        type: 'fs.read',
        path: 'docs/spec.md',
        requestId: 'owner-relative-chat',
        sessionName: 'deck_owner_session',
        chatFileReference: true,
      }, mockServerLink as any);

      // 2) Whole-server share participant with sessionName reads outside-project file (both modes).
      handleWebCommand({
        type: 'fs.read',
        path: outsideFile,
        requestId: 'server-share-outside-chat',
        sessionName: 'deck_owner_session',
        chatFileReference: true,
        sharedActor: serverShareActor,
      }, mockServerLink as any);
      handleWebCommand({
        type: 'fs.read',
        path: outsideFile,
        requestId: 'server-share-outside-regular',
        sessionName: 'deck_owner_session',
        sharedActor: serverShareActor,
      }, mockServerLink as any);

      await flushAsync();
      expect(sent).toEqual([]);
      expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(outsideFile, 'owner-outside-chat', expect.any(Function));
      expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(outsideFile, 'owner-outside-regular', expect.any(Function));
      expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(relativeInProject, 'owner-relative-chat', expect.any(Function));
      expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(outsideFile, 'server-share-outside-chat', expect.any(Function));
      expect(mockPreviewCoordinator.handle).toHaveBeenCalledWith(outsideFile, 'server-share-outside-regular', expect.any(Function));

      // 3) Tab-share, explicit allowedRoot, sensitive dirs, and non-existent outside files enforce exact boundaries.
      mockPreviewCoordinator.handle.mockClear();
      handleWebCommand({
        type: 'fs.read',
        path: outsideFile,
        requestId: 'tab-outside-denied',
        sessionName: 'deck_owner_session',
        chatFileReference: true,
        sharedActor: tabShareActor,
      }, mockServerLink as any);
      handleWebCommand({
        type: 'fs.read',
        path: outsideFile,
        requestId: 'owner-allowed-root-denied',
        sessionName: 'deck_owner_session',
        allowedRoot: allowedSubdir,
        chatFileReference: true,
      }, mockServerLink as any);
      for (const [label, sensitive] of [['ssh', sshKey], ['gnupg', gnupgFile], ['pki', pkiFile]] as const) {
        handleWebCommand({
          type: 'fs.read',
          path: sensitive,
          requestId: `owner-sensitive-${label}`,
          sessionName: 'deck_owner_session',
          chatFileReference: true,
        }, mockServerLink as any);
      }
      handleWebCommand({
        type: 'fs.read',
        path: missingOutsideFile,
        requestId: 'owner-outside-missing',
        sessionName: 'deck_owner_session',
        chatFileReference: true,
      }, mockServerLink as any);

      await flushAsync();
      expect(mockPreviewCoordinator.handle).not.toHaveBeenCalled();
      expect(sent).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestId: 'tab-outside-denied', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
        expect.objectContaining({ requestId: 'owner-allowed-root-denied', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
        expect.objectContaining({ requestId: 'owner-sensitive-ssh', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
        expect.objectContaining({ requestId: 'owner-sensitive-gnupg', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
        expect.objectContaining({ requestId: 'owner-sensitive-pki', status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH }),
        expect.objectContaining({ requestId: 'owner-outside-missing', status: 'error', error: FS_GENERIC_ERROR_CODES.PARENT_NOT_FOUND }),
      ]));
    } finally {
      getSessionSpy.mockRestore();
    }
  });
});
