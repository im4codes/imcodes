import net from 'node:net';
import {
  REMOTE_DESKTOP_ELEVATED_LIMITS,
  REMOTE_DESKTOP_ELEVATED_MSG,
  REMOTE_DESKTOP_ELEVATED_PIPE,
} from '../../shared/remote-desktop-elevated.js';
import {
  validateRemoteDesktopDaemonMessage,
  type RemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';

export interface ElevatedRemoteDesktopRelayOptions {
  /** Relay a worker message on to the server (and thus the browser). */
  send(message: Record<string, unknown>): void;
  /** Read the secret the elevated helper wrote for this user. */
  readSecret(): Promise<string>;
  pipePath?: string;
  connectTimeoutMs?: number;
  connectImpl?: typeof net.createConnection;
}

/**
 * The daemon's view of the elevated helper.
 *
 * Interchangeable with an in-session worker host — it answers the same
 * `handle`/`close` contract — so enabling login-screen control swaps the backend
 * without touching signalling, authority or the browser. Commands go up the pipe
 * and the helper's replies come back down; the daemon inspects neither beyond
 * validating them, and never sees media or input either way.
 */
export class ElevatedRemoteDesktopRelay {
  private socket: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private closed = false;

  constructor(private readonly options: ElevatedRemoteDesktopRelayOptions) {}

  /** Send one command. Returns false when the helper cannot be reached. */
  async handle(command: RemoteDesktopDaemonCommand): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.connect();
    } catch {
      return false;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(`${JSON.stringify({
        type: REMOTE_DESKTOP_ELEVATED_MSG.COMMAND,
        command,
      })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Connect and complete the hello, at most once at a time. A failed attempt
   * clears the memo so the next command retries rather than inheriting it — the
   * helper may simply not have finished starting at boot.
   */
  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return this.ready ?? Promise.resolve();
    if (this.ready) return this.ready;
    this.ready = this.openSocket().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async openSocket(): Promise<void> {
    const secret = await this.options.readSecret();
    const pipePath = this.options.pipePath ?? REMOTE_DESKTOP_ELEVATED_PIPE;
    await new Promise<void>((resolve, reject) => {
      const socket = (this.options.connectImpl ?? net.createConnection)({ path: pipePath });
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new Error('remote_desktop_elevated_connect_timeout'));
      }, this.options.connectTimeoutMs ?? REMOTE_DESKTOP_ELEVATED_LIMITS.CONNECT_TIMEOUT_MS);
      timer.unref?.();
      const fail = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        if (settled) return;
        settled = true;
        reject(error);
      };
      socket.setEncoding('utf8');
      socket.once('error', fail);
      socket.on('data', (chunk: string) => this.consume(socket, String(chunk), () => {
        clearTimeout(timer);
        socket.off('error', fail);
        socket.on('error', () => socket.destroy());
        this.socket = socket;
        if (settled) return;
        settled = true;
        resolve();
      }));
      socket.on('close', () => {
        clearTimeout(timer);
        if (this.socket === socket) {
          this.socket = null;
          this.ready = null;
          this.buffer = '';
        }
        // A helper that rejects the hello just hangs up. Without this the
        // connect promise would never settle and every later command would
        // await it forever instead of failing over to the in-session worker.
        fail(new Error('remote_desktop_elevated_closed'));
      });
      socket.write(`${JSON.stringify({
        type: REMOTE_DESKTOP_ELEVATED_MSG.HELLO,
        secret,
      })}\n`);
    });
  }

  private consume(socket: net.Socket, chunk: string, onReady: () => void): void {
    this.buffer += chunk;
    if (this.buffer.length > REMOTE_DESKTOP_ELEVATED_LIMITS.MAX_LINE_BYTES) {
      this.buffer = '';
      socket.destroy();
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const message = parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : null;
      if (message?.type === REMOTE_DESKTOP_ELEVATED_MSG.READY) {
        onReady();
      } else if (message?.type === REMOTE_DESKTOP_ELEVATED_MSG.EVENT) {
        // Validated again on the way down: the helper is the more privileged
        // party, but the browser is the one that has to render this.
        const event = validateRemoteDesktopDaemonMessage(message.event);
        if (event.ok) this.options.send(event.value as unknown as Record<string, unknown>);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    this.ready = null;
  }
}
