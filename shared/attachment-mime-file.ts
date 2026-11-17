/** Node-only file adapter for the shared bounded content sniffer. */
import { open } from 'node:fs/promises';
import { ATTACHMENT_SNIFF_BYTES, sniffAttachmentMime } from './attachment-delivery.js';
export async function sniffAttachmentFileMime(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(ATTACHMENT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return sniffAttachmentMime(prefix.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

