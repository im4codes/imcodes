import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(resolve(__dirname, '../src/app.tsx'), 'utf8');

describe('remote desktop workspace App integration', () => {
  it('uses one stack root and routes every existing App entry point through one open action', () => {
    expect(appSource).not.toContain('remoteDesktopMachine');
    expect(appSource).not.toContain('DESKTOP_WINDOW_IDS.remoteDesktop(');
    expect(appSource.match(/<RemoteDesktopWorkspace\b/g)).toHaveLength(1);
    expect(appSource).toContain('ensureDesktopWindow(REMOTE_DESKTOP_WORKSPACE_WINDOW_ID');

    const openActionBindings = appSource.match(/(?:onOpenRemoteDesktop|onOpen)=\{openRemoteDesktop\}/g) ?? [];
    expect(openActionBindings.length).toBeGreaterThanOrEqual(6);
  });

  it('clears protected tabs and all manager owners when authentication disappears', () => {
    expect(appSource).toMatch(/if \(auth\) return;[\s\S]*remoteDesktopConnectionManager\.stopAll\(REMOTE_DESKTOP_STOP_ORIGIN\.APP_SIGN_OUT\);[\s\S]*setRemoteDesktopWorkspace\(createRemoteDesktopWorkspaceState\(\)\);/);
    expect(appSource).toContain('removeDesktopWindow(REMOTE_DESKTOP_WORKSPACE_WINDOW_ID);');
  });
});
