import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertSupportedGitRemoteUrl,
  normalizeOptionalGitRemoteUrl,
  redactGitRemoteUrl,
} from '../../shared/git-remote-url.js';

const execFileAsync = promisify(execFile);
const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export type GitRemoteCloneErrorCode = 'invalid_git_remote' | 'invalid_cwd' | 'git_clone_failed';

export class GitRemoteCloneError extends Error {
  readonly code: GitRemoteCloneErrorCode;

  constructor(code: GitRemoteCloneErrorCode, message: string) {
    super(message);
    this.name = 'GitRemoteCloneError';
    this.code = code;
  }
}

function messageFromCloneError(error: unknown): string {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string'
    ? (error as { stderr: string }).stderr
    : '';
  const stdout = typeof (error as { stdout?: unknown })?.stdout === 'string'
    ? (error as { stdout: string }).stdout
    : '';
  const firstLine = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? `Git clone failed: ${firstLine}` : 'Git clone failed.';
}

export async function cloneGitRemoteToDirectory(params: {
  gitRemoteUrl: string;
  targetDir: string;
}): Promise<string> {
  let remoteUrl: string;
  try {
    remoteUrl = assertSupportedGitRemoteUrl(params.gitRemoteUrl);
  } catch {
    throw new GitRemoteCloneError('invalid_git_remote', 'Git remote URL is not supported.');
  }

  const targetDir = params.targetDir.trim();
  if (!targetDir || !path.isAbsolute(targetDir)) {
    throw new GitRemoteCloneError('invalid_cwd', 'Clone target must be an absolute directory path.');
  }

  try {
    await mkdir(path.dirname(targetDir), { recursive: true });
    await execFileAsync('git', ['clone', '--', remoteUrl, targetDir], {
      timeout: GIT_CLONE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return await realpath(targetDir);
  } catch (error) {
    const message = messageFromCloneError(error).replaceAll(remoteUrl, redactGitRemoteUrl(remoteUrl));
    throw new GitRemoteCloneError('git_clone_failed', message);
  }
}

export async function maybeCloneGitRemoteToDirectory(params: {
  gitRemoteUrl: unknown;
  targetDir: string;
}): Promise<string> {
  const gitRemoteUrl = normalizeOptionalGitRemoteUrl(params.gitRemoteUrl);
  if (!gitRemoteUrl) return params.targetDir;
  return cloneGitRemoteToDirectory({ gitRemoteUrl, targetDir: params.targetDir });
}
