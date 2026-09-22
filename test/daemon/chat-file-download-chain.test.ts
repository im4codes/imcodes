import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
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

describe('chat hidden-path file download chain', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
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
});
