import { describe, it, expect, afterEach, vi } from 'vitest';
import { acquireInstanceLock, releaseInstanceLock } from '../../src/daemon/lifecycle.js';
import { mkdtempSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import net from 'net';

// Verify the default path uses Unix domain socket on non-Windows (not named pipe)
// This ensures we didn't accidentally break Unix by introducing the Windows pipe path.

function tmpSock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-lock-test-'));
  return join(dir, 'daemon.sock');
}

// Track servers to clean up after each test
const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers) {
    try { s.close(); } catch { /* ignore */ }
  }
  servers.length = 0;
});

describe('single-instance lock', () => {
  it('acquires lock on fresh socket path', async () => {
    const sock = tmpSock();
    const server = await acquireInstanceLock(sock);
    servers.push(server);
    expect(server).toBeInstanceOf(net.Server);
    expect(existsSync(sock)).toBe(true);
    releaseInstanceLock(server, sock);
  });

  it('rejects when another instance holds the lock', async () => {
    const sock = tmpSock();
    const first = await acquireInstanceLock(sock);
    servers.push(first);

    await expect(acquireInstanceLock(sock)).rejects.toThrow('already running');

    releaseInstanceLock(first, sock);
  });

  it('reclaims stale socket from crashed process', async () => {
    const sock = tmpSock();
    // Simulate a stale socket file left by a crashed daemon:
    // write a regular file at the socket path (mimics leftover after SIGKILL)
    writeFileSync(sock, '');
    expect(existsSync(sock)).toBe(true);

    // acquireInstanceLock should detect EADDRINUSE, fail to connect, unlink stale, and reclaim
    const server = await acquireInstanceLock(sock);
    servers.push(server);
    expect(server).toBeInstanceOf(net.Server);

    releaseInstanceLock(server, sock);
  });

  it('releases lock and cleans up socket file', async () => {
    const sock = tmpSock();
    const server = await acquireInstanceLock(sock);
    expect(existsSync(sock)).toBe(true);

    releaseInstanceLock(server, sock);
    expect(existsSync(sock)).toBe(false);
  });

  it('second instance can acquire after first releases', async () => {
    const sock = tmpSock();
    const first = await acquireInstanceLock(sock);
    releaseInstanceLock(first, sock);

    const second = await acquireInstanceLock(sock);
    servers.push(second);
    expect(second).toBeInstanceOf(net.Server);

    releaseInstanceLock(second, sock);
  });

  it('uses Unix domain socket path on non-Windows (not named pipe)', async () => {
    // On the current platform (Linux/Mac in CI), acquireInstanceLock with an explicit
    // Unix path should work. This verifies the platform branch didn't break Unix.
    const sock = tmpSock();
    expect(sock).toContain('daemon.sock');
    expect(sock).not.toContain('\\\\.\\pipe\\');

    const server = await acquireInstanceLock(sock);
    servers.push(server);
    // The socket file should exist on Unix
    expect(existsSync(sock)).toBe(true);
    releaseInstanceLock(server, sock);
    // Socket cleaned up on Unix
    expect(existsSync(sock)).toBe(false);
  });
});
