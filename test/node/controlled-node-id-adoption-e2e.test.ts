import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { createControlledNodeIdAdopter } from '../../src/node/controlled-node-id-adoption.js';
import { loadCredential, persistCredential } from '../../src/node/enrollment.js';
import { startRemoteDesktopLocalPanel, type RemoteDesktopLocalPanel } from '../../src/node/remote-desktop-local-panel.js';

const SERVER_ID = '34f0bb116c897282b863d4391fd517a0';
const NODE_ID = '9909368908';
const roots: string[] = [];
const panels: RemoteDesktopLocalPanel[] = [];

afterEach(async () => {
  await Promise.all(panels.splice(0).map((panel) => panel.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The credential exactly as a node enrolled before public IDs existed holds it: six keys, no `nodeId`. */
async function legacyCredentialFile() {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-nodeid-adopt-'));
  roots.push(root);
  const path = join(root, 'credential.json');
  const legacy = {
    serverId: SERVER_ID, token: 'secret-token', serverUrl: 'https://im.example', nodeRole: NODE_ROLE.CONTROLLED,
    refName: 'desktop-tvo1ku1-34f0bb', displayName: 'DESKTOP-TVO1KU1 (win)',
  };
  await persistCredential(legacy as never, path);
  return { path, legacy };
}

describe('a pre-migration node gets its local management panel once the server tells it its ID', () => {
  it('has no panel before, writes the ID into the protected credential, and serves the panel afterwards (no restart)', async () => {
    const { path, legacy } = await legacyCredentialFile();
    const before = await loadCredential(path);
    expect(before?.nodeId).toBeUndefined();

    let panel: RemoteDesktopLocalPanel | null = null;
    const adopt = createControlledNodeIdAdopter({
      credential: before!,
      persist: (credential) => persistCredential(credential, path),
      start: async (nodeId) => {
        panel = await startRemoteDesktopLocalPanel({
          publicNodeId: nodeId, serverUrl: before!.serverUrl, host: '127.0.0.1', port: 0,
          status: () => ({ paused: false, connections: [] }),
          setPaused: async () => undefined, stopAll: async () => undefined, disconnect: async () => false,
        });
        panels.push(panel);
      },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    // Nothing is listening until the node is told its ID: this is what the user saw (the indicator opens a page that never loads).
    expect(panel).toBeNull();

    await adopt({ nodeId: NODE_ID, serverId: SERVER_ID });

    // The credential now carries the ID, every other field untouched, and stays protected.
    const after = await loadCredential(path);
    expect(after).toEqual({ ...legacy, nodeId: NODE_ID });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).nodeId).toBe(NODE_ID);

    // And the panel the indicator opens is up, serving this node's ID.
    expect(panel).not.toBeNull();
    const response = await fetch((panel as unknown as RemoteDesktopLocalPanel).url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(NODE_ID);
  });

  it('leaves the node online and the panel up when the credential cannot be written, and keeps what it had', async () => {
    const { path, legacy } = await legacyCredentialFile();
    const credential = (await loadCredential(path))!;
    const start = vi.fn(async () => undefined);
    const adopt = createControlledNodeIdAdopter({
      credential,
      persist: async () => { throw new Error('EACCES: credential directory is read-only'); },
      start, log: { info: vi.fn(), warn: vi.fn() },
    });
    await expect(adopt({ nodeId: NODE_ID, serverId: SERVER_ID })).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledWith(NODE_ID);
    expect(await loadCredential(path)).toEqual(legacy);
  });

  it('keeps a credential that already holds an ID, whatever the server offers', async () => {
    const { path } = await legacyCredentialFile();
    const held = { ...(await loadCredential(path))!, nodeId: '1234567890' };
    await persistCredential(held, path);
    const persist = vi.fn();
    const adopt = createControlledNodeIdAdopter({ credential: held, persist, start: vi.fn(), log: { info: vi.fn(), warn: vi.fn() } });
    await adopt({ nodeId: NODE_ID, serverId: SERVER_ID });
    expect(persist).not.toHaveBeenCalled();
    expect((await loadCredential(path))?.nodeId).toBe('1234567890');
  });
});
