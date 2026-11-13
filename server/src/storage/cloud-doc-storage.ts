import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLOUD_DOCS_DEFAULT_DIR,
  CLOUD_DOCS_MAX_UPLOAD_BYTES,
} from '../../../shared/cloud-docs.js';
import { FS_GENERIC_ERROR_CODES } from '../../../shared/fs-error-codes.js';

export interface CloudDocWriteResult {
  sizeBytes: number;
  sha256: string;
}

export interface CloudDocStorage {
  write(storageKey: string, bytes: Buffer): Promise<CloudDocWriteResult>;
  read(storageKey: string): Promise<Buffer>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<void>;
}

const STORAGE_KEY_RE = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)?$/;

export function resolveCloudDocsStorageDir(configuredDir?: string | null, nodeEnv?: string): string {
  const trimmed = configuredDir?.trim();
  if (trimmed) return path.resolve(trimmed);
  if (nodeEnv === 'production') return CLOUD_DOCS_DEFAULT_DIR;
  return path.join(os.tmpdir(), 'imcodes-cloud-docs');
}

export function buildCloudDocStorageKey(userId: string, docId: string, version = 1): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'user';
  const safeDoc = docId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'doc';
  const nonce = randomBytes(6).toString('hex');
  return `${safeUser}/${safeDoc}_v${version}_${nonce}`;
}

export class LocalCloudDocStorage implements CloudDocStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  resolveSafePath(storageKey: string): string {
    if (!STORAGE_KEY_RE.test(storageKey)) {
      throw new Error('invalid_storage_key');
    }
    const segments = storageKey.split('/');
    if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
      throw new Error('invalid_storage_key');
    }
    const resolved = path.resolve(this.rootDir, ...segments);
    const rootWithSep = this.rootDir.endsWith(path.sep) ? this.rootDir : `${this.rootDir}${path.sep}`;
    if (!resolved.startsWith(rootWithSep)) {
      throw new Error('storage_path_traversal_denied');
    }
    return resolved;
  }

  async write(storageKey: string, bytes: Buffer): Promise<CloudDocWriteResult> {
    if (bytes.length > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
      throw new Error(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE);
    }
    const targetPath = this.resolveSafePath(storageKey);
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    let tmpCreated = false;
    try {
      const fh = await fs.open(tmpPath, 'w', 0o600);
      tmpCreated = true;
      try {
        await fh.writeFile(bytes);
        await fh.sync().catch(() => {});
      } finally {
        await fh.close();
      }
      await fs.rename(tmpPath, targetPath);
      tmpCreated = false;
    } finally {
      if (tmpCreated) {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { sizeBytes: bytes.length, sha256 };
  }

  async read(storageKey: string): Promise<Buffer> {
    const targetPath = this.resolveSafePath(storageKey);
    return fs.readFile(targetPath);
  }

  async exists(storageKey: string): Promise<boolean> {
    const targetPath = this.resolveSafePath(storageKey);
    try {
      const stat = await fs.stat(targetPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async delete(storageKey: string): Promise<void> {
    const targetPath = this.resolveSafePath(storageKey);
    try {
      await fs.unlink(targetPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw err;
    }
  }
}
