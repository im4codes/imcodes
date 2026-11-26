import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import {
  getDefaultPreviewReadCoordinator,
  __resetPreviewReadCoordinatorForTests,
} from '../../src/daemon/file-preview-read-coordinator.js';
import { resolveDirectFileDownloadSource } from '../../src/daemon/file-transfer-handler.js';
import {
  __resetSessionFileReadGrantsForTests,
  hasAssistantFileReadGrant,
  recordAssistantFileReadGrants,
} from '../../src/daemon/session-file-read-grants.js';
import { resolveChatFileReference } from '../../src/daemon/session-file-reference-resolver.js';
import * as sessionStore from '../../src/store/session-store.js';

describe('chat hidden-path file download chain', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetSessionFileReadGrantsForTests();
    __resetPreviewReadCoordinatorForTests();
    await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  });

  it('mints and resolves a real daemon download for a percent-encoded Linux CJK Markdown path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-chat-download-'));
    cleanup.push(root);
    const filePath = path.join(root, '.work', '企享云外贸财税申报管理系统_代码.pdf');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from('%PDF-1.4\nreal chat download\n', 'utf8'), { flag: 'wx' });
    const encodedPath = encodeURI(filePath);
    const sessionName = 'deck_chat_download_test';
    recordAssistantFileReadGrants(sessionName, `[企享云外贸财税申报管理系统_代码.pdf](${encodedPath})`);
    await expect(hasAssistantFileReadGrant(sessionName, filePath, async () => [])).resolves.toBe(true);

    const response = await new Promise<Record<string, unknown>>((resolve) => {
      getDefaultPreviewReadCoordinator().handle(filePath, 'chat-download-real-file', resolve);
    });
    expect(response).toMatchObject({
      type: 'fs.read_response',
      requestId: 'chat-download-real-file',
    });
    expect(typeof response.downloadId).toBe('string');

    const source = await resolveDirectFileDownloadSource(String(response.downloadId));
    expect(source.readPath).toBe(await realpath(filePath));
    expect(source.filename).toBe(path.basename(filePath));
    expect(await readFile(source.readPath, 'utf8')).toBe('%PDF-1.4\nreal chat download\n');
  });

  it('returns a stable not-found reason when a worktree file has already been cleaned', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-chat-cleaned-'));
    cleanup.push(root);
    const missingPath = path.join(root, '.work', '已被GC清理_代码.pdf');

    const response = await new Promise<Record<string, unknown>>((resolve) => {
      getDefaultPreviewReadCoordinator().handle(missingPath, 'chat-download-cleaned-file', resolve);
    });

    expect(response).toMatchObject({
      type: 'fs.read_response',
      requestId: 'chat-download-cleaned-file',
      status: 'error',
      error: FS_READ_ERROR_CODES.PARENT_NOT_FOUND,
    });
    expect(response.downloadId).toBeUndefined();
  });

  it('resolves non-contract relative forms before minting a real download handle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-chat-relative-download-'));
    cleanup.push(root);
    const cwd = path.join(root, 'worktree', 'repo');
    const filePath = path.join(cwd, 'dist', '报告（最终）.pdf');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from('%PDF relative\n', 'utf8'), { flag: 'wx' });
    const sessionName = 'deck_chat_relative_download_test';
    const assistantText = [
      '[relative](dist/报告（最终）.pdf)',
      '`./dist/报告（最终）.pdf:12`',
      '报告（最终）.pdf，',
      '[false absolute](/dist/报告（最终）.pdf)',
      `[file URL](file://${encodeURI(filePath)})`,
    ].join('\n');
    recordAssistantFileReadGrants(sessionName, assistantText);

    for (const reference of [
      'dist/报告（最终）.pdf',
      './dist/报告（最终）.pdf',
      '报告（最终）.pdf',
      '/dist/报告（最终）.pdf',
      `file://${encodeURI(filePath)}`,
    ]) {
      await expect(hasAssistantFileReadGrant(sessionName, reference, async () => [])).resolves.toBe(true);
      await expect(resolveChatFileReference({
        reference,
        cwd,
        worktreeRoot: cwd,
        projectRoot: cwd,
        homeDir: root,
      })).resolves.toMatchObject({ ok: true, realPath: await realpath(filePath) });
    }

    const resolved = await resolveChatFileReference({
      reference: '报告（最终）.pdf', cwd, worktreeRoot: cwd, projectRoot: cwd, homeDir: root,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('reference did not resolve');
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      getDefaultPreviewReadCoordinator().handle(resolved.realPath, 'chat-relative-real-file', resolve);
    });
    const source = await resolveDirectFileDownloadSource(String(response.downloadId));
    expect(await readFile(source.readPath, 'utf8')).toBe('%PDF relative\n');
  });

  it('mints and resolves real outside-project downloads for owners and whole-server shares even with sessionName set, while denying tab shares, symlinks to ~/.ssh, and missing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-outside-download-'));
    cleanup.push(root);
    const projectDir = path.join(root, 'project');
    const outsideDir = path.join(root, 'outside');
    const outsideFile = path.join(outsideDir, 'tool-output-report.txt');
    const relativeInProject = path.join(projectDir, 'nested', 'readme.txt');
    const missingOutsideFile = path.join(outsideDir, 'does-not-exist.txt');
    const realSshDir = path.join(homedir(), '.ssh');
    const realSshKey = path.join(realSshDir, 'id_rsa_test_key');
    const sshLink = path.join(outsideDir, 'link-to-ssh');
    await mkdir(path.dirname(relativeInProject), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(realSshDir, { recursive: true });
    await writeFile(outsideFile, 'outside-project-payload\n', 'utf8');
    await writeFile(relativeInProject, 'inside-relative-payload\n', 'utf8');
    await writeFile(realSshKey, 'PRIVATE KEY\n', 'utf8');
    cleanup.push(realSshKey);
    await symlink(realSshDir, sshLink);

    const sessionName = 'deck_outside_download_test';
    vi.spyOn(sessionStore, 'getSession').mockImplementation((name) => (
      name === sessionName
        ? { name: sessionName, projectName: 'proj', role: 'brain', projectDir } as never
        : undefined
    ));
    vi.spyOn(sessionStore, 'listSessions').mockReturnValue([]);

    const sendFsRead = (cmd: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
      handleWebCommand(cmd, {
        send: (msg: unknown) => {
          const rec = msg as Record<string, unknown>;
          if (rec.type === 'fs.read_response' && rec.requestId === cmd.requestId) resolve(rec);
        },
        sendBinary: () => {},
      } as never);
    });

    // Owner (chatFileReference: true & false) + relative in-project path
    const ownerChatRes = await sendFsRead({
      type: 'fs.read',
      path: outsideFile,
      requestId: 'real-owner-outside-chat',
      sessionName,
      chatFileReference: true,
    });
    expect(ownerChatRes).toMatchObject({
      type: 'fs.read_response',
      status: 'ok',
      path: outsideFile,
      resolvedPath: await realpath(outsideFile),
    });
    const ownerSource = await resolveDirectFileDownloadSource(String(ownerChatRes.downloadId));
    expect(await readFile(ownerSource.readPath, 'utf8')).toBe('outside-project-payload\n');

    const ownerRegularRes = await sendFsRead({
      type: 'fs.read',
      path: outsideFile,
      requestId: 'real-owner-outside-regular',
      sessionName,
      chatFileReference: false,
    });
    expect(ownerRegularRes.status).toBe('ok');
    const ownerRegularSource = await resolveDirectFileDownloadSource(String(ownerRegularRes.downloadId));
    expect(await readFile(ownerRegularSource.readPath, 'utf8')).toBe('outside-project-payload\n');

    const relRes = await sendFsRead({
      type: 'fs.read',
      path: 'nested/readme.txt',
      requestId: 'real-owner-relative',
      sessionName,
      chatFileReference: true,
    });
    expect(relRes).toMatchObject({
      status: 'ok',
      path: 'nested/readme.txt',
      resolvedPath: await realpath(relativeInProject),
    });

    // Whole-server share participant
    const serverShareRes = await sendFsRead({
      type: 'fs.read',
      path: outsideFile,
      requestId: 'real-server-share-outside',
      sessionName,
      chatFileReference: true,
      sharedActor: {
        origin: 'shared-server',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'server', serverId: 'srv-1' } },
      },
    });
    expect(serverShareRes.status).toBe('ok');
    const serverSource = await resolveDirectFileDownloadSource(String(serverShareRes.downloadId));
    expect(await readFile(serverSource.readPath, 'utf8')).toBe('outside-project-payload\n');

    // Tab-share remains confined
    const tabShareRes = await sendFsRead({
      type: 'fs.read',
      path: outsideFile,
      requestId: 'real-tab-share-denied',
      sessionName,
      chatFileReference: true,
      sharedActor: {
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: { kind: 'session', sessionName } },
      },
    });
    expect(tabShareRes).toMatchObject({ status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });

    // Symlink into ~/.ssh (existing and nonexistent key) is forbidden, while missing outside path returns parent_not_found
    const sshLinkRes = await sendFsRead({
      type: 'fs.read',
      path: path.join(sshLink, 'id_rsa_test_key'),
      requestId: 'real-ssh-symlink-denied',
      sessionName,
      chatFileReference: true,
    });
    expect(sshLinkRes).toMatchObject({ status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });

    const sshMissingLinkRes = await sendFsRead({
      type: 'fs.read',
      path: path.join(sshLink, 'nonexistent_key'),
      requestId: 'real-ssh-missing-symlink-denied',
      sessionName,
      chatFileReference: true,
    });
    expect(sshMissingLinkRes).toMatchObject({ status: 'error', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });

    const missingRes = await sendFsRead({
      type: 'fs.read',
      path: missingOutsideFile,
      requestId: 'real-missing-outside',
      sessionName,
      chatFileReference: true,
    });
    expect(missingRes).toMatchObject({ status: 'error', error: FS_GENERIC_ERROR_CODES.PARENT_NOT_FOUND });
  });
});
