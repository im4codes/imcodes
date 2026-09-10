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

  /**
   * Hand this to components that want a `WsClient`.
   *
   * The cast is a promise this class only partly keeps, and an unkept part is
   * not a graceful degradation: a consumer reaching a method that is missing
   * gets a bare `TypeError` thrown mid-render, which takes down the whole
   * component tree rather than just the file picker. So every method any
   * reachable consumer touches must exist here, and
   * `machine-directory-ws-adapter.test.ts` checks that against the real call
   * sites rather than trusting this comment.
   */
  asWsClient(): WsClient {
    return this as unknown as WsClient;
  }

  /**
   * A directory-only adapter fronts an HTTP route, not a daemon socket, so
   * there is no capability snapshot. `null` is the same answer a real client
   * gives before `daemon.hello` arrives, which consumers already handle.
   */
  getDaemonCapabilitySnapshot(): null {
    return null;
  }

  /** Reports the (permanently) absent snapshot once, then never changes. */
  onDaemonCapabilitySnapshot(listener: (snapshot: null) => void): () => void {
    listener(null);
    return () => {};
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

  /**
   * Everything below exists because FileBrowser calls it, not because a
   * directory-only adapter can do it.
   *
   * The picker is mounted `readOnly`, so these should be unreachable -- but
   * "should be unreachable" and "throws a TypeError that unmounts the remote
   * desktop" are a bad pair. Each answers with the same failed-response shape
   * the caller already handles for a real error, so the UI degrades to
   * "unsupported here" instead of the whole tree disappearing.
   */
  private failedResponse<T extends Record<string, unknown>>(message: T): string {
    const requestId = crypto.randomUUID();
    queueMicrotask(() => this.emit({
      ...message,
      requestId,
      status: 'error',
      error: 'machine_directory_read_only',
    } as unknown as ServerMessage));
    return requestId;
  }

  fsReadFile(path: string): string {
    return this.failedResponse({ type: 'fs.read_response', path });
  }

  fsWriteFile(path: string): string {
    return this.failedResponse({ type: 'fs.write_response', path });
  }

  fsMkdir(path: string): string {
    return this.failedResponse({ type: 'fs.mkdir_response', path });
  }

  fsRename(path: string): string {
    return this.failedResponse({ type: 'fs.rename_response', path });
  }

  fsDelete(path: string): string {
    return this.failedResponse({ type: 'fs.delete_response', path });
  }

  fsGitDiff(path: string): string {
    return this.failedResponse({ type: 'fs.git_diff_response', path });
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
