import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';
import {
  clampGeometryToWorkspace,
  geometryFromWorkspace,
  normalizeWindowGeometry,
  reserveWorkspaceBottom,
  resolveSessionTabsBottom,
  resolveFrontmostMaximized,
  shouldPersistGeometry,
  viewportWorkspaceBelowSessionTabs,
  workspaceBoundsFromRect,
  type WindowGeometry,
  type WorkspaceBounds,
} from '../src/desktop-window-maximize.js';

function rectWithBottom(bottom: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: bottom,
    top: 0,
    right: 0,
    bottom,
    left: 0,
    toJSON: () => ({}),
  };
}

describe('desktop-window-maximize helpers', () => {
  const workspace: WorkspaceBounds = { x: 80, y: 48, w: 900, h: 640 };

  afterEach(() => {
    document.querySelectorAll('.tab-bar').forEach((node) => node.remove());
  });

  it('converts workspace bounds into exact maximized geometry', () => {
    expect(geometryFromWorkspace(workspace)).toEqual({ x: 80, y: 48, w: 900, h: 640 });
  });

  it('normalizes DOMRect-like bounds from the workspace anchor', () => {
    expect(workspaceBoundsFromRect({ left: 12, top: 34, width: 560, height: 420 })).toEqual({
      x: 12,
      y: 34,
      w: 560,
      h: 420,
    });
  });

  it('reserves bottom space for the sub-session button strip', () => {
    expect(reserveWorkspaceBottom({ x: 12, y: 34, w: 560, h: 420 })).toEqual({
      x: 12,
      y: 34,
      w: 560,
      h: 320,
    });
  });

  it('uses the session tab button bottom as the desktop floating window top bound', () => {
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    tabBar.getBoundingClientRect = () => rectWithBottom(72);
    const tabButton = document.createElement('button');
    tabButton.setAttribute('role', 'tab');
    tabButton.getBoundingClientRect = () => rectWithBottom(44);
    tabBar.appendChild(tabButton);
    document.body.appendChild(tabBar);

    expect(resolveSessionTabsBottom()).toBe(44);
    expect(viewportWorkspaceBelowSessionTabs({
      viewportWidth: 1280,
      viewportHeight: 900,
      minW: 360,
      minH: 280,
    })).toEqual({
      x: 0,
      y: 44,
      w: 1280,
      h: 856,
    });

    tabBar.remove();
  });

  it('falls back to the session tab bar bottom when there are no tab buttons', () => {
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    tabBar.getBoundingClientRect = () => rectWithBottom(38);
    document.body.appendChild(tabBar);

    expect(resolveSessionTabsBottom()).toBe(38);

    tabBar.remove();
  });

  it('clamps restore geometry into the current workspace without forcing maximized size', () => {
    const geometry: WindowGeometry = { x: -500, y: -20, w: 420, h: 360 };

    expect(clampGeometryToWorkspace(geometry, workspace, { minW: 300, minH: 200, visibleMargin: 32 })).toEqual({
      x: 80 + 32 - 420,
      y: 48,
      w: 420,
      h: 360,
    });
  });

  it('caps oversized normal geometry to the workspace while preserving minimums', () => {
    expect(clampGeometryToWorkspace({ x: 80, y: 48, w: 2000, h: 10 }, workspace, { minW: 300, minH: 200 })).toEqual({
      x: 80,
      y: 48,
      w: 900,
      h: 200,
    });
  });

  it('gates normal geometry persistence while maximized', () => {
    expect(shouldPersistGeometry(false)).toBe(true);
    expect(shouldPersistGeometry(true)).toBe(false);
  });

  it('normalizes malformed stored geometry before clamping', () => {
    const fallback: WindowGeometry = { x: 10, y: 20, w: 300, h: 240 };
    const normalized = normalizeWindowGeometry({ x: Number.NaN, y: '44', w: 'bad', h: Infinity }, fallback);

    expect(normalized).toEqual({ x: 10, y: 44, w: 300, h: 240 });
    expect(clampGeometryToWorkspace(normalized, workspace, { minW: 200, minH: 120 })).toEqual({
      x: 10,
      y: 48,
      w: 300,
      h: 240,
    });
  });

  it('resolves the frontmost maximized id from back-to-front stack order', () => {
    expect(resolveFrontmostMaximized(['filebrowser', 'sub:a', 'sub:b'], new Set(['filebrowser', 'sub:a']))).toBe('sub:a');
    expect(resolveFrontmostMaximized([{ id: 'filebrowser' }, { id: 'sub:a' }, { id: 'sub:b' }], ['sub:b', 'sub:a'])).toBe('sub:b');
    expect(resolveFrontmostMaximized(['filebrowser'], [])).toBeNull();
  });

  it('keeps shared window chrome labels present in every supported locale', () => {
    const webRoot = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(webRoot, 'src/i18n/locales', `${locale}.json`), 'utf8')) as {
        window?: Record<string, string>;
      };
      expect(messages.window?.maximize, locale).toEqual(expect.any(String));
      expect(messages.window?.restore, locale).toEqual(expect.any(String));
      expect(messages.window?.minimize, locale).toEqual(expect.any(String));
      expect(messages.window?.close, locale).toEqual(expect.any(String));
      expect(messages.window?.hide, locale).toEqual(expect.any(String));
    }
  });
});
