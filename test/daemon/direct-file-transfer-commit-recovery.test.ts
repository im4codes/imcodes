import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX,
  DIRECT_FILE_TRANSFER_WORKER_MSG,
  DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
} from '../../shared/direct-file-transfer.js';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Publishing a finished upload is two steps — rename the partial into place,
 * then write it into the attachment registry — and a crash can land between
 * them. The file is then real on disk but referenced by nothing: the partial
 * sweeper skips it (no `.part`), no resume state points at it, and no client
 * can ever see it.
 *
 * These cases construct exactly the on-disk state each crash window leaves and
 * assert the boot sweep resolves every one of them into either durable (the
 * upload is registered) or explicitly terminal (nothing was published, so the
 * record is dropped) — never a third, silent outcome.
 */
describe('direct file transfer interrupted-commit recovery', () => {
  let root: string;
  let storedPath: string;
  let intentPath: string;
  let finalizeDirectUploadedFile: ReturnType<typeof vi.fn>;
  let lookupAttachmentByClientUploadId: ReturnType<typeof vi.fn>;
  let directLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  const INTENT = {
    clientUploadId: 'client-upload-77',
    filename: 'stored.bin',
    originalName: 'report q3.pdf',
    mime: 'application/pdf',
    size: 5,
    destinationDirectory: 'C:\\Users\\admin\\Desktop',
  };

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(path.join(tmpdir(), 'imcodes-direct-commit-recovery-'));
    storedPath = path.join(root, 'stored.bin');
    intentPath = `${storedPath}${DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX}`;
    finalizeDirectUploadedFile = vi.fn(async (params: { size: number }) => ({
      id: 'stored-id', source: 'upload', serverId: '', daemonPath: storedPath,
      originalName: INTENT.originalName, size: params.size, createdAt: new Date().toISOString(), downloadable: true,
    }));
    lookupAttachmentByClientUploadId = vi.fn(() => undefined);
    directLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.doMock('../../src/daemon/file-transfer-handler.js', () => ({
      ensureUploadDirectory: vi.fn(),
      createDirectUploadFilename: () => 'stored.bin',
      resolveUploadPath: () => storedPath,
      lookupAttachmentByClientUploadId,
      tryClaimClientUpload: vi.fn(() => Symbol('claim')),
      releaseClientUploadClaim: vi.fn(),
      finalizeDirectUploadedFile,
      resolveDirectFileDownloadSource: vi.fn(),
    }));
    vi.doMock('../../src/util/logger.js', () => ({ default: directLogger }));
  });

  afterEach(async () => {
    vi.doUnmock('../../src/daemon/file-transfer-handler.js');
    vi.doUnmock('../../src/util/logger.js');
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  /** The worker reaches registry authority through the host call, as in production. */
  async function loadWorker() {
    const direct = await import('../../src/daemon/direct-file-transfer-worker.js');
    const handler = await import('../../src/daemon/file-transfer-handler.js');
    direct.__setDirectFileTransferWorkerHostForTests(async (method, args) => {
      if (method === 'lookupAttachmentByClientUploadId') {
        return handler.lookupAttachmentByClientUploadId(String(args[0] ?? ''));
      }
      if (method === 'finalizeDirectUploadedFile') {
        return await handler.finalizeDirectUploadedFile(args[0] as never);
      }
      throw new Error(`unexpected_host_method:${method}`);
    });
    return direct;
  }

  const exists = async (p: string) => await access(p).then(() => true, () => false);

  async function writeIntent(overrides: Record<string, unknown> = {}): Promise<void> {
    await writeFile(intentPath, JSON.stringify({ ...INTENT, resolved: storedPath, ...overrides }));
  }

  it('registers an upload that was renamed into place but never reached the registry', async () => {
    // The exact crash window: the partial is gone, the file is published, and
    // nothing in the system references it.
    await writeFile(storedPath, 'hello');
    await writeIntent();
    const direct = await loadWorker();

    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(1);

    expect(finalizeDirectUploadedFile).toHaveBeenCalledTimes(1);
    expect(finalizeDirectUploadedFile).toHaveBeenCalledWith({
      clientUploadId: INTENT.clientUploadId,
      filename: INTENT.filename,
      originalName: INTENT.originalName,
      resolved: storedPath,
      size: INTENT.size,
      mime: INTENT.mime,
      destinationDirectory: INTENT.destinationDirectory,
    });
    await expect(readFile(storedPath, 'utf8'), 'the published bytes are never touched').resolves.toBe('hello');
    expect(await exists(intentPath), 'the resolved record is cleared').toBe(false);
  });

  it('runs the sweep at worker startup, answering over the real host RPC', async () => {
    // A crashed worker is replaced by a new one; startup is the only moment that
    // reliably happens, so the sweep has to be wired into it rather than left to
    // be called by something.
    await writeFile(storedPath, 'hello');
    await writeIntent();

    const port = new EventEmitter() as EventEmitter & { postMessage(value: Record<string, unknown>): void };
    const handler = await import('../../src/daemon/file-transfer-handler.js');
    port.postMessage = (value: Record<string, unknown>) => {
      if (value.type !== DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_CALL) return;
      // The host half of the call, as the main-thread proxy performs it.
      void (async () => {
        const args = value.args as unknown[];
        const result = value.method === 'lookupAttachmentByClientUploadId'
          ? handler.lookupAttachmentByClientUploadId(String(args[0] ?? '')) ?? null
          : await handler.finalizeDirectUploadedFile(args[0] as never);
        port.emit('message', {
          v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION, generation: 1,
          type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT, callId: value.callId, ok: true, value: result,
        });
      })();
    };
    vi.doMock('node:worker_threads', () => ({ parentPort: port, workerData: { generation: 1 } }));
    vi.doMock('node-datachannel', () => ({ PeerConnection: class {}, initLogger: vi.fn(), cleanup: vi.fn() }));

    // Importing the module IS the worker starting up.
    await import('../../src/daemon/direct-file-transfer-worker.js');

    await vi.waitFor(() => expect(finalizeDirectUploadedFile).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await exists(intentPath)).toBe(false));
    vi.doUnmock('node:worker_threads');
    vi.doUnmock('node-datachannel');
  });

  it('treats an intent whose file was never published as terminal, and leaves the partial alone', async () => {
    // Crashed before the rename. The partial is still the authority and belongs
    // to the ordinary resume/scavenge path, not to this sweep.
    const partPath = `${storedPath}.${'a'.repeat(32)}.part`;
    await writeFile(partPath, 'hel');
    await writeIntent();
    const direct = await loadWorker();

    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(0);

    expect(finalizeDirectUploadedFile, 'nothing was published, so nothing may be registered').not.toHaveBeenCalled();
    expect(await exists(intentPath), 'the record is dropped rather than retried forever').toBe(false);
    await expect(readFile(partPath, 'utf8'), 'the resumable partial survives').resolves.toBe('hel');
  });

  it('refuses a record that points somewhere other than its own file', async () => {
    await writeFile(storedPath, 'hello');
    // A record whose `resolved` aims outside the upload directory. Trusting it
    // would register an arbitrary file on the machine as a downloadable
    // attachment.
    const outside = path.join(root, '..', 'not-an-upload.bin');
    await writeIntent({ resolved: outside });
    const direct = await loadWorker();

    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(0);

    expect(finalizeDirectUploadedFile, 'nothing outside the record\'s own file is published').not.toHaveBeenCalled();
    expect(await exists(intentPath)).toBe(false);
  });

  it('does not register a second time when the previous process already committed', async () => {
    // Crashed between the registry write and clearing the record.
    await writeFile(storedPath, 'hello');
    await writeIntent();
    lookupAttachmentByClientUploadId.mockReturnValue({
      id: 'stored-id', source: 'upload', serverId: '', daemonPath: storedPath,
      originalName: INTENT.originalName, size: INTENT.size, createdAt: new Date().toISOString(), downloadable: true,
    });
    const direct = await loadWorker();

    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(0);

    expect(finalizeDirectUploadedFile, 'the upload is already durable').not.toHaveBeenCalled();
    expect(await exists(intentPath)).toBe(false);
  });

  it('keeps the record when the registry write fails, so the next boot retries', async () => {
    await writeFile(storedPath, 'hello');
    await writeIntent();
    finalizeDirectUploadedFile.mockRejectedValueOnce(new Error('registry_unavailable'));
    const direct = await loadWorker();

    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(0);
    expect(await exists(intentPath), 'a failed replay must not discard its own evidence').toBe(true);

    // The retry is what makes retention meaningful.
    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(1);
    expect(finalizeDirectUploadedFile).toHaveBeenCalledTimes(2);
    expect(await exists(intentPath)).toBe(false);
  });

  it('refuses a malformed record instead of coercing it into a registry write', async () => {
    await writeFile(storedPath, 'hello');
    await writeFile(intentPath, '{not json');
    // A structurally valid record with a wrong-typed field is the more dangerous
    // shape: it would otherwise register a size the file does not have.
    const secondPath = path.join(root, 'other.bin');
    await writeFile(secondPath, 'hello');
    await writeFile(`${secondPath}${DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX}`,
      JSON.stringify({ ...INTENT, resolved: secondPath, size: '5' }));
    const direct = await loadWorker();

    await expect(direct.recoverInterruptedUploadCommits()).resolves.toBe(0);

    expect(finalizeDirectUploadedFile).not.toHaveBeenCalled();
    expect(await exists(intentPath)).toBe(false);
    expect(await exists(`${secondPath}${DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX}`)).toBe(false);
    await expect(readFile(storedPath, 'utf8'), 'refusing a record never deletes user bytes').resolves.toBe('hello');
    await expect(readFile(secondPath, 'utf8')).resolves.toBe('hello');
  });
});
