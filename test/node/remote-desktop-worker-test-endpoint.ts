import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { remoteDesktopWorkerPipePath } from '../../src/node/remote-desktop-worker-host.js';

export type RemoteDesktopWorkerTestEndpointKind = 'windows_named_pipe' | 'unix_socket';

export interface RemoteDesktopWorkerTestEndpoint {
  readonly path: string;
  readonly kind: RemoteDesktopWorkerTestEndpointKind;
  cleanup(): void;
}

let endpointSequence = 0;

/**
 * Allocate a process-unique endpoint using the same platform contract as the
 * production worker host. Windows must use the named-pipe namespace: Node's
 * net.Server does not support a filesystem-shaped Unix-domain socket there.
 * Unix keeps a short filesystem socket path and removes it after each test.
 */
export function createRemoteDesktopWorkerTestEndpoint(
  namespace: string,
  platform: NodeJS.Platform = process.platform,
): RemoteDesktopWorkerTestEndpoint {
  const sequence = ++endpointSequence;
  const suffix = createHash('sha256')
    .update(`${process.pid}:${sequence}:${namespace}`)
    .digest('hex')
    .slice(0, 24);
  const path = remoteDesktopWorkerPipePath(`test-${suffix}`, platform);
  const kind = platform === 'win32' ? 'windows_named_pipe' : 'unix_socket';
  return {
    path,
    kind,
    cleanup: () => {
      if (kind === 'unix_socket') {
        try { rmSync(path, { force: true }); } catch { /* already absent */ }
      }
    },
  };
}
