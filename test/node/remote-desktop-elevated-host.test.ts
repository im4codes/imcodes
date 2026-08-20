import { describe, expect, it, vi, afterEach } from 'vitest';
import net from 'node:net';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_ELEVATED_MSG } from '../../shared/remote-desktop-elevated.js';
import { ElevatedRemoteDesktopHost } from '../../src/node/remote-desktop-elevated-host.js';

const secret = 'a'.repeat(43);
const requestId = 'request_12345678';
const sessionId = 'session_12345678';
const capability = 'b'.repeat(43);

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function prepareCommand(): Record<string, unknown> {
  return {
    type: REMOTE_DESKTOP_MSG.PREPARE,
    requestId,
    sessionId,
    capability,
    expiresAt: Date.now() + 60_000,
    leaseExpiresAt: Date.now() + 15_000,
    daemonGeneration: 4,
    mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    inputEpoch: 0,
    iceServers: ['stun:stun.example.test:3478'],
  };
}

async function startHost(overrides: {
  handle?: (command: unknown) => Promise<boolean>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-elevated-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const pipePath = join(dir, 'elevated.sock');
  const handled: unknown[] = [];
  const restricted: string[] = [];
  const worker = {
    handle: overrides.handle ?? (async (command: unknown) => { handled.push(command); return true; }),
    close: vi.fn(),
  };
  const host = new ElevatedRemoteDesktopHost({
    worker: worker as never,
    secret,
    pipePath,
    restrictPipe: (path) => { restricted.push(path); },
  });
  await host.listen();
  cleanup.push(() => host.close());
  return { host, pipePath, handled, restricted, worker };
}

function connect(pipePath: string) {
  const socket = net.createConnection({ path: pipePath });
  socket.setEncoding('utf8');
  const lines: Array<Record<string, unknown>> = [];
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf('\n');
    }
  });
  cleanup.push(() => { socket.destroy(); });
  const send = (message: Record<string, unknown>) => socket.write(`${JSON.stringify(message)}\n`);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return { socket, lines, send, closed };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('ElevatedRemoteDesktopHost', () => {
  it('restricts the pipe before serving anyone', async () => {
    const f = await startHost();
    expect(f.restricted).toEqual([f.pipePath]);
  });

  it('relays a command to the privileged worker once the secret checks out', async () => {
    const f = await startHost();
    const client = connect(f.pipePath);
    client.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.HELLO, secret });
    await waitFor(() => f.restricted.length > 0 && client.lines.length > 0, 'ready');
    expect(client.lines[0]).toMatchObject({ type: REMOTE_DESKTOP_ELEVATED_MSG.READY });

    client.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.COMMAND, command: prepareCommand() });
    await waitFor(() => f.handled.length === 1, 'command');
    expect(f.handled[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.PREPARE, sessionId });
  });

  it('drops a connection that presents the wrong secret', async () => {
    const f = await startHost();
    const client = connect(f.pipePath);
    client.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.HELLO, secret: 'c'.repeat(43) });
    await client.closed;
    expect(f.handled).toHaveLength(0);
  });

  it('drops a connection that sends commands before any hello', async () => {
    const f = await startHost();
    const client = connect(f.pipePath);
    client.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.COMMAND, command: prepareCommand() });
    await client.closed;
    expect(f.handled).toHaveLength(0);
  });

  it('relays worker replies back, and only well-formed ones', async () => {
    const f = await startHost({ handle: async () => false });
    const client = connect(f.pipePath);
    client.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.HELLO, secret });
    await waitFor(() => client.lines.length > 0, 'ready');
    client.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.COMMAND, command: prepareCommand() });
    // The worker refused, so the dispatcher answers with a terminal frame.
    await waitFor(() => client.lines.length > 1, 'terminal');
    expect(client.lines[1]).toMatchObject({
      type: REMOTE_DESKTOP_ELEVATED_MSG.EVENT,
      event: { type: REMOTE_DESKTOP_MSG.TERMINAL, reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED },
    });

    const before = client.lines.length;
    f.host.publish({ type: 'not.a.remote.desktop.message' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.lines).toHaveLength(before);
  });

  it('lets a restarted daemon replace the previous connection', async () => {
    const f = await startHost();
    const first = connect(f.pipePath);
    first.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.HELLO, secret });
    await waitFor(() => first.lines.length > 0, 'first ready');

    const second = connect(f.pipePath);
    second.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.HELLO, secret });
    await waitFor(() => second.lines.length > 0, 'second ready');
    await first.closed;

    second.send({ type: REMOTE_DESKTOP_ELEVATED_MSG.COMMAND, command: prepareCommand() });
    await waitFor(() => f.handled.length === 1, 'command from the replacement');
  });

  it('closes the privileged worker when it shuts down', async () => {
    const f = await startHost();
    f.host.close();
    expect(f.worker.close).toHaveBeenCalledTimes(1);
  });
});
