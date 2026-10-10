import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import notifyScript from '../../scripts/systemd-watchdog-notify.py?raw';

const PULSE_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 128;
const PYTHON_EXECUTABLES = ['/usr/bin/python3', '/usr/bin/python'] as const;

export interface SystemdWatchdogTransport {
  pulse(): Promise<void>;
  close(): void;
}

/**
 * One persistent, unit-owned sender. At most one pulse is pending, none are
 * queued. If the node event loop or connection activity stops, stdin receives
 * nothing and WatchdogSec still expires. Helper death/timeout permits a retry
 * on the next liveness tick, never on an independent retry timer.
 */
export function createSystemdWatchdogTransport(options: {
  socket?: string;
  python?: string;
  spawnHelper?: (file: string, args: string[], socket: string) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
} = {}): SystemdWatchdogTransport {
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready = false;
  let response = '';
  let pending: {
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;

  const fail = (error: Error): void => {
    const previous = child;
    child = null;
    ready = false;
    response = '';
    const pulse = pending;
    pending = null;
    if (pulse) {
      clearTimeout(pulse.timeout);
      pulse.reject(error);
    }
    previous?.kill();
  };

  const send = (): void => {
    const sender = child;
    if (!sender || !ready || !pending) return;
    sender.stdin.write('WATCHDOG\n', (error) => {
      if (error && child === sender) fail(error);
    });
  };

  const start = (): void => {
    const socket = options.socket ?? process.env.NOTIFY_SOCKET;
    if (!socket || (!socket.startsWith('/') && !socket.startsWith('@')) || socket.includes('\0')) {
      throw new Error('invalid_systemd_notify_socket');
    }
    const python = options.python ?? PYTHON_EXECUTABLES.find((path) => existsSync(path));
    if (!python || !PYTHON_EXECUTABLES.includes(python as typeof PYTHON_EXECUTABLES[number])) {
      throw new Error('systemd_watchdog_requires_system_python');
    }
    const sender = (options.spawnHelper ?? ((file, args, address) => spawn(file, args, {
      cwd: '/',
      // -E ignores PYTHONHOME/PYTHONPATH; -S avoids site customizations.
      env: { NOTIFY_SOCKET: address, ...(process.env.IMCODES_HOME ? { IMCODES_HOME: process.env.IMCODES_HOME } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })))(python, ['-E', '-S', '-u', '-c', notifyScript], socket);
    child = sender;
    ready = false;
    response = '';
    sender.on('error', (error) => { if (child === sender) fail(error); });
    sender.on('exit', () => {
      if (child === sender) fail(new Error('systemd_watchdog_helper_exited'));
    });
    sender.stdin.on('error', (error) => { if (child === sender) fail(error); });
    // Always drain; never pipe helper diagnostics/contents into production logs.
    sender.stderr.resume();
    sender.stdout.on('data', (data: Buffer) => {
      if (child !== sender) return;
      response += data.toString('utf8');
      if (response.length > MAX_RESPONSE_BYTES) return fail(new Error('invalid_systemd_watchdog_response'));
      let newline: number;
      while ((newline = response.indexOf('\n')) >= 0) {
        const line = response.slice(0, newline);
        response = response.slice(newline + 1);
        if (line === 'READY' && !ready) {
          ready = true;
          send();
        } else if (line === 'SENT' && ready && pending) {
          clearTimeout(pending.timeout);
          pending.resolve();
          pending = null;
        } else {
          fail(new Error('invalid_systemd_watchdog_response'));
          return;
        }
      }
    });
  };

  return {
    pulse(): Promise<void> {
      if (pending) return pending.promise;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const timeout = setTimeout(() => fail(new Error('systemd_watchdog_pulse_timeout')), options.timeoutMs ?? PULSE_TIMEOUT_MS);
      pending = { promise, resolve, reject, timeout };
      try {
        if (!child) start();
        else if (ready) send();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
      return promise;
    },
    close(): void { fail(new Error('systemd_watchdog_transport_closed')); },
  };
}
