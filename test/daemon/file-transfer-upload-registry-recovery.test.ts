import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX } from '../../shared/direct-file-transfer.js';

/**
 * On startup the daemon rebuilds its attachment registry by scanning the upload
 * directory, because the registry itself is in-memory and does not survive a
 * restart. The scan therefore decides what the user can see, and it has to tell
 * uploaded files apart from the bookkeeping that sits beside them.
 */
describe('upload attachment registry recovery', () => {
  let home: string;
  let uploads: string;

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(path.join(tmpdir(), 'imcodes-upload-registry-'));
    uploads = path.join(home, '.imcodes', 'uploads');
    await mkdir(uploads, { recursive: true });
    const os = await vi.importActual<typeof import('node:os')>('node:os');
    vi.doMock('node:os', () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home }));
    vi.doMock('../../src/util/logger.js', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
  });

  afterEach(async () => {
    vi.doUnmock('node:os');
    vi.doUnmock('../../src/util/logger.js');
    vi.resetModules();
    await rm(home, { recursive: true, force: true });
  });

  it('recovers a real upload but never its commit-intent bookkeeping', async () => {
    await writeFile(path.join(uploads, 'real-upload.bin'), 'hello');
    await writeFile(path.join(uploads, 'real-upload.bin.meta.json'), JSON.stringify({
      originalName: 'report.pdf', mime: 'application/pdf', clientUploadId: 'client-upload-1',
    }));
    // An upload that was interrupted mid-publish leaves this behind. It is a
    // plain JSON file in the same directory, so nothing but an explicit rule
    // stops the scan from serving it as a downloadable attachment.
    await writeFile(path.join(uploads, `real-upload.bin${DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX}`), JSON.stringify({
      clientUploadId: 'client-upload-1', filename: 'real-upload.bin', originalName: 'report.pdf',
      resolved: path.join(uploads, 'real-upload.bin'), size: 5,
    }));

    const handler = await import('../../src/daemon/file-transfer-handler.js');
    await handler.initFileTransfer();

    const recovered = handler.lookupAttachmentByClientUploadId('client-upload-1');
    expect(recovered, 'the upload itself is recovered').toBeTruthy();
    expect(recovered!.originalName, 'with the name the user gave it').toBe('report.pdf');

    // The consequence that matters: the bookkeeping file is not something a
    // browser can ask the daemon to hand over.
    await expect(
      handler.resolveDirectFileDownloadSource('real-upload.bin'),
      'the upload is downloadable',
    ).resolves.toMatchObject({ size: 5 });
    await expect(
      handler.resolveDirectFileDownloadSource(`real-upload.bin${DIRECT_FILE_TRANSFER_COMMIT_INTENT_SUFFIX}`),
      'the commit intent is not',
    ).rejects.toThrow('not_found');
  });
});
