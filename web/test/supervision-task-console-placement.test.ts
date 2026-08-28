/**
 * Toolbar placement is an explicit acceptance criterion: on desktop the ▥
 * task-console toggle sits in the top-right toolbar AFTER the 🌐 local-web-
 * preview button and BEFORE the window maximize control.
 *
 * This asserts source order in app.tsx rather than rendering the whole App.
 * That is a deliberate trade: rendering App here would need the entire session/
 * socket/router surface stubbed, and the thing being protected is precisely the
 * ORDER of three siblings in one JSX block — which a reorder would change here
 * and which no existing test covers.
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

function mobileToolbarBlock(): string {
  return boundedBlock('<div class="mobile-server-actions">', '<SessionTabs');
}

describe('supervision task console toolbar placement', () => {
  it('places the desktop toggle after the local-web-preview button and before maximize', () => {
    const block = desktopToolbarBlock();
    const globe = block.indexOf('🌐');
    const toggle = block.indexOf('<SupervisionTaskConsoleToggle');
    const maximize = block.indexOf('<DesktopWindowMaximizeButton');

    expect(globe, 'globe button present').toBeGreaterThan(-1);
    expect(toggle, 'console toggle present in the desktop toolbar').toBeGreaterThan(-1);
    expect(maximize, 'maximize button present').toBeGreaterThan(-1);

    expect(toggle).toBeGreaterThan(globe);
    expect(toggle).toBeLessThan(maximize);
  });

  it('renders exactly one mobile toggle after local web preview using the one trigger ref', () => {
    const block = mobileToolbarBlock();
    const globe = block.indexOf('🌐');
    const toggles = [...block.matchAll(/<SupervisionTaskConsoleToggle/g)];
    expect(globe).toBeGreaterThan(-1);
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.index).toBeGreaterThan(globe);
    expect(block.match(/triggerRef=\{supervisionTaskConsoleToggleRef\}/g)).toHaveLength(1);
  });

  it('routes the desktop toggle through the shared visibility decision', () => {
    const block = desktopToolbarBlock();
    const toggle = block.indexOf('<SupervisionTaskConsoleToggle');
    const props = block.slice(toggle, toggle + 400);
    expect(props).toContain('visibility={supervisionTaskConsoleVisibility}');
  });

  it('routes the real mobile toggle through the same shared visibility decision', () => {
    const block = mobileToolbarBlock();
    const toggle = block.indexOf('<SupervisionTaskConsoleToggle');
    const props = block.slice(toggle, toggle + 400);
    expect(props).toContain('visibility={supervisionTaskConsoleVisibility}');
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

  it('restores and persists panel open state through the shared preferences helper', () => {
    expect(app).toMatch(/useState\(\s*\(\) => loadSupervisionTaskConsolePreferences\(supervisionTaskConsolePreferenceBounds\(\)\)\.open/);
    expect(app).toContain('saveSupervisionTaskConsolePreferences({ ...preferences, open: nextOpen }, bounds);');
    expect(app).toContain('saveSupervisionTaskConsolePreferences({ ...preferences, open: false }, bounds);');
    expect(app.match(/onToggle=\{toggleSupervisionTaskConsole\}/g)).toHaveLength(2);
    expect(app).toContain('onClose={closeSupervisionTaskConsole}');
  });
});
