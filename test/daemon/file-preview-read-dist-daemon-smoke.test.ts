import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const distCommandHandlerPath = join(repoRoot, 'dist/src/daemon/command-handler.js');
const distCoordinatorPath = join(repoRoot, 'dist/src/daemon/file-preview-read-coordinator.js');
const distFsListPoolPath = join(repoRoot, 'dist/src/daemon/fs-list-pool.js');
const distBootstrapPath = join(repoRoot, 'dist/src/daemon/file-preview-read-worker-bootstrap.mjs');
const distReady = existsSync(distCommandHandlerPath) && existsSync(distCoordinatorPath) && existsSync(distFsListPoolPath) && existsSync(distBootstrapPath);
const distRequired = process.env.PREVIEW_DIST_REQUIRED === '1';

if (!distReady && distRequired) {
  throw new Error('Preview dist daemon smoke requires built dist artifacts. Run `npm run build` first.');
}

(distReady ? describe : describe.skip)('dist default daemon preview-read smoke', () => {
  it('uses real worker threads and emits visible success and sanitized errors through the default coordinator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-test-preview-daemon-'));
    try {
      const project = join(root, 'project');
      await mkdir(project, { recursive: true });
      const one = join(project, 'one.txt');
      const two = join(project, 'two.txt');
      await writeFile(one, 'one');
      await writeFile(two, 'two');

      const runner = join(root, 'preview-runner.mjs');
      const script = `
        import { DefaultPreviewReadCoordinator } from ${JSON.stringify(`file://${distCoordinatorPath}`)};
        const coordinator = new DefaultPreviewReadCoordinator();
        const responses = [];
        const waitFor = (count) => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout waiting for preview responses')), 8000);
          const poll = () => {
            if (responses.length >= count) {
              clearTimeout(timeout);
              resolve();
              return;
            }
            setTimeout(poll, 10);
          };
          poll();
        });
        coordinator.handle(process.env.FILE_ONE, 'r1', (message) => responses.push(message));
        coordinator.handle(process.env.FILE_TWO, 'r2', (message) => responses.push(message));
        coordinator.handle(process.env.FILE_MISSING, 'r-missing', (message) => responses.push(message));
        await waitFor(3);
        await coordinator.shutdown();
        console.log(JSON.stringify(responses));
      `;
      await writeFile(runner, script);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        FILE_ONE: one,
        FILE_TWO: two,
        FILE_MISSING: join(project, 'missing.txt'),
      };
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;

      const { stdout } = await execFileAsync(process.execPath, [runner], {
        cwd: repoRoot,
        env,
        maxBuffer: 1024 * 1024,
      });
      const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? '[]';
      const responses = JSON.parse(lastLine) as Array<Record<string, unknown>>;

      expect(responses).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'fs.read_response', requestId: 'r1', status: 'ok', content: 'one' }),
        expect.objectContaining({ type: 'fs.read_response', requestId: 'r2', status: 'ok', content: 'two' }),
        expect.objectContaining({
          type: 'fs.read_response',
          requestId: 'r-missing',
          status: 'error',
          error: FS_READ_ERROR_CODES.INTERNAL_ERROR,
        }),
      ]));
      const missing = responses.find((response) => response.requestId === 'r-missing');
      expect(missing).not.toHaveProperty('resolvedPath');
      expect(missing).not.toHaveProperty('stack');
      expect(missing).not.toHaveProperty('errno');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps non-preview commands responsive while real dist preview workers are delayed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-test-preview-daemon-responsive-'));
    try {
      const project = join(root, 'project');
      await mkdir(project, { recursive: true });
      const one = join(project, 'one.txt');
      const two = join(project, 'two.txt');
      await writeFile(one, 'one');
      await writeFile(two, 'two');

      const runner = join(root, 'responsive-runner.mjs');
      const script = `
        import { handleWebCommand } from ${JSON.stringify(`file://${distCommandHandlerPath}`)};
        import { shutdownDefaultPreviewReadCoordinatorForDaemon } from ${JSON.stringify(`file://${distCoordinatorPath}`)};
        import { shutdownDefaultFsListWorkerPoolForDaemon } from ${JSON.stringify(`file://${distFsListPoolPath}`)};
        const startedAt = Date.now();
        const responses = [];
        const serverLink = {
          send(message) {
            responses.push({ ...message, at: Date.now() - startedAt });
          },
          sendBinary() {},
        };
        const waitFor = (predicate, label) => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout waiting for ' + label)), 8000);
          const poll = () => {
            const value = predicate();
            if (value) {
              clearTimeout(timeout);
              resolve(value);
              return;
            }
            setTimeout(poll, 5);
          };
          poll();
        });
        handleWebCommand({ type: 'fs.read', path: process.env.FILE_ONE, requestId: 'read-1' }, serverLink);
        handleWebCommand({ type: 'fs.read', path: process.env.FILE_TWO, requestId: 'read-2' }, serverLink);
        handleWebCommand({ type: 'fs.ls', path: process.env.PROJECT_DIR, requestId: 'ls-1', includeFiles: true }, serverLink);
        await waitFor(() => responses.find((message) => message.type === 'fs.ls_response'), 'fs.ls');
        await waitFor(() => responses.filter((message) => message.type === 'fs.read_response').length >= 2, 'fs.read responses');
        await shutdownDefaultPreviewReadCoordinatorForDaemon();
        await shutdownDefaultFsListWorkerPoolForDaemon();
        console.log(JSON.stringify(responses));
      `;
      await writeFile(runner, script);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        IMCODES_TEST_PREVIEW_WORKER_DELAY_MS: '750',
        FILE_ONE: one,
        FILE_TWO: two,
        PROJECT_DIR: project,
      };
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;

      const { stdout } = await execFileAsync(process.execPath, [runner], {
        cwd: repoRoot,
        env,
        maxBuffer: 1024 * 1024,
      });
      const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? '[]';
      const responses = JSON.parse(lastLine) as Array<Record<string, unknown>>;
      const listing = responses.find((response) => response.type === 'fs.ls_response');
      const readResponses = responses.filter((response) => response.type === 'fs.read_response');
      const firstReadAt = Math.min(...readResponses.map((response) => Number(response.at)));

      expect(listing).toMatchObject({ requestId: 'ls-1', status: 'ok' });
      expect(readResponses).toHaveLength(2);
      expect(Number(listing?.at)).toBeLessThan(firstReadAt);
      expect(firstReadAt).toBeGreaterThanOrEqual(500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
