import { listMachineDirectories } from './api/machines.js';
import type { ServerMessage, WsClient } from './ws-client.js';

type MessageListener = (message: ServerMessage) => void;

/**
 * Directory-only adapter for the existing FileBrowser UI. File bytes still use
 * the established controlled file-transfer APIs; this only maps the picker’s
 * list request/response shape onto the bounded machine-directory HTTP route.
 */
export class MachineDirectoryWsAdapter {
  private readonly listeners = new Set<MessageListener>();
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly serverId: string) {}

  asWsClient(): WsClient {
    return this as unknown as WsClient;
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fsListDir(path: string): string {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    this.controllers.add(controller);
    void listMachineDirectories(this.serverId, path, controller.signal).then((result) => {
      this.emit({
        type: 'fs.ls_response',
        requestId,
        path,
        resolvedPath: result.resolvedPath,
        status: 'ok',
        entries: result.entries,
      });
    }, (error) => {
      if (controller.signal.aborted) return;
      this.emit({
        type: 'fs.ls_response',
        requestId,
        path,
        status: 'error',
        error: error instanceof Error ? error.message : 'machine_file_list_failed',
      });
    }).finally(() => this.controllers.delete(controller));
    return requestId;
  }

  fsGitStatus(path: string): string {
    const requestId = crypto.randomUUID();
    queueMicrotask(() => this.emit({
      type: 'fs.git_status_response',
      requestId,
      path,
      status: 'ok',
      files: [],
    }));
    return requestId;
  }

  destroy(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.listeners.clear();
  }

  private emit(message: ServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
