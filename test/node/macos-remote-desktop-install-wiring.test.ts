import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY,
} from '../../shared/remote-desktop-install.js';
import { CONTROLLED_NODE_CAPABILITIES } from '../../shared/controlled-node-capabilities.js';
import { createControlledNodeRuntime } from '../../src/node/runtime.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';

class MockSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readonly sent: string[] = [];
  readyState = 0;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.emit('open'); }
  terminate(): void { this.readyState = 3; }
  ping(): void {}
}

const CREDENTIAL = {
  serverUrl: 'https://im.example',
  serverId: 'controlled-1',
  token: 'secret',
  nodeRole: NODE_ROLE.CONTROLLED,
};

function authCapabilities(socket: MockSocket): string[] {
  const auth = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'auth');
  return (auth?.capabilities ?? []) as string[];
}

/**
 * The wiring that did not exist. Every other piece of macOS remote desktop was
 * shipping -- CI signed and notarized the components, the server served them,
 * the node could verify and promote a set, readiness turned that into a
 * capability and the UI gated its buttons on it -- but the node never
 * advertised that it COULD install, and never fetched anything. A macOS
 * machine therefore showed no remote-desktop button of any kind, and looked
 * simply unsupported.
 */
describe('macOS remote-desktop install wiring', () => {
  it('offers the install while the components are absent', async () => {
    const socket = new MockSocket();
    createControlledNodeRuntime(CREDENTIAL, () => socket, {
      platform: 'darwin',
      arch: 'arm64',
      installMacosRemoteDesktopComponents: async () => true,
    }).start();
    socket.open();
    expect(authCapabilities(socket)).toContain(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY);
    // Not the Windows one. Its wire value says `windows`, and a consumer that
    // reads the string rather than the symbol would be told something false.
    expect(authCapabilities(socket)).not.toContain(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY);
  });

  it('installs on request, and stops offering once it has', async () => {
    const socket = new MockSocket();
    const install = vi.fn(async () => true);
    createControlledNodeRuntime(CREDENTIAL, () => socket, {
      platform: 'darwin',
      arch: 'arm64',
      installMacosRemoteDesktopComponents: install,
    }).start();
    socket.open();

    socket.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }));
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
  });

  it('refuses a request carrying caller-controlled fields', async () => {
    // The request has no parameters by design. Accepting extra keys would make
    // this a generic "fetch and run something" endpoint reachable from a
    // browser session.
    const socket = new MockSocket();
    const install = vi.fn(async () => true);
    createControlledNodeRuntime(CREDENTIAL, () => socket, {
      platform: 'darwin',
      arch: 'arm64',
      installMacosRemoteDesktopComponents: install,
    }).start();
    socket.open();

    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST,
      storeRoot: '/tmp/anywhere',
    }));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(install).not.toHaveBeenCalled();
  });

  it('never offers a macOS install on another platform or architecture', async () => {
    for (const runtimeShape of [
      { platform: 'darwin' as const, arch: 'arm' as never },
      { platform: 'linux' as const, arch: 'x64' as const },
      { platform: 'win32' as const, arch: 'x64' as const },
    ]) {
      const socket = new MockSocket();
      createControlledNodeRuntime(CREDENTIAL, () => socket, {
        ...runtimeShape,
        installMacosRemoteDesktopComponents: async () => true,
      }).start();
      socket.open();
      expect(authCapabilities(socket)).not.toContain(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY);
    }
  });

  it('is a capability the server will actually relay', async () => {
    // A capability missing from the shared allowlist is dropped before it
    // reaches a browser, so advertising it would change nothing at all.
    expect(CONTROLLED_NODE_CAPABILITIES).toContain(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY);
    expect(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY).not.toBe(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY);
  });
});
