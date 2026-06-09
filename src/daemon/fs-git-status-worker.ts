import { parentPort } from 'node:worker_threads';
import * as nodePath from 'node:path';
import { readdir as fsReaddir } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  FsGitStatusBuildJobInput,
  FsGitStatusWorkerError,
  FsGitStatusWorkerFile,
  FsGitStatusWorkerRequest,
  FsGitStatusWorkerResult,
} from './fs-git-status-worker-types.js';

const execFileAsync = promisify(execFileCb);
const GIT_STATUS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GIT_STATUS_TIMEOUT_MS = 5_000;

function decodeGitPath(rawPath: string): string {
  return rawPath.replace(/\\([\\\"abfnrtv])/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'a': return '\u0007';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case '\\': return '\\';
      case '"': return '"';
      default: return escaped;
    }
  }).replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function parseZRecords(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

function normalizeRepoRelativePath(repoRoot: string, relativePath: string): string {
  return nodePath.join(repoRoot, decodeGitPath(relativePath));
}

function toGitPath(relativePath: string): string {
  return relativePath.split(nodePath.sep).join('/');
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = nodePath.resolve(root);
  const normalizedCandidate = nodePath.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + nodePath.sep);
}

async function execGit(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    timeout: GIT_STATUS_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
  });
  return stdout;
}

async function loadRepoStatusFiles(repoRoot: string): Promise<FsGitStatusWorkerFile[]> {
  const stdout = await execGit(repoRoot, ['status', '--porcelain=v1', '-z', '-u']);
  const files: FsGitStatusWorkerFile[] = [];
  const records = parseZRecords(stdout);
  for (let idx = 0; idx < records.length; idx += 1) {
    const record = records[idx]!;
    const code = record.slice(0, 2).trim();
    const firstPath = record.slice(3);
    let logicalPath = firstPath;
    if (code.startsWith('R') || code.startsWith('C')) {
      const renamedTo = records[idx + 1];
      if (renamedTo) {
        logicalPath = renamedTo;
        idx += 1;
      }
    }
    files.push({ path: normalizeRepoRelativePath(repoRoot, logicalPath), code });
  }
  return files;
}

async function loadDirectIgnoredChildren(repoRoot: string, requestedPath: string): Promise<FsGitStatusWorkerFile[]> {
  if (!isPathInside(repoRoot, requestedPath)) return [];
  let entries: Array<{ name: string }>;
  try {
    entries = await fsReaddir(requestedPath, { withFileTypes: true }) as Array<{ name: string }>;
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const relativeChildren = entries
    .map((entry) => toGitPath(nodePath.relative(repoRoot, nodePath.join(requestedPath, entry.name))))
    .filter((relativePath) => relativePath && !relativePath.startsWith('..') && !nodePath.isAbsolute(relativePath));
  if (relativeChildren.length === 0) return [];

  let stdout = '';
  try {
    stdout = await execGit(repoRoot, ['check-ignore', '-z', '--', ...relativeChildren]);
  } catch {
    return [];
  }
  return parseZRecords(stdout).map((relativePath) => ({
    path: normalizeRepoRelativePath(repoRoot, relativePath),
    code: '!!',
  }));
}

async function loadRepoNumstat(repoRoot: string): Promise<Map<string, { additions?: number; deletions?: number }>> {
  let stdout = '';
  try {
    stdout = await execGit(repoRoot, ['diff', '--numstat', '-z', 'HEAD']);
  } catch {
    try {
      stdout = await execGit(repoRoot, ['diff', '--numstat', '-z']);
    } catch {
      stdout = '';
    }
  }
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  const records = parseZRecords(stdout);
  for (let idx = 0; idx < records.length; idx += 1) {
    const header = records[idx]!;
    const firstTab = header.indexOf('\t');
    const secondTab = firstTab >= 0 ? header.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsRaw = header.slice(0, firstTab);
    const deletionsRaw = header.slice(firstTab + 1, secondTab);
    const pathRaw = header.slice(secondTab + 1);
    const additions = additionsRaw === '-' ? undefined : parseInt(additionsRaw, 10);
    const deletions = deletionsRaw === '-' ? undefined : parseInt(deletionsRaw, 10);
    let logicalPath = pathRaw;
    if (pathRaw === '') {
      const renamedTo = records[idx + 2];
      if (!renamedTo) continue;
      logicalPath = renamedTo;
      idx += 2;
    }
    stats.set(normalizeRepoRelativePath(repoRoot, logicalPath), { additions, deletions });
  }
  return stats;
}

export async function scanFsGitStatusSnapshot(input: FsGitStatusBuildJobInput): Promise<{
  repoRoot: string;
  repoSignature: string;
  requestedPath: string;
  includeStats: boolean;
  files: FsGitStatusWorkerFile[];
}> {
  const statusFiles = await loadRepoStatusFiles(input.repoRoot);
  const directIgnored = input.includeStats ? [] : await loadDirectIgnoredChildren(input.repoRoot, input.requestedPath);
  const stats = input.includeStats ? await loadRepoNumstat(input.repoRoot) : null;
  const filesByPath = new Map<string, FsGitStatusWorkerFile>();
  for (const file of statusFiles
    .filter((file) => isPathInside(input.requestedPath, file.path))
    .map((file) => {
      const fileStats = stats?.get(file.path);
      return fileStats ? { ...file, ...fileStats } : file;
    })) {
    filesByPath.set(file.path, file);
  }
  for (const file of directIgnored) {
    if (!filesByPath.has(file.path)) filesByPath.set(file.path, file);
  }
  return {
    repoRoot: input.repoRoot,
    repoSignature: input.repoSignature,
    requestedPath: input.requestedPath,
    includeStats: input.includeStats,
    files: [...filesByPath.values()],
  };
}

function workerError(message: FsGitStatusWorkerRequest, reason: FsGitStatusWorkerError['reason']): FsGitStatusWorkerError {
  return {
    workerRequestId: message.workerRequestId,
    workerSlotId: message.workerSlotId,
    workerGeneration: message.workerGeneration,
    kind: 'error',
    reason,
    sanitized: true,
  };
}

export async function handleFsGitStatusWorkerRequest(message: FsGitStatusWorkerRequest): Promise<FsGitStatusWorkerResult> {
  try {
    const snapshot = await scanFsGitStatusSnapshot(message);
    return {
      workerRequestId: message.workerRequestId,
      workerSlotId: message.workerSlotId,
      workerGeneration: message.workerGeneration,
      kind: 'success',
      ...snapshot,
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const reason = messageText.includes('ENOENT') || messageText.toLowerCase().includes('git')
      ? 'git_unavailable'
      : 'worker_internal';
    return workerError(message, reason);
  }
}

const port = parentPort;
if (port) {
  port.on('message', async (message: FsGitStatusWorkerRequest) => {
    const response = await handleFsGitStatusWorkerRequest(message);
    port.postMessage(response);
  });
}
