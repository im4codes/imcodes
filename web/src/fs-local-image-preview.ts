import type { ChatLocalImagePreviewResult } from './components/ChatLocalImagePreview.js';
import type { WsClient } from './ws-client.js';
import { pathBasename } from './util/path-utils.js';

export interface LoadFsLocalImagePreviewOptions {
  sessionName?: string;
  timeoutMs?: number;
  errorMessage?: string;
  timeoutMessage?: string;
}

/** Read a local image through the existing scoped daemon file-preview channel. */
export function loadFsLocalImagePreview(
  ws: WsClient,
  path: string,
  options: LoadFsLocalImagePreviewOptions = {},
): Promise<ChatLocalImagePreviewResult> {
  return new Promise((resolve, reject) => {
    let requestId = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      callback();
    };

    unsubscribe = ws.onMessage((message) => {
      if (message.type !== 'fs.read_response' || message.requestId !== requestId) return;
      if (
        message.status === 'ok'
        && message.encoding === 'base64'
        && typeof message.mimeType === 'string'
        && message.mimeType.startsWith('image/')
      ) {
        finish(() => resolve({
          dataUrl: `data:${message.mimeType};base64,${message.content ?? ''}`,
          alt: pathBasename(path),
        }));
        return;
      }
      finish(() => reject(new Error(options.errorMessage ?? 'file_preview_failed')));
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error(options.timeoutMessage ?? 'file_preview_timeout')));
    }, options.timeoutMs ?? 22_000);

    try {
      requestId = options.sessionName ? ws.fsReadFile(path, options.sessionName) : ws.fsReadFile(path);
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
