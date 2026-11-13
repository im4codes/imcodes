/**
 * Toolbar placement invariants:
 * - SupervisionTaskConsoleToggle is retired from both desktop and mobile toolbars.
 * - Desktop sidebar places the Cloud Docs button to the right of DaemonRemoteDesktopControl
 *   and to the left of the session-tree toggle (⊞).
 * - Mobile server actions bar replaces the retired task toggle after 🌐 (localWebPreview.title)
 *   with the Cloud Docs button, before view-toggle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(__dirname, '../src/app.tsx'), 'utf8');

function boundedBlock(startMarker: string, endMarker: string): string {
  const start = app.indexOf(startMarker);
  expect(start, `${startMarker} must exist`).toBeGreaterThan(-1);
  const end = app.indexOf(endMarker, start);
  expect(end, `${endMarker} must follow ${startMarker}`).toBeGreaterThan(start);
  return app.slice(start, end);
}

/** The actual active-session desktop toolbar, not the earlier empty-state toolbar. */
function desktopToolbarBlock(): string {
  return boundedBlock(
    '{/* Desktop view mode toggle — mobile uses the one in mobile-server-bar */}',
    '<div class="supervision-task-console-workspace">',
  );
}

function desktopSidebarToolbarBlock(): string {
  return boundedBlock(
    '<Sidebar',
    '<SharedEntriesPanel',
  );
}

function mobileToolbarBlock(): string {
  return boundedBlock('<div class="mobile-server-actions">', '<SessionTabs');
}

describe('toolbar placement & retired supervision task console toggle', () => {
  it('retires SupervisionTaskConsoleToggle from both desktop and mobile toolbars', () => {
    expect(desktopToolbarBlock()).not.toContain('<SupervisionTaskConsoleToggle');
    expect(mobileToolbarBlock()).not.toContain('<SupervisionTaskConsoleToggle');
    expect(app).not.toContain('<SupervisionTaskConsoleToggle');
  });

  it('places the desktop Cloud Docs button to the right of DaemonRemoteDesktopControl and left of session tree toggle', () => {
    const block = desktopSidebarToolbarBlock();
    const computerBtn = block.indexOf('<DaemonRemoteDesktopControl');
    const cloudDocsBtn = block.indexOf('data-testid="desktop-cloud-docs-btn"');
    const treeToggle = block.indexOf("trans('sidebar.sessionTree'");

    expect(computerBtn, 'computer button present in sidebar').toBeGreaterThan(-1);
    expect(cloudDocsBtn, 'Cloud Docs button present in sidebar').toBeGreaterThan(-1);
    expect(treeToggle, 'session tree toggle present in sidebar').toBeGreaterThan(-1);

    expect(cloudDocsBtn).toBeGreaterThan(computerBtn);
    expect(cloudDocsBtn).toBeLessThan(treeToggle);
  });

  it('places ControlledNodeQuickMenu immediately right of DaemonRemoteDesktopControl and left of Files inside mobile-server-actions', () => {
    const block = mobileToolbarBlock();
    const rd = block.indexOf('<DaemonRemoteDesktopControl');
    const quickMenu = block.indexOf('<ControlledNodeQuickMenu');
    const filesBtn = block.indexOf('📁');

    expect(rd, 'mobile DaemonRemoteDesktopControl present').toBeGreaterThan(-1);
    expect(quickMenu, 'mobile ControlledNodeQuickMenu present').toBeGreaterThan(-1);
    expect(filesBtn, 'mobile Files button present').toBeGreaterThan(-1);

    expect(quickMenu).toBeGreaterThan(rd);
    expect(quickMenu).toBeLessThan(filesBtn);
    expect(block).toContain('mobile-remote-desktop-group');
  });

  it('places the mobile Cloud Docs button directly to the right of 🌐 and before view-toggle', () => {
    const block = mobileToolbarBlock();
    const globe = block.indexOf('🌐');
    const cloudDocsBtn = block.indexOf('data-testid="mobile-cloud-docs-btn"');
    const viewToggle = block.indexOf('data-onboarding="view-toggle"');

    expect(globe, 'globe button present in mobile bar').toBeGreaterThan(-1);
    expect(cloudDocsBtn, 'Cloud Docs button present in mobile bar').toBeGreaterThan(-1);
    expect(viewToggle, 'view toggle present in mobile bar').toBeGreaterThan(-1);

    expect(cloudDocsBtn).toBeGreaterThan(globe);
    expect(cloudDocsBtn).toBeLessThan(viewToggle);
  });

  it('gates the panel with the shared visibility helper and never duplicates a local role predicate', () => {
    const workspace = boundedBlock(
      '<div class="supervision-task-console-workspace">',
      '{/* Desktop floating file browser */}',
    );
    expect(app).toContain('const canViewTaskConsole = canViewSupervisionTaskConsole(supervisionTaskConsoleVisibility);');
    expect(app).toMatch(/sharedAccessRole: selectedShareTarget\s*\? \(activeSessionInfo\?\.sharedState\?\.effectiveRole \?\? null\)\s*: null/);
    expect(workspace.match(/showSupervisionTaskConsole && canViewTaskConsole && activeSessionInfo/g)).toHaveLength(1);
    expect(workspace).not.toMatch(/role === 'brain'/);
    expect(workspace).toContain("readOnly={sharedAccessRole === 'viewer'}");
    expect(app.match(/<SupervisionTaskConsole(?=\s)/g)).toHaveLength(1);
  });

  it('binds cached projections to the full authenticated authority and evicts them on lost access', () => {
    const workspace = boundedBlock(
      '<div class="supervision-task-console-workspace">',
      '{/* Desktop floating file browser */}',
    );
    expect(workspace).toContain('key={`${auth.userId}:${selectedServerId}:${activeSessionInfo.project}:${activeSessionInfo.name}`}');
    expect(workspace).toContain('userId={auth.userId}');
    expect(workspace).toContain('serverId={selectedServerId!}');
    expect(app).toMatch(/if \(!auth \|\| canViewTaskConsole \|\| !selectedServerId \|\| !activeSessionInfo\) return;[\s\S]*?clearSupervisionTaskConsoleCache\(\{[\s\S]*?userId: auth\.userId,[\s\S]*?serverId: selectedServerId,[\s\S]*?projectName: activeSessionInfo\.project,[\s\S]*?coordinatorSessionName: activeSessionInfo\.name/);
    expect(app).toContain('if (!nextUserId) clearAllSupervisionTaskConsoleCaches();');
  });

  it('mounts CloudDocsPanel inside FloatingPanel when showCloudDocs is enabled', () => {
    expect(app).toContain('id={DESKTOP_WINDOW_IDS.cloudDocs}');
    expect(app).toContain('<CloudDocsPanel />');
  });
});
