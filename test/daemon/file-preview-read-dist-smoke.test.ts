import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const distPoolPath = join(repoRoot, 'dist/src/daemon/file-preview-read-pool.js');
const distBootstrapPath = join(repoRoot, 'dist/src/daemon/file-preview-read-worker-bootstrap.mjs');
const distReady = existsSync(distPoolPath) && existsSync(distBootstrapPath);
const distRequired = process.env.PREVIEW_DIST_REQUIRED === '1';

if (!distReady && distRequired) {
  throw new Error('Preview dist smoke requires built dist artifacts. Run `npm run build` first.');
}

(distReady ? describe : describe.skip)('dist preview read worker smoke', () => {
  it('starts default two real workers and completes concurrent preflight jobs plus sanitized errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-test-preview-dist-'));
    try {
      const project = join(root, 'project');
      await mkdir(project, { recursive: true });
      const first = join(project, 'one.txt');
      const second = join(project, 'two.txt');
      await writeFile(first, 'one');
      await writeFile(second, 'two');

      const { PreviewReadWorkerPool } = await import(`${pathToFileURL(distPoolPath).href}?t=${Date.now()}`);
      const pool = new PreviewReadWorkerPool();
      try {
        expect(pool.workersTarget).toBe(2);

        const [one, two] = await Promise.all([
          pool.dispatch({ phase: 'preflight', rawPath: first }),
          pool.dispatch({ phase: 'preflight', rawPath: second }),
        ]);

        expect(pool.getSlotViews()).toHaveLength(2);
        expect(one).toMatchObject({ phase: 'preflight', kind: 'success', realPath: first });
        expect(two).toMatchObject({ phase: 'preflight', kind: 'success', realPath: second });

        const missing = await pool.dispatch({ phase: 'preflight', rawPath: join(project, 'missing.txt') });
        expect(missing).toMatchObject({ phase: 'preflight', kind: 'error', error: FS_READ_ERROR_CODES.INTERNAL_ERROR, sanitized: true });
        expect(JSON.stringify(missing)).not.toContain(project);
      } finally {
        await pool.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
