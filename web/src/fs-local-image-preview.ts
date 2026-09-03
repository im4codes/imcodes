import type { ChatLocalImagePreviewResult } from './components/ChatLocalImagePreview.js';
import type { WsClient } from './ws-client.js';
import { buildAttachmentDownloadUrl } from './api.js';
import { pathBasename } from './util/path-utils.js';

export interface LoadFsLocalImagePreviewOptions {
  sessionName?: string;
  timeoutMs?: number;
  errorMessage?: string;
  timeoutMessage?: string;
  /**
   * Required for streamed previews: the daemon answers image previews with
   * metadata plus a download handle and never sends bytes over the WebSocket,
   * so the URL has to be built against the pod holding that daemon.
   */
  serverId?: string;
  /** Injectable for tests; defaults to the authenticated attachment URL builder. */
  buildDownloadUrl?: (serverId: string, downloadId: string, sessionName?: string) => Promise<string>;
}

/** Read a local image through the existing scoped daemon file-preview channel. */
export function loadFsLocalImagePreview(
  ws: WsClient,
  path: string,
  options: LoadFsLocalImagePreviewOptions = {},
): Promise<ChatLocalImagePreviewResult> {
  return new Promise((resolve, reject) => {
    let requestId: string | null = null;
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
      if (message.type !== 'fs.read_response' || requestId === null || message.requestId !== requestId) return;
      if (
        message.status === 'ok'
        && message.encoding === 'base64'
        && typeof message.mimeType === 'string'
        && message.mimeType.startsWith('image/')
        && typeof message.content === 'string'
        && message.content.length > 0
      ) {
        finish(() => resolve({
          dataUrl: `data:${message.mimeType};base64,${message.content}`,
          alt: pathBasename(path),
        }));
        return;
      }
      // tsk_5rf: streamed previews carry no bytes. The image element loads them
      // straight from the authenticated chunked download URL, so nothing is ever
      // base64'd back through the WebSocket.
      if (
        message.status === 'ok'
        && (message as { previewMode?: string }).previewMode === 'stream'
        && typeof message.mimeType === 'string'
        && message.mimeType.startsWith('image/')
        && typeof (message as { downloadId?: string }).downloadId === 'string'
        && (message as { downloadId: string }).downloadId.length > 0
        && options.serverId
      ) {
        const downloadId = (message as { downloadId: string }).downloadId;
        const build = options.buildDownloadUrl ?? buildAttachmentDownloadUrl;
        const serverId = options.serverId;
        finish(() => {
          build(serverId, downloadId, options.sessionName)
            .then((dataUrl) => resolve({ dataUrl, alt: pathBasename(path) }))
            .catch(() => reject(new Error(options.errorMessage ?? 'file_preview_failed')));
        });
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
