import { writeFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRemoteDesktopWorkerTestEndpoint } from './remote-desktop-worker-test-endpoint.js';

describe('remote desktop worker test endpoints', () => {
  it('uses the Windows named-pipe namespace instead of a filesystem UDS path', () => {
    const endpoint = createRemoteDesktopWorkerTestEndpoint('windows-shape', 'win32');
    expect(endpoint.kind).toBe('windows_named_pipe');
    expect(endpoint.path).toMatch(/^\\\\\.\\pipe\\imcodes-remote-desktop-test-[a-f0-9]{24}$/);
    expect(endpoint.path).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('allocates distinct endpoints for concurrent workers in the same namespace', () => {
    const first = createRemoteDesktopWorkerTestEndpoint('concurrent-workers', 'win32');
    const second = createRemoteDesktopWorkerTestEndpoint('concurrent-workers', 'win32');
    expect(first.path).not.toBe(second.path);
  });

  it('preserves Unix socket cleanup without touching the Windows named-pipe namespace', () => {
    const endpoint = createRemoteDesktopWorkerTestEndpoint('unix-cleanup', 'linux');
    expect(endpoint.kind).toBe('unix_socket');
    expect(endpoint.path).toMatch(/\.sock$/);
    writeFileSync(endpoint.path, 'stale-fixture');
    expect(existsSync(endpoint.path)).toBe(true);
    endpoint.cleanup();
    expect(existsSync(endpoint.path)).toBe(false);
  });
});
