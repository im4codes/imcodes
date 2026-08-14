import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetContextStoreForTests } from '../../src/store/context-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';

export async function createIsolatedSharedContextDb(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  process.env.IMCODES_CONTEXT_DB_PATH = join(tempDir, 'context.sqlite');
  resetContextStoreClientForTests();
  resetContextStoreForTests();
  return tempDir;
}

export async function cleanupIsolatedSharedContextDb(tempDir?: string): Promise<void> {
  resetContextStoreClientForTests();
  delete process.env.IMCODES_CONTEXT_DB_PATH;
  resetContextStoreForTests();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}
