import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { normalizeChatFileReference } from '../../shared/chat-local-path.js';
import { resolveChatFileReference } from '../../src/daemon/session-file-reference-resolver.js';

describe('daemon chat file reference resolution', () => {
  const cleanup: string[] = [];
  const makeRoot = async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-chat-ref-'));
    cleanup.push(root);
    const cwd = path.join(root, 'worktree', 'packages', 'app');
    const worktree = path.join(root, 'worktree');
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    await Promise.all([cwd, project, home].map((entry) => mkdir(entry, { recursive: true })));
    return { root, cwd, worktree, project, home };
  };

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  });

  it('uses cwd, worktree, project, then home and retries false absolute paths as relative', async () => {
    const roots = await makeRoot();
    const cwdFile = path.join(roots.cwd, '交付包', '报告.pdf');
    const projectFile = path.join(roots.project, 'only-project.pdf');
    const homeFile = path.join(roots.home, 'only-home.pdf');
    await mkdir(path.dirname(cwdFile), { recursive: true });
    await Promise.all([
      writeFile(cwdFile, 'cwd'),
      writeFile(projectFile, 'project'),
      writeFile(homeFile, 'home'),
    ]);

    await expect(resolveChatFileReference({
      reference: '/交付包/报告.pdf', ...roots,
      worktreeRoot: roots.worktree, projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: true, realPath: await realpath(cwdFile), matchCount: 1 });
    await expect(resolveChatFileReference({
      reference: 'only-project.pdf', ...roots,
      worktreeRoot: roots.worktree, projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: true, realPath: await realpath(projectFile) });
    await expect(resolveChatFileReference({
      reference: '~/only-home.pdf', ...roots,
      worktreeRoot: roots.worktree, projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: true, realPath: await realpath(homeFile) });
  });

  it('selects the newest bounded cwd filename match and reports ambiguity', async () => {
    const roots = await makeRoot();
    const oldFile = path.join(roots.cwd, 'one', '结果.pdf');
    const newFile = path.join(roots.cwd, 'two', 'nested', '结果.pdf');
    await Promise.all([mkdir(path.dirname(oldFile), { recursive: true }), mkdir(path.dirname(newFile), { recursive: true })]);
    await Promise.all([writeFile(oldFile, 'old'), writeFile(newFile, 'new')]);
    await utimes(oldFile, new Date(1_000), new Date(1_000));
    await utimes(newFile, new Date(2_000), new Date(2_000));

    await expect(resolveChatFileReference({
      reference: '结果.pdf', cwd: roots.cwd, worktreeRoot: roots.worktree,
      projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: true, realPath: await realpath(newFile), matchCount: 2 });
  });

  it('matches NFC references to NFD filesystem names without broad recursive search', async () => {
    const roots = await makeRoot();
    const nfdName = 'évidence.pdf'.normalize('NFD');
    const actual = path.join(roots.cwd, nfdName);
    await writeFile(actual, 'unicode');

    await expect(resolveChatFileReference({
      reference: 'évidence.pdf'.normalize('NFC'), cwd: roots.cwd,
      worktreeRoot: roots.worktree, projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: true, realPath: await realpath(actual) });
  });

  it('fails closed for traversal outside every authority root and for symlinks', async () => {
    const roots = await makeRoot();
    const outside = path.join(roots.root, 'outside.pdf');
    const link = path.join(roots.cwd, 'link.pdf');
    await writeFile(outside, 'outside');
    await symlink(outside, link);

    await expect(resolveChatFileReference({
      reference: '../../../../outside.pdf', cwd: roots.cwd,
      worktreeRoot: roots.worktree, projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: false, error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });
    await expect(resolveChatFileReference({
      reference: 'link.pdf', cwd: roots.cwd,
      worktreeRoot: roots.worktree, projectRoot: roots.project, homeDir: roots.home,
    })).resolves.toMatchObject({ ok: false, error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });
  });

  it('normalizes local file URLs, source line suffixes, punctuation and Windows bytes only once', () => {
    expect(normalizeChatFileReference('file:///home/ai/%E4%BA%A4%E4%BB%98/report.pdf')).toBe('/home/ai/交付/report.pdf');
    expect(normalizeChatFileReference('/src/a.ts:42:7，')).toBe('/src/a.ts');
    expect(normalizeChatFileReference('C:\\Users\\k\\.imcodes\\报告.pdf:9')).toBe('C:\\Users\\k\\.imcodes\\报告.pdf');
    expect(normalizeChatFileReference('file://server/share/a.pdf')).toBeNull();
    expect(normalizeChatFileReference('\\\\server\\share\\a.pdf')).toBeNull();
    expect(normalizeChatFileReference('/tmp/报告（最终）.pdf。')).toBe('/tmp/报告（最终）.pdf');
  });
});
