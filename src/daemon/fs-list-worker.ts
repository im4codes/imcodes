import { parentPort } from 'node:worker_threads';
import { readdir, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type {
  FsListWorkerEntry,
  FsListWorkerError,
  FsListWorkerRequest,
  FsListWorkerResult,
  FsListWorkerSuccess,
} from './fs-list-worker-types.js';

const MIME_MAP: Record<string, string> = {
  ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', md: 'text/markdown',
  txt: 'text/plain', html: 'text/html', css: 'text/css', xml: 'text/xml', yaml: 'text/yaml',
  yml: 'text/yaml', toml: 'text/toml', sh: 'text/x-shellscript', py: 'text/x-python',
  rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java',
  kt: 'text/x-kotlin', swift: 'text/x-swift', c: 'text/x-c', cpp: 'text/x-c++',
  h: 'text/x-c', hpp: 'text/x-c++', sql: 'text/x-sql', lua: 'text/x-lua',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', wasm: 'application/wasm',
};

const FS_LIST_METADATA_CONCURRENCY = 32;

async function safeStatSignature(targetPath: string): Promise<string> {
  try {
    const stats = await stat(targetPath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

export async function scanFsListSnapshot(input: {
  realPath: string;
  includeFiles: boolean;
  includeMetadata: boolean;
}): Promise<{ resolvedPath: string; dirSignature: string; entries: FsListWorkerEntry[] }> {
  const dirents = await readdir(input.realPath, { withFileTypes: true });
  const filtered = dirents.filter((d) => d.isDirectory() || (input.includeFiles && d.isFile()));

  const buildBasicEntry = (d: import('node:fs').Dirent): FsListWorkerEntry => ({
    name: d.name,
    path: nodePath.join(input.realPath, d.name),
    isDir: d.isDirectory(),
    hidden: d.name.startsWith('.'),
  });

  const entries = input.includeMetadata
    ? await mapWithConcurrency(filtered, FS_LIST_METADATA_CONCURRENCY, async (d) => {
      const entry = buildBasicEntry(d);
      if (!d.isDirectory()) {
        try {
          const fileStat = await stat(entry.path);
          entry.size = fileStat.size;
          const ext = nodePath.extname(d.name).toLowerCase().slice(1);
          entry.mime = MIME_MAP[ext] || undefined;
        } catch { /* stat failed; keep listing usable */ }
      }
      return entry;
    })
    : filtered.map(buildBasicEntry);

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (a.hidden !== b.hidden) return (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0);
    return a.name.localeCompare(b.name);
  });

  return {
    resolvedPath: input.realPath,
    dirSignature: await safeStatSignature(input.realPath),
    entries,
  };
}

function workerError(message: FsListWorkerRequest): FsListWorkerError {
  return {
    workerRequestId: message.workerRequestId,
    workerSlotId: message.workerSlotId,
    workerGeneration: message.workerGeneration,
    kind: 'error',
    reason: 'worker_internal',
    sanitized: true,
  };
}

export async function handleFsListWorkerRequest(message: FsListWorkerRequest): Promise<FsListWorkerResult> {
  try {
    const snapshot = await scanFsListSnapshot(message);
    return {
      workerRequestId: message.workerRequestId,
      workerSlotId: message.workerSlotId,
      workerGeneration: message.workerGeneration,
      kind: 'success',
      ...snapshot,
    };
  } catch {
    return workerError(message);
  }
}

const port = parentPort;
if (port) {
  port.on('message', async (message: FsListWorkerRequest) => {
    const response = await handleFsListWorkerRequest(message);
    port.postMessage(response);
  });
}
