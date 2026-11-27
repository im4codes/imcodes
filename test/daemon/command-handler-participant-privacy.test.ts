import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';

const mockHome = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome.dir || actual.homedir() };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mockHome.dir || actual.homedir() };
});

import {
  handleWebCommand,
  __resetFsGitCachesForTests,
} from '../../src/daemon/command-handler.js';
import {
  createProjectFileHandle,
  handleFileDownload,
  handleFileUpload,
} from '../../src/daemon/file-transfer-handler.js';
import {
  __resetSessionFileReadGrantsForTests,
  recordAssistantFileReadGrants,
} from '../../src/daemon/session-file-read-grants.js';
import * as sessionStore from '../../src/store/session-store.js';

const flushAsync = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 15));
  }
};

function makeParticipantActor(origin: 'shared-tab' | 'shared-server'): SharedActorEnvelope {
  return {
    actorUserId: 'usr-guest',
    actorDisplayName: 'Guest',
    origin,
    effectiveActorRole: 'participant',
    actionId: 'action-1',
    primaryShareId: 'share-1',
    authorizedAt: 1_700_000_000_000,
    queuedAt: 1_700_000_000_000,
    snapshot: {
      ownerUserId: 'usr-owner',
      effectiveRole: 'participant',
      historyCutoffAt: 1_699_999_999_000,
      authorizedAt: 1_700_000_000_000,
      primaryShareId: 'share-1',
      coveringShareIds: ['share-1'],
      expiresAt: null,
      nextCoverageRecheckAt: null,
      target: origin === 'shared-server'
        ? { kind: 'server', serverId: 'srv-1' }
        : { kind: 'main', serverId: 'srv-1', sessionName: 'deck_priv_test' },
    },
  };
}

describe('daemon file API participant privacy guard', () => {
  let rootDir: string;
  let fakeHome: string;
  let projectDir: string;
  let sent: Array<Record<string, unknown>>;
  let serverLink: { send: ReturnType<typeof vi.fn>; sendBinary: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'imcodes-cmd-privacy-')));
    fakeHome = path.join(rootDir, 'home');
    projectDir = path.join(rootDir, 'project');
    mockHome.dir = fakeHome;
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('IMCODES_HOME', path.join(fakeHome, '.imcodes'));

    await mkdir(path.join(fakeHome, '.ssh'), { recursive: true });
    await mkdir(path.join(fakeHome, '.imcodes'), { recursive: true });
    await mkdir(path.join(fakeHome, '.aws'), { recursive: true });
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await mkdir(path.join(projectDir, 'test'), { recursive: true });

    await writeFile(path.join(fakeHome, '.ssh', 'id_ed25519'), 'SECRET-SSH-KEY\n');
    await writeFile(path.join(fakeHome, '.imcodes', 'server.json'), '{"token":"secret"}\n');
    await writeFile(path.join(fakeHome, '.imcodes', 'sessions.json'), '[]\n');
    await writeFile(path.join(fakeHome, '.aws', 'credentials'), '[default]\naws_secret_access_key=abc\n');

    await writeFile(path.join(projectDir, 'src', 'ssh-helper.ts'), 'export const ssh = true;\n');
    await writeFile(path.join(projectDir, 'test', 'keys.test.ts'), 'export const ok = true;\n');
    await writeFile(path.join(projectDir, '.env.example'), 'PORT=3000\n');
    await writeFile(path.join(projectDir, '.netrc'), 'machine example password secret\n');
    await writeFile(path.join(projectDir, 'cert.pem'), '-----BEGIN PRIVATE KEY-----\n');

    await symlink(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(projectDir, 'leak-key'));
    await symlink(path.join(fakeHome, '.imcodes', 'server.json'), path.join(projectDir, 'leak-imcodes'));
    await symlink(path.join(fakeHome, '.aws'), path.join(projectDir, 'leak-aws-dir'));

    vi.spyOn(sessionStore, 'getSession').mockReturnValue({
      name: 'deck_priv_test',
      projectName: 'priv_test',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    __resetFsGitCachesForTests();

    sent = [];
    serverLink = {
      send: vi.fn((msg: unknown) => { sent.push(msg as Record<string, unknown>); }),
      sendBinary: vi.fn(),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mockHome.dir = '';
    await rm(rootDir, { recursive: true, force: true });
  });

  it.each(['shared-tab', 'shared-server'] as const)(
    'blocks %s participants from fs.read on sensitive paths, traversal, and workspace symlinks',
    async (origin) => {
      const sharedActor = makeParticipantActor(origin);
      const deniedTargets = [
        path.join(fakeHome, '.ssh', 'id_ed25519'),
        path.join(fakeHome, '.imcodes', 'server.json'),
        '../../home/.ssh/id_ed25519',
        '~/.ssh/id_ed25519',
        path.join(projectDir, 'leak-key'),
        path.join(projectDir, 'leak-imcodes'),
        path.join(projectDir, '.netrc'),
        path.join(projectDir, 'cert.pem'),
      ];

      for (let i = 0; i < deniedTargets.length; i += 1) {
        const requestId = `read-${origin}-${i}`;
        handleWebCommand({
          type: 'fs.read',
          requestId,
          sessionName: 'deck_priv_test',
          path: deniedTargets[i],
          sharedActor,
        }, serverLink as never);
      }

      handleWebCommand({
        type: 'fs.read',
        requestId: `read-${origin}-allowed`,
        sessionName: 'deck_priv_test',
        path: path.join(projectDir, 'src', 'ssh-helper.ts'),
        sharedActor,
      }, serverLink as never);

      await vi.waitFor(() => {
        expect(sent.find((m) => m.requestId === `read-${origin}-allowed`)).toBeDefined();
        for (let i = 0; i < deniedTargets.length; i += 1) {
          expect(sent.find((m) => m.requestId === `read-${origin}-${i}`)).toBeDefined();
        }
      });

      for (let i = 0; i < deniedTargets.length; i += 1) {
        const res = sent.find((m) => m.requestId === `read-${origin}-${i}`);
        expect(res, `expected ${deniedTargets[i]} to be blocked`).toMatchObject({
          type: 'fs.read_response',
          status: 'error',
          error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
        });
      }

      const allowedRes = sent.find((m) => m.requestId === `read-${origin}-allowed`);
      expect(allowedRes).toMatchObject({
        type: 'fs.read_response',
        status: 'ok',
        content: 'export const ssh = true;\n',
      });
    },
  );

  it.each(['shared-tab', 'shared-server'] as const)(
    'filters sensitive files and symlinks from fs.ls and file.search for %s participants while leaving owners unaffected',
    async (origin) => {
      const sharedActor = makeParticipantActor(origin);

      // Direct sensitive directory listing blocked
      handleWebCommand({
        type: 'fs.ls',
        requestId: `ls-denied-${origin}`,
        sessionName: 'deck_priv_test',
        path: path.join(projectDir, 'leak-aws-dir'),
        includeFiles: true,
        sharedActor,
      }, serverLink as never);

      // Direct listing of projectDir filters out sensitive entries and symlinks
      handleWebCommand({
        type: 'fs.ls',
        requestId: `ls-proj-${origin}`,
        sessionName: 'deck_priv_test',
        path: projectDir,
        includeFiles: true,
        sharedActor,
      }, serverLink as never);

      // file.search of projectDir filters out .netrc and cert.pem
      handleWebCommand({
        type: 'file.search',
        requestId: `search-proj-${origin}`,
        sessionName: 'deck_priv_test',
        projectDir,
        query: '',
        sharedActor,
      }, serverLink as never);

      // Owner listing & search on same directory sees normal cached entries unaffected
      handleWebCommand({
        type: 'fs.ls',
        requestId: `ls-owner-${origin}`,
        path: projectDir,
        includeFiles: true,
      }, serverLink as never);

      handleWebCommand({
        type: 'file.search',
        requestId: `search-owner-${origin}`,
        projectDir,
        query: '',
      }, serverLink as never);

      await vi.waitFor(() => {
        for (const id of [`ls-denied-${origin}`, `ls-proj-${origin}`, `search-proj-${origin}`, `ls-owner-${origin}`, `search-owner-${origin}`]) {
          expect(sent.find((m) => m.requestId === id)).toBeDefined();
        }
      });

      const deniedLs = sent.find((m) => m.requestId === `ls-denied-${origin}`);
      expect(deniedLs).toMatchObject({
        type: 'fs.ls_response',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
      });

      const participantLs = sent.find((m) => m.requestId === `ls-proj-${origin}`);
      expect(participantLs?.status).toBe('ok');
      const lsNames = (participantLs?.entries as Array<{ name: string }>).map((e) => e.name);
      expect(lsNames).toContain('src');
      expect(lsNames).toContain('.env.example');
      expect(lsNames).not.toContain('.netrc');
      expect(lsNames).not.toContain('cert.pem');
      expect(lsNames).not.toContain('leak-key');
      expect(lsNames).not.toContain('leak-imcodes');
      expect(lsNames).not.toContain('leak-aws-dir');

      const participantSearch = sent.find((m) => m.requestId === `search-proj-${origin}`);
      const searchResults = participantSearch?.results as string[];
      expect(searchResults).toContain('src/ssh-helper.ts');
      expect(searchResults).toContain('test/keys.test.ts');
      expect(searchResults).toContain('.env.example');
      expect(searchResults).not.toContain('.netrc');
      expect(searchResults).not.toContain('cert.pem');

      const ownerLs = sent.find((m) => m.requestId === `ls-owner-${origin}`);
      const ownerLsNames = (ownerLs?.entries as Array<{ name: string }>).map((e) => e.name);
      expect(ownerLsNames).toContain('.netrc');
      expect(ownerLsNames).toContain('cert.pem');

      const ownerSearch = sent.find((m) => m.requestId === `search-owner-${origin}`);
      expect(ownerSearch?.results).toContain('.netrc');
      expect(ownerSearch?.results).toContain('cert.pem');
    },
  );

  it('blocks participant mutations and file transfers targeting sensitive paths while allowing owner access', async () => {
    const sharedActor = makeParticipantActor('shared-server');

    handleWebCommand({
      type: 'fs.write',
      requestId: 'write-priv',
      sessionName: 'deck_priv_test',
      path: path.join(projectDir, '.npmrc'),
      content: '//evil/:_authToken=123',
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.mkdir',
      requestId: 'mkdir-priv',
      sessionName: 'deck_priv_test',
      path: path.join(fakeHome, '.ssh', 'evil'),
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.rename',
      requestId: 'rename-priv',
      sessionName: 'deck_priv_test',
      path: path.join(projectDir, '.env.example'),
      newPath: path.join(projectDir, '.npmrc'),
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.delete',
      requestId: 'delete-priv',
      sessionName: 'deck_priv_test',
      path: path.join(projectDir, 'cert.pem'),
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'file.upload',
      uploadId: 'upload-priv',
      sessionName: 'deck_priv_test',
      filename: 'a'.repeat(32) + '.txt',
      originalName: 'authorized_keys',
      mime: 'text/plain',
      content: Buffer.from('ssh-ed25519 AAAA', 'utf8').toString('base64'),
      destinationDirectory: path.join(fakeHome, '.ssh'),
      sharedActor,
    }, serverLink as never);

    const certPemPath = path.join(projectDir, 'cert.pem');
    const certPemBytes = Buffer.byteLength(await readFile(certPemPath, 'utf8'));
    const localSensitiveHandle = createProjectFileHandle(
      certPemPath as never,
      'cert.pem',
      'application/x-pem-file',
      certPemBytes,
    );
    await handleFileDownload({
      type: 'file.download',
      downloadId: 'dl-priv',
      attachmentId: localSensitiveHandle.id,
      sharedActor,
    }, serverLink as never);

    // Owner read on cert.pem succeeds
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-owner-cert',
      sessionName: 'deck_priv_test',
      path: path.join(projectDir, 'cert.pem'),
    }, serverLink as never);

    await flushAsync();

    expect(sent.find((m) => m.requestId === 'write-priv')).toMatchObject({
      type: 'fs.write_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'mkdir-priv')).toMatchObject({
      type: 'fs.mkdir_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'rename-priv')).toMatchObject({
      type: 'fs.rename_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'delete-priv')).toMatchObject({
      type: 'fs.delete_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.uploadId === 'upload-priv')).toMatchObject({
      type: 'file.upload_error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.downloadId === 'dl-priv')).toMatchObject({
      type: 'file.download_error',
      message: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    const ownerCertContent = await readFile(path.join(projectDir, 'cert.pem'), 'utf8');
    expect(sent.find((m) => m.requestId === 'read-owner-cert')).toMatchObject({
      type: 'fs.read_response',
      status: 'ok',
      content: ownerCertContent,
    });
  });

  it('blocks participant fs.delete and fs.rename on directories containing nested sensitive files or symlinks without mutating disk (F3)', async () => {
    const sharedActor = makeParticipantActor('shared-tab');

    const symlinkDir = path.join(projectDir, 'safe-dir-symlink');
    await mkdir(path.join(symlinkDir, 'nested'), { recursive: true });
    await writeFile(path.join(symlinkDir, 'keep.txt'), 'keep me\n');
    await symlink(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(symlinkDir, 'nested', 'link-key'));

    const npmrcDir = path.join(projectDir, 'safe-dir-npmrc');
    await mkdir(path.join(npmrcDir, 'sub'), { recursive: true });
    await writeFile(path.join(npmrcDir, 'sub', '.npmrc'), '//npm/:_authToken=secret\n');

    const cleanFile = path.join(projectDir, 'clean-file.txt');
    await writeFile(cleanFile, 'safe to delete\n');

    handleWebCommand({
      type: 'fs.delete',
      requestId: 'del-symlink-dir',
      sessionName: 'deck_priv_test',
      path: symlinkDir,
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.rename',
      requestId: 'ren-npmrc-dir',
      sessionName: 'deck_priv_test',
      path: npmrcDir,
      newPath: path.join(projectDir, 'renamed-dir'),
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.delete',
      requestId: 'del-npmrc-dir-participant',
      sessionName: 'deck_priv_test',
      path: npmrcDir,
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.delete',
      requestId: 'del-clean-file',
      sessionName: 'deck_priv_test',
      path: cleanFile,
      sharedActor,
    }, serverLink as never);

    await flushAsync();

    expect(sent.find((m) => m.requestId === 'del-symlink-dir')).toMatchObject({
      type: 'fs.delete_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'ren-npmrc-dir')).toMatchObject({
      type: 'fs.rename_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'del-npmrc-dir-participant')).toMatchObject({
      type: 'fs.delete_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'del-clean-file')).toMatchObject({
      type: 'fs.delete_response',
      status: 'ok',
    });

    // Disk contents of blocked directories and targets remain intact
    await expect(readFile(path.join(symlinkDir, 'keep.txt'), 'utf8')).resolves.toBe('keep me\n');
    await expect(lstat(path.join(symlinkDir, 'nested', 'link-key'))).resolves.toBeDefined();
    await expect(readFile(path.join(npmrcDir, 'sub', '.npmrc'), 'utf8')).resolves.toContain('_authToken=secret');
    await expect(readFile(path.join(fakeHome, '.ssh', 'id_ed25519'), 'utf8')).resolves.toBe('SECRET-SSH-KEY\n');

    // Owner delete on npmrcDir still succeeds
    handleWebCommand({
      type: 'fs.delete',
      requestId: 'del-npmrc-dir-owner',
      sessionName: 'deck_priv_test',
      path: npmrcDir,
    }, serverLink as never);
    await flushAsync();
    expect(sent.find((m) => m.requestId === 'del-npmrc-dir-owner')).toMatchObject({
      type: 'fs.delete_response',
      status: 'ok',
    });
  });

  it('enforces explicit allowedRoot strictly before upload exemption in fs.read (F4)', async () => {
    const serverParticipant = makeParticipantActor('shared-server');
    const tabParticipant = makeParticipantActor('shared-tab');
    const uploadBytes = Buffer.from('upload body', 'utf8');

    await handleFileUpload({
      type: 'file.upload',
      uploadId: 'up-reg-f4',
      filename: 'b'.repeat(32) + '.txt',
      originalName: 'note.txt',
      mime: 'text/plain',
      size: uploadBytes.length,
      content: uploadBytes.toString('base64'),
      sessionName: 'deck_priv_test',
    }, serverLink as never);

    const uploadDone = sent.find((m) => m.uploadId === 'up-reg-f4') as {
      type?: string;
      attachment?: { daemonPath?: string };
    } | undefined;
    expect(uploadDone?.type).toBe('file.upload_done');
    const registeredUploadPath = uploadDone!.attachment!.daemonPath!;

    const uploadsDir = path.join(fakeHome, '.imcodes', 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const unregisteredUploadPath = path.join(uploadsDir, `${'c'.repeat(32)}.txt`);
    await writeFile(unregisteredUploadPath, 'unregistered upload\n');

    // 1) Explicit allowedRoot=projectDir MUST reject registered upload (never bypasses allowedRoot)
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-reg-with-root',
      sessionName: 'deck_priv_test',
      path: registeredUploadPath,
      allowedRoot: projectDir,
      sharedActor: serverParticipant,
    }, serverLink as never);

    // 2) Explicit allowedRoot=projectDir allows safe sibling inside projectDir
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-proj-with-root',
      sessionName: 'deck_priv_test',
      path: path.join(projectDir, 'src', 'ssh-helper.ts'),
      allowedRoot: projectDir,
      sharedActor: serverParticipant,
    }, serverLink as never);

    // 3) No allowedRoot allows the exact registered session upload for both tab & server participants
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-reg-no-root',
      sessionName: 'deck_priv_test',
      path: registeredUploadPath,
      sharedActor: tabParticipant,
    }, serverLink as never);

    // 4) No allowedRoot still rejects unregistered file inside uploads/ and sensitive ~/.imcodes files
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-unreg-no-root',
      sessionName: 'deck_priv_test',
      path: unregisteredUploadPath,
      sharedActor: tabParticipant,
    }, serverLink as never);
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-server-json',
      sessionName: 'deck_priv_test',
      path: path.join(fakeHome, '.imcodes', 'server.json'),
      sharedActor: tabParticipant,
    }, serverLink as never);

    await vi.waitFor(() => {
      for (const id of ['read-reg-with-root', 'read-proj-with-root', 'read-reg-no-root', 'read-unreg-no-root', 'read-server-json']) {
        expect(sent.find((m) => m.requestId === id)).toBeDefined();
      }
    });

    expect(sent.find((m) => m.requestId === 'read-reg-with-root')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
    expect(sent.find((m) => m.requestId === 'read-proj-with-root')).toMatchObject({
      type: 'fs.read_response',
      status: 'ok',
    });
    expect(sent.find((m) => m.requestId === 'read-reg-no-root')).toMatchObject({
      type: 'fs.read_response',
      status: 'ok',
      content: 'upload body',
    });
    expect(sent.find((m) => m.requestId === 'read-unreg-no-root')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
    expect(sent.find((m) => m.requestId === 'read-server-json')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
  });

  it('rejects fs.rename when projected destination children become protected (F3-R2) and rejects sensitive raw request paths in fs.read (F4-R2)', async () => {
    const sharedActor = makeParticipantActor('shared-tab');

    // F3-R2: projectDir/staged-gh/gh/hosts.yml is safe under staged-gh, but renaming staged-gh -> .config
    // would produce .config/gh/hosts.yml (two-segment protected path)
    const stagedGh = path.join(projectDir, 'staged-gh');
    await mkdir(path.join(stagedGh, 'gh'), { recursive: true });
    await writeFile(path.join(stagedGh, 'gh', 'hosts.yml'), 'github.com:\n');

    handleWebCommand({
      type: 'fs.rename',
      requestId: 'ren-proj-config-gh',
      sessionName: 'deck_priv_test',
      path: stagedGh,
      newPath: path.join(projectDir, '.config'),
      sharedActor,
    }, serverLink as never);

    // F4-R2: Raw requested path containing protected segment ('.ssh/../src/ssh-helper.ts') is rejected even if canonical realPath is safe
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-raw-ssh-traversal',
      sessionName: 'deck_priv_test',
      path: `${projectDir}/.ssh/../src/ssh-helper.ts`,
      sharedActor,
    }, serverLink as never);

    // F4-R2: Raw path traversing through .ssh into registered upload dir is also rejected
    const uploadBytes = Buffer.from('ok upload', 'utf8');
    await handleFileUpload({
      type: 'file.upload',
      uploadId: 'up-f4-r2',
      filename: 'e'.repeat(32) + '.txt',
      originalName: 'ok.txt',
      mime: 'text/plain',
      size: uploadBytes.length,
      content: uploadBytes.toString('base64'),
      sessionName: 'deck_priv_test',
    }, serverLink as never);
    const upDone = sent.find((m) => m.uploadId === 'up-f4-r2') as { attachment?: { daemonPath?: string } };
    const safeUploadPath = upDone.attachment!.daemonPath!;

    const relUploadPath = path.relative(path.join(fakeHome, '.imcodes', 'uploads'), safeUploadPath);
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-upload-ssh-traversal',
      sessionName: 'deck_priv_test',
      path: `${fakeHome}/.ssh/../.imcodes/uploads/${relUploadPath}`,
      sharedActor,
    }, serverLink as never);

    // F4-R2 counterexample: protected request filename ('authorized_keys') pointing to a safe project file
    // resolves to a safe canonical realPath, yet the protected raw request name MUST still be rejected
    await symlink(path.join(projectDir, 'src', 'ssh-helper.ts'), path.join(projectDir, 'authorized_keys'));
    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-protected-raw-name-to-safe-target',
      sessionName: 'deck_priv_test',
      path: path.join(projectDir, 'authorized_keys'),
      sharedActor,
    }, serverLink as never);

    await vi.waitFor(() => {
      for (const id of ['ren-proj-config-gh', 'read-raw-ssh-traversal', 'read-upload-ssh-traversal', 'read-protected-raw-name-to-safe-target']) {
        expect(sent.find((m) => m.requestId === id)).toBeDefined();
      }
    });

    expect(sent.find((m) => m.requestId === 'ren-proj-config-gh')).toMatchObject({
      type: 'fs.rename_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    await expect(readFile(path.join(stagedGh, 'gh', 'hosts.yml'), 'utf8')).resolves.toBe('github.com:\n');

    expect(sent.find((m) => m.requestId === 'read-raw-ssh-traversal')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'read-upload-ssh-traversal')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'read-protected-raw-name-to-safe-target')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });

    // Normal rename of staged-gh -> safe-renamed still succeeds
    handleWebCommand({
      type: 'fs.rename',
      requestId: 'ren-proj-safe',
      sessionName: 'deck_priv_test',
      path: stagedGh,
      newPath: path.join(projectDir, 'safe-renamed'),
      sharedActor,
    }, serverLink as never);
    await vi.waitFor(() => expect(sent.find((m) => m.requestId === 'ren-proj-safe')).toBeDefined());
    expect(sent.find((m) => m.requestId === 'ren-proj-safe')).toMatchObject({
      type: 'fs.rename_response',
      status: 'ok',
    });
  });

  it('allows shared-participant fs.read for registered uploads when uploads dir is a symlink alias while keeping traversal and allowedRoot blocks intact (F4-R3)', async () => {
    const sharedActor = makeParticipantActor('shared-tab');
    const aliasUploadsDir = path.join(rootDir, 'external-uploads-alias');
    await mkdir(aliasUploadsDir, { recursive: true });
    await rm(path.join(fakeHome, '.imcodes', 'uploads'), { recursive: true, force: true });
    await symlink(aliasUploadsDir, path.join(fakeHome, '.imcodes', 'uploads'));

    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (msg: Record<string, unknown>) => sent.push(msg) };

    const uploadBytes = Buffer.from('hello symlinked upload', 'utf8');
    await handleFileUpload({
      type: 'file.upload',
      uploadId: 'up-f4-r3-symlink',
      filename: 'f'.repeat(32) + '.txt',
      originalName: 'symlink-note.txt',
      mime: 'text/plain',
      size: uploadBytes.length,
      content: uploadBytes.toString('base64'),
      sessionName: 'deck_priv_test',
    }, serverLink as never);
    const upDone = sent.find((m) => m.uploadId === 'up-f4-r3-symlink') as {
      attachment?: { id: string; daemonPath: string };
    } | undefined;
    expect(upDone?.attachment?.id).toBeTruthy();
    expect(upDone?.attachment?.daemonPath).toBeTruthy();

    const serverParticipant = makeParticipantActor('shared-server');
    const lexicalPath = upDone!.attachment!.daemonPath;
    const canonicalPath = await realpath(lexicalPath);
    expect(canonicalPath.startsWith(aliasUploadsDir)).toBe(true);
    const relFromUploads = path.relative(path.join(fakeHome, '.imcodes', 'uploads'), lexicalPath);

    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-symlink-upload-tab',
      sessionName: 'deck_priv_test',
      path: lexicalPath,
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-symlink-upload-server',
      sessionName: 'deck_priv_test',
      path: lexicalPath,
      sharedActor: serverParticipant,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-symlink-upload-traversal',
      sessionName: 'deck_priv_test',
      path: `${fakeHome}/.ssh/../.imcodes/uploads/${relFromUploads}`,
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.read',
      requestId: 'read-symlink-upload-allowed-root',
      sessionName: 'deck_priv_test',
      path: lexicalPath,
      allowedRoot: projectDir,
      sharedActor,
    }, serverLink as never);

    await vi.waitFor(() => {
      for (const id of [
        'read-symlink-upload-tab',
        'read-symlink-upload-server',
        'read-symlink-upload-traversal',
        'read-symlink-upload-allowed-root',
      ]) {
        expect(sent.find((m) => m.requestId === id)).toBeDefined();
      }
    });

    for (const id of ['read-symlink-upload-tab', 'read-symlink-upload-server']) {
      expect(sent.find((m) => m.requestId === id)).toMatchObject({
        type: 'fs.read_response',
        status: 'ok',
      });
    }
    expect(sent.find((m) => m.requestId === 'read-symlink-upload-traversal')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'read-symlink-upload-allowed-root')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('checks full root-relative paths for both registered and assistant-published uploads across nested multi-segment protected trees (F4-R4)', async () => {
    __resetSessionFileReadGrantsForTests();
    const sharedActor = makeParticipantActor('shared-tab');
    const aliasUploadsDir = path.join(rootDir, 'external-uploads-tree');
    const safeNestedDir = path.join(aliasUploadsDir, 'reports', 'q4');
    const nestedConfigGhDir = path.join(aliasUploadsDir, 'nested', '.config', 'gh');
    const nestedDockerDir = path.join(aliasUploadsDir, 'nested', '.docker');
    await mkdir(safeNestedDir, { recursive: true });
    await mkdir(nestedConfigGhDir, { recursive: true });
    await mkdir(nestedDockerDir, { recursive: true });

    await rm(path.join(fakeHome, '.imcodes', 'uploads'), { recursive: true, force: true });
    await symlink(aliasUploadsDir, path.join(fakeHome, '.imcodes', 'uploads'));

    const safePublishedLexical = path.join(fakeHome, '.imcodes', 'uploads', 'reports', 'q4', 'summary.txt');
    const ghHostsLexical = path.join(fakeHome, '.imcodes', 'uploads', 'nested', '.config', 'gh', 'hosts.yml');
    const dockerCfgLexical = path.join(fakeHome, '.imcodes', 'uploads', 'nested', '.docker', 'config.json');
    await writeFile(safePublishedLexical, 'Q4 summary ok\n');
    await writeFile(ghHostsLexical, 'github.com:\n  oauth_token: secret\n');
    await writeFile(dockerCfgLexical, '{"auths":{}}\n');

    // Grant assistant-published file references for all three paths
    recordAssistantFileReadGrants('deck_priv_test', [
      `[summary.txt](${safePublishedLexical})`,
      `[hosts.yml](${ghHostsLexical})`,
      `[config.json](${dockerCfgLexical})`,
    ].join('\n'));

    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (msg: Record<string, unknown>) => sent.push(msg) };

    handleWebCommand({
      type: 'fs.read',
      requestId: 'r5-pub-safe-nested',
      sessionName: 'deck_priv_test',
      path: safePublishedLexical,
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.read',
      requestId: 'r5-pub-nested-config-gh',
      sessionName: 'deck_priv_test',
      path: ghHostsLexical,
      sharedActor,
    }, serverLink as never);

    handleWebCommand({
      type: 'fs.read',
      requestId: 'r5-pub-nested-docker-cfg',
      sessionName: 'deck_priv_test',
      path: dockerCfgLexical,
      sharedActor,
    }, serverLink as never);

    // Owner still has full access to those files
    handleWebCommand({
      type: 'fs.read',
      requestId: 'r5-owner-nested-config-gh',
      sessionName: 'deck_priv_test',
      path: ghHostsLexical,
    }, serverLink as never);

    await vi.waitFor(() => {
      for (const id of [
        'r5-pub-safe-nested',
        'r5-pub-nested-config-gh',
        'r5-pub-nested-docker-cfg',
        'r5-owner-nested-config-gh',
      ]) {
        expect(sent.find((m) => m.requestId === id)).toBeDefined();
      }
    });

    expect(sent.find((m) => m.requestId === 'r5-pub-safe-nested')).toMatchObject({
      type: 'fs.read_response',
      status: 'ok',
    });
    expect(sent.find((m) => m.requestId === 'r5-pub-nested-config-gh')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'r5-pub-nested-docker-cfg')).toMatchObject({
      type: 'fs.read_response',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.SENSITIVE_PATH_FORBIDDEN,
    });
    expect(sent.find((m) => m.requestId === 'r5-owner-nested-config-gh')).toMatchObject({
      type: 'fs.read_response',
      status: 'ok',
    });
  });
});
