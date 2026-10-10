import { describe, expect, it } from 'vitest';
import {
  fileTransferLegacyFilename,
  fileTransferStorageId,
} from '../../shared/transport/file-transfer.js';

/** Minimal 4931-shaped handler: legacy daemons persist the filename field. */
function persistAsLegacyDaemonWould(uploadRoot: string, request: { filename: string; content: string }): string {
  const path = `${uploadRoot}/${request.filename}`;
  return path;
}

describe('file transfer legacy upload filename compatibility', () => {
  it.each([
    ['photo.png', '.png'],
    ['archive.tar.gz', '.gz'],
    ['报价单 v2.xlsx', '.xlsx'],
    ['name.with<bad>.bin', '.bin'],
    ['no-extension', ''],
  ])('retains the old daemon extension for %s', (name, suffix) => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(fileTransferLegacyFilename(id, name)).toBe(`${id}${suffix}`);
  });

  it('keeps the id recoverable for the new daemon layout', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const legacy = fileTransferLegacyFilename(id, '截图 2026.png');
    expect(fileTransferStorageId(legacy)).toBe(id);
    expect(fileTransferStorageId(id)).toBe(id);
  });

  it('provides the extension old daemons use to recognize image uploads', () => {
    const filename = fileTransferLegacyFilename('a'.repeat(32), 'image.png');
    const legacyPath = persistAsLegacyDaemonWould('/tmp/uploads', {
      filename,
      content: 'iVBORw0KGgo=',
    });
    expect(legacyPath).toBe(`/tmp/uploads/${'a'.repeat(32)}.png`);
  });
});
