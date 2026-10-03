import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT } from '../../shared/remote-desktop-local-management.js';
import {
  startRemoteDesktopLocalPanel,
  type RemoteDesktopLocalPanel,
} from '../../src/node/remote-desktop-local-panel.js';

const mac = process.platform === 'darwin' ? describe : describe.skip;
const execFileAsync = promisify(execFile);

mac('macOS aiDesk status client against the real local panel', () => {
  let root = '';
  let agent = '';
  let panel: RemoteDesktopLocalPanel;
  let paused = false;
  let connections: Array<{
    id: string;
    label: string;
    connectedAt: number;
    mode: typeof REMOTE_DESKTOP_ACCESS_MODE.VIEW | typeof REMOTE_DESKTOP_ACCESS_MODE.CONTROL;
  }> = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'imcodes-aidesk-status-client-'));
    agent = join(root, 'aidesk-agent');
    const source = resolve('native/macos-remote-desktop');
    execFileSync('/usr/bin/clang++', [
      '-std=c++20', '-fobjc-arc', '-O0', '-arch', process.arch,
      '-mmacosx-version-min=12.3', `-I${source}`,
      join(source, 'aidesk_agent_main.mm'),
      join(source, 'macos_permission_onboarding.mm'),
      '-framework', 'AppKit', '-framework', 'ApplicationServices',
      '-framework', 'CoreGraphics', '-framework', 'Foundation',
      '-framework', 'Security', '-o', agent,
    ], { stdio: 'pipe' });
    panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890',
      serverUrl: 'https://example.test/',
      status: () => ({ paused, connections }),
      setPaused: async () => {},
      stopAll: async () => {},
      disconnect: async () => false,
      port: 0,
    });
  }, 60_000);

  afterAll(async () => {
    await panel?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function probe() {
    const stateUrl = new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url);
    const { stdout } = await execFileAsync(agent, [
      '--aidesk-status-probe', stateUrl.href,
    ], { encoding: 'utf8', timeout: 15_000 });
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  it('keeps unauthenticated state private while its cookie-bootstrap path maps every state', async () => {
    const unauthenticated = await fetch(
      new URL(REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH, panel.url),
    );
    expect(unauthenticated.status).toBe(401);

    paused = false;
    connections = [];
    await expect(probe()).resolves.toMatchObject({
      httpStatus: 200, paused: false, viewers: 0, glyph: 'ai', color: 'idle', badge: '',
    });

    connections = [{
      id: 'one', label: '#1', connectedAt: Date.now(), mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    }];
    await expect(probe()).resolves.toMatchObject({ viewers: 1, glyph: '●', color: 'view', badge: '1' });

    connections.push({
      id: 'two', label: '#2', connectedAt: Date.now(), mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    });
    await expect(probe()).resolves.toMatchObject({ viewers: 2, glyph: '●', color: 'control', badge: '2' });

    connections = Array.from({ length: 12 }, (_, index) => ({
      id: `id-${index}`, label: `#${index + 1}`, connectedAt: Date.now(),
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    }));
    await expect(probe()).resolves.toMatchObject({ viewers: 12, color: 'view', badge: '9+' });

    paused = true;
    connections = [];
    await expect(probe()).resolves.toMatchObject({
      httpStatus: 200, paused: true, viewers: 0, glyph: 'Ⅱ', color: 'paused', badge: '',
    });
  }, 60_000);
});
