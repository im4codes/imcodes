import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import {
  REMOTE_DESKTOP_ELEVATED_LIMITS,
  REMOTE_DESKTOP_ELEVATED_MSG,
  REMOTE_DESKTOP_ELEVATED_PIPE,
  validateRemoteDesktopElevatedHello,
} from '../../shared/remote-desktop-elevated.js';
import { validateRemoteDesktopDaemonMessage } from '../../shared/remote-desktop.js';
import { dispatchRemoteDesktopCommand } from './remote-desktop-dispatch.js';
import type { RemoteDesktopCommandTarget } from './remote-desktop-dispatch.js';

/**
 * Constant-time comparison that does not leak whether the lengths matched.
 * A mismatched length is compared against the expected value so the work done
 * is the same either way.
 */
function secretMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface ElevatedRemoteDesktopHostOptions {
  /** The worker host, already configured with the LocalSystem launch defaults. */
  worker: RemoteDesktopCommandTarget & { close(): void };
  /** What a connecting daemon must present. Written to an ACL-restricted file. */
  secret: string;
  pipePath?: string;
  /** Restrict who may open the pipe. Applied after listen, before serving. */
  restrictPipe?: (pipePath: string) => Promise<void> | void;
  onError?: (error: Error) => void;
}

/**
 * The LocalSystem side of login-screen control.
 *
 * It owns a worker host with the privileged launch defaults — the same ones the
 * controlled node uses, which can put the worker on the Winlogon desktop — and
 * serves exactly one thing: validated remote-desktop commands relayed by the
 * user-level daemon. It holds no server credential, opens no outbound
 * connection, and never sees media or input; those flow directly between the
 * worker and the browser as they always have.
 *
 * One connection is served at a time. A second daemon connecting replaces the
 * first, so a restarted daemon reattaches rather than being locked out by a
 * half-closed socket.
 */
export class ElevatedRemoteDesktopHost {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private buffer = '';
  private closing = false;

  constructor(private readonly options: ElevatedRemoteDesktopHostOptions) {}

  async listen(): Promise<void> {
    const pipePath = this.options.pipePath ?? REMOTE_DESKTOP_ELEVATED_PIPE;
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      this.server = server;
      server.once('error', reject);
      server.listen({ path: pipePath }, () => {
        server.off('error', reject);
        server.on('error', (error) => this.options.onError?.(error));
        resolve();
      });
    });
    // The default DACL on a SYSTEM-created pipe already excludes ordinary users;
    // this narrows it to the single account the feature was enabled for.
    await this.options.restrictPipe?.(pipePath);
  }

  private accept(socket: net.Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    let authenticated = false;
    const helloTimer = setTimeout(() => {
      if (!authenticated) socket.destroy();
    }, REMOTE_DESKTOP_ELEVATED_LIMITS.HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    socket.setEncoding('utf8');
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.client === socket) {
        this.client = null;
        this.buffer = '';
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > REMOTE_DESKTOP_ELEVATED_LIMITS.MAX_LINE_BYTES) {
        socket.destroy();
        this.buffer = '';
        return;
      }
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!authenticated) {
          if (!this.authenticate(line)) {
            socket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(helloTimer);
          // Replace any previous daemon: a restarted one must be able to
          // reattach instead of being refused by a socket nobody will close.
          if (this.client && this.client !== socket) this.client.destroy();
          this.client = socket;
          this.write(socket, { type: REMOTE_DESKTOP_ELEVATED_MSG.READY });
        } else {
          void this.handleLine(socket, line);
        }
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  private authenticate(line: string): boolean {
    try {
      return validateRemoteDesktopElevatedHello(
        JSON.parse(line),
        this.options.secret,
        secretMatches,
      );
    } catch {
      return false;
    }
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const envelope = parsed as Record<string, unknown>;
    if (envelope.type !== REMOTE_DESKTOP_ELEVATED_MSG.COMMAND) return;
    const command = envelope.command;
    if (!command || typeof command !== 'object') return;
    // The command is re-validated here rather than trusted from the relay: this
    // side runs as LocalSystem, and the daemon is the lower-privileged party.
    await dispatchRemoteDesktopCommand({
      message: command as Record<string, unknown>,
      enabled: true,
      target: this.options.worker,
      send: (reply) => {
        if (this.client === socket) this.relay(socket, reply);
      },
    });
  }

  /** Relay a worker message back, dropping anything that is not one. */
  private relay(socket: net.Socket, message: Record<string, unknown>): void {
    const validated = validateRemoteDesktopDaemonMessage(message);
    if (!validated.ok) return;
    this.write(socket, { type: REMOTE_DESKTOP_ELEVATED_MSG.EVENT, event: validated.value });
  }

  /** Worker-originated messages arrive outside a command turn too. */
  publish(message: Record<string, unknown>): void {
    const socket = this.client;
    if (socket) this.relay(socket, message);
  }

  private write(socket: net.Socket, message: Record<string, unknown>): void {
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      socket.destroy();
    }
  }

  close(): void {
    this.closing = true;
    this.client?.destroy();
    this.client = null;
    this.server?.close();
    this.server = null;
    this.options.worker.close();
  }
}
