import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  X11_DISPLAY_ACCESS,
  accessibleX11DisplayNumbers,
  listX11DisplayNumbers,
  probeX11Display,
  refreshX11DisplayProbe,
  resetX11DisplayProbeForTests,
  x11DisplayProbeIsStale,
} from '../../src/node/linux-x11-display.js';
import { linuxGraphicalDisplayAvailable } from '../../src/node/linux-desktop-environment.js';
import { resolveWorkerDisplayEnv } from '../../src/node/linux-remote-desktop-worker-host.js';

/** A stand-in X server: answers the connection setup with `reply` (1 ok, 0 failed, 2 authenticate). */
function fakeXServer(dir: string, number: number, reply: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once('data', () => socket.end(Buffer.from([reply, 0, 11, 0, 0, 0, 0, 0])));
      socket.on('error', () => undefined);
    });
    server.listen(join(dir, `X${number}`), () => resolve(server));
  });
}

describe('X11 display access probing', () => {
  let dir: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'x11-'));
    resetX11DisplayProbeForTests();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
    resetX11DisplayProbeForTests();
  });
  const serve = async (number: number, reply: number) => { servers.push(await fakeXServer(dir, number, reply)); };

  it('tells an open server from one that demands authorization', async () => {
    await serve(99, 1);
    await serve(1024, 0);
    await serve(1025, 2);
    expect(await probeX11Display(join(dir, 'X99'))).toBe(X11_DISPLAY_ACCESS.ACCESSIBLE);
    expect(await probeX11Display(join(dir, 'X1024'))).toBe(X11_DISPLAY_ACCESS.AUTH_REQUIRED);
    expect(await probeX11Display(join(dir, 'X1025'))).toBe(X11_DISPLAY_ACCESS.AUTH_REQUIRED);
    expect(await probeX11Display(join(dir, 'X7'))).toBe(X11_DISPLAY_ACCESS.UNREACHABLE);
  });

  it('lists only real display sockets, ascending', async () => {
    await serve(1024, 0);
    await serve(99, 1);
    expect(listX11DisplayNumbers(dir)).toEqual([99, 1024]);
    expect(listX11DisplayNumbers(join(dir, 'missing'))).toEqual([]);
  });

  it('a Wayland desktop with only greeter Xwayland sockets is not a usable display', async () => {
    await serve(1024, 0);
    await serve(1025, 0);
    // Before any probe the old rule holds: a socket exists.
    expect(linuxGraphicalDisplayAvailable(dir)).toBe(true);
    expect(await refreshX11DisplayProbe(dir)).toBe(true);
    expect(accessibleX11DisplayNumbers(dir)).toEqual([]);
    expect(linuxGraphicalDisplayAvailable(dir)).toBe(false);
    expect(x11DisplayProbeIsStale(dir)).toBe(false);
  });

  it('picks the openable display over a lower-numbered greeter socket, and reports changes', async () => {
    await serve(5, 0); // lowest number, but it rejects the worker
    await serve(99, 1);
    expect(await refreshX11DisplayProbe(dir)).toBe(true);
    expect(await refreshX11DisplayProbe(dir)).toBe(false); // nothing changed
    expect(accessibleX11DisplayNumbers(dir)).toEqual([99]);
    expect(linuxGraphicalDisplayAvailable(dir)).toBe(true);
    expect(resolveWorkerDisplayEnv({}, dir).DISPLAY).toBe(':99');
  });

  it('keeps the previous lowest-socket choice when nothing is openable, and never overrides an explicit DISPLAY', async () => {
    await serve(1024, 0);
    await refreshX11DisplayProbe(dir);
    expect(resolveWorkerDisplayEnv({}, dir).DISPLAY).toBe(':1024');
    expect(resolveWorkerDisplayEnv({ DISPLAY: ':3' }, dir).DISPLAY).toBe(':3');
  });
});
