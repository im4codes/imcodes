import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import {
  FILE_TRANSFER_DIRECTORY_PATH,
  isFileTransferWellKnownDirectoryPath,
} from '../../shared/transport/file-transfer.js';
import {
  isPointOverRemoteDesktopOverlay,
  remoteDesktopFileWindowDefaultSize,
  remoteDesktopFileWindowWorkspace,
  REMOTE_DESKTOP_OVERLAY_CLASS,
} from '../src/remote-desktop-pointer-overlay.js';

const read = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  'utf8',
);

const styles = read('../src/styles.css');
const fileBrowser = read('../src/components/FileBrowser.tsx');
const remoteDesktop = read('../src/components/RemoteDesktopPanel.tsx');

/** The body of the first rule with this exact selector, at line start. */
function ruleBody(selector: string): string {
  const index = styles.indexOf(`\n${selector} {`);
  expect(index, `no rule for ${selector}`).toBeGreaterThan(-1);
  const start = styles.indexOf('{', index);
  const end = styles.indexOf('}', start);
  return styles.slice(start + 1, end);
}

describe('the file drawer scrolls instead of clipping', () => {
  /**
   * The reported bug: the directory tree would not scroll, and once it grew
   * tall the transfer list vanished. Both came from ONE cause -- the drawer's
   * grid rows were implicitly `auto`, so nothing bounded the explorer, and
   * `overflow-y: auto` deeper down had no bounded ancestor to scroll against.
   *
   * jsdom has no layout engine, so this pins the CSS contract that makes the
   * scroll possible rather than the pixels. Every assertion below is a link in
   * the chain from the drawer down to `.fb-tree`; break any one and the tree
   * grows unbounded again.
   */
  it('bounds the explorer row so inner overflow can scroll', () => {
    const drawer = ruleBody('.remote-desktop-file-drawer');
    expect(drawer).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  });

  it('lets every ancestor of the tree shrink below its content', () => {
    // `min-height: 0` is the part everyone forgets: a grid/flex item defaults
    // to `min-height: auto`, which refuses to shrink and silently defeats the
    // 1fr above it.
    expect(ruleBody('.remote-desktop-file-drawer')).toMatch(/min-height:\s*0/);
    expect(ruleBody('.remote-desktop-file-explorer')).toMatch(/min-height:\s*0/);
    expect(ruleBody('.remote-desktop-file-pane')).toMatch(/min-height:\s*0/);
    expect(ruleBody('.remote-desktop-remote-browser')).toMatch(/min-height:\s*0/);
  });

  it('does not reintroduce a fixed floor on the explorer', () => {
    // A `min-height: 360px` here is equivalent to an auto row: the row can no
    // longer shrink, so the 1fr stops meaning anything.
    expect(ruleBody('.remote-desktop-file-explorer')).not.toMatch(/min-height:\s*\d+px/);
    expect(ruleBody('.remote-desktop-file-pane')).not.toMatch(/min-height:\s*\d+px/);
  });

  it('keeps exactly one rule for the transfer list', () => {
    // There used to be two identical selectors with different max-heights;
    // whichever came last silently won.
    const occurrences = styles.split('.remote-desktop-file-drawer .remote-desktop-transfer-list {').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('the file drawer is its own window', () => {
  it('reuses FloatingPanel rather than hand-rolling drag and resize', () => {
    expect(remoteDesktop).toContain('className={REMOTE_DESKTOP_OVERLAY_CLASS}');
    expect(remoteDesktop).toMatch(/dragHandleSelector=("|\{')\.remote-desktop-file-drawer-head/);
  });

  it('gives the file window a stacking order above its parent panel', () => {
    expect(remoteDesktop).toMatch(/zIndex=\{\(zIndex \?\? 10020\) \+ 2\}/);
  });

  it('no longer positions itself, so the window owns its geometry', () => {
    const drawer = ruleBody('.remote-desktop-file-drawer');
    expect(drawer).not.toMatch(/position:\s*absolute/);
    expect(drawer).not.toMatch(/\bbottom:\s*58px/);
  });

  it('stays inside the remote desktop panel so fullscreen still paints it', () => {
    // `.remote-desktop-panel:fullscreen` exists; only the fullscreen element's
    // subtree is rendered, so a portal to <body> would make the window vanish
    // exactly when the user most wants it.
    expect(styles).toContain('.remote-desktop-panel:fullscreen');
    const drawerAt = remoteDesktop.indexOf('className={REMOTE_DESKTOP_OVERLAY_CLASS}');
    const bodyReturn = remoteDesktop.indexOf('if (embedded) return panelBody;');
    expect(drawerAt).toBeGreaterThan(-1);
    expect(drawerAt, 'the window must be rendered within panelBody').toBeLessThan(bodyReturn);
  });
});

describe('the file window opens at the remote desktop window size', () => {
  /**
   * Two requirements pulling against each other, so both are asserted.
   *
   * "Open it the same size as the remote desktop window so I never have to
   * resize it" -- and -- the earlier report that drag "follows for a bit then
   * stops" and resize "grows a little then breaks". Neither gesture was
   * broken: FloatingPanel confines a window to `workspace - size`, so a window
   * the size of the workspace cannot move at all. Matching the host exactly is
   * therefore right only while it still leaves travel.
   */
  const MIN_W = 720;
  const MIN_H = 420;
  const MIN_TRAVEL = 80;

  const size = (workspace: { w: number; h: number }, host?: { width: number; height: number }) =>
    remoteDesktopFileWindowDefaultSize({
      viewportWidth: workspace.w,
      viewportHeight: workspace.h,
      hostSize: host ?? null,
      workspace,
    });

  it('matches the host window exactly when there is room to spare', () => {
    // The stated request, in the case where nothing has to give.
    const result = size({ w: 1920, h: 1000 }, { width: 1200, height: 760 });
    expect(result).toEqual({ width: 1200, height: 760 });
  });

  it('still matches when the host is only just small enough', () => {
    // Host leaves exactly the travel floor: no adjustment is warranted.
    const result = size({ w: 1400, h: 900 }, { width: 1320, height: 820 });
    expect(result).toEqual({ width: 1320, height: 820 });
  });

  it('gives back travel when the host already fills the workspace', () => {
    // The 13" case: the desktop window is itself clamped to the workspace, so
    // copying it verbatim would produce a window that cannot be dragged.
    const workspace = { w: 1440, h: 636 };
    const result = size(workspace, { width: 1440, height: 636 });
    expect(workspace.w - result.width, 'horizontal travel').toBeGreaterThanOrEqual(MIN_TRAVEL);
    expect(workspace.h - result.height, 'vertical travel').toBeGreaterThanOrEqual(MIN_TRAVEL);
  });

  it('prefers the minimum size over the travel floor when they conflict', () => {
    // A workspace barely larger than the minimum cannot supply both; the
    // window must stay usable rather than shrink below its own floor.
    const result = size({ w: 760, h: 460 }, { width: 760, height: 460 });
    expect(result.width).toBe(MIN_W);
    expect(result.height).toBe(MIN_H);
  });

  it('raises a host smaller than the minimum up to the minimum', () => {
    // A collapsed or mid-animation host measurement must not produce a window
    // below its own floor -- the clamp would then fight the minimum and the
    // window would jump on first paint.
    const result = size({ w: 1920, h: 1000 }, { width: 300, height: 200 });
    expect(result.width).toBe(MIN_W);
    expect(result.height).toBe(MIN_H);
  });

  it('opens as large as it can when there is no host to measure', () => {
    // A default small enough that the panes show nothing forces a resize
    // before the window is usable -- the exact friction this is removing. So
    // the fallback is the largest window that is still draggable, not a
    // fraction of the viewport.
    const workspace = { w: 1440, h: 780 };
    const result = size(workspace);
    expect(workspace.w - result.width, 'still draggable').toBe(MIN_TRAVEL);
    expect(workspace.h - result.height, 'still draggable').toBe(MIN_TRAVEL);
  });

  it('never opens small enough to hide the panes', () => {
    // Across every realistic viewport the first open must fill most of the
    // workspace, not a fraction of it.
    for (const [w, h] of [[1440, 780], [1680, 900], [1920, 960], [1280, 700]]) {
      const result = size({ w, h });
      expect(result.width / w, `${w}x${h} width share`).toBeGreaterThan(0.9);
      expect(result.height / h, `${w}x${h} height share`).toBeGreaterThan(0.85);
    }
  });

  it('remembers a size the user chose instead of reimposing the default', () => {
    // FloatingPanel persists geometry per window id and `loadGeom` prefers the
    // stored value over defaultW/defaultH, so an enlarged window reopens
    // enlarged. Pinned here because the default is only ever the FIRST open.
    const panel = read('../src/components/FloatingPanel.tsx');
    expect(panel).toMatch(/useState\(\(\) => loadGeom\(/);
    expect(panel).toMatch(/saveGeom\(id, geom\)/);
    const loadGeom = panel.slice(panel.indexOf('function loadGeom'), panel.indexOf('function saveGeom'));
    expect(loadGeom, 'stored geometry must win over the defaults').toContain('localStorage.getItem');
    expect(loadGeom.indexOf('localStorage.getItem'))
      .toBeLessThan(loadGeom.lastIndexOf('return clampGeomToViewport(fallback'));
  });

  it('never exceeds the workspace, whatever the host reports', () => {
    // A stale or fullscreen host measurement must not produce a window the
    // clamp will immediately shrink on first paint.
    const workspace = { w: 1280, h: 700 };
    const result = size(workspace, { width: 5000, height: 5000 });
    expect(result.width).toBeLessThanOrEqual(workspace.w);
    expect(result.height).toBeLessThanOrEqual(workspace.h);
  });

  it('would have failed with the fixed 1120x720 default that shipped', () => {
    // The original regression, stated as a number: on a 13" laptop that left
    // 36px of vertical travel, which is what "it just stops" was.
    const workspace = { w: 1440, h: 636 };
    expect(workspace.h - 720, 'the old default did not even fit').toBeLessThan(0);
    const result = size(workspace, { width: 1440, height: 636 });
    expect(workspace.h - result.height).toBeGreaterThanOrEqual(MIN_TRAVEL);
  });

  it('measures the host instead of assuming its configured default', () => {
    // That window persists its own geometry, so `defaultH={760}` is not
    // necessarily its current height.
    expect(remoteDesktop).toContain('floating-panel-remote-desktop-${machine.serverId}');
    expect(remoteDesktop).toContain('getBoundingClientRect()');
    expect(remoteDesktop).toContain('defaultW={fileWindowSize.width}');
    expect(remoteDesktop).not.toMatch(/defaultW=\{1120\}/);
  });

  it('subtracts the same bottom reserve the clamp does', () => {
    // Behavioural, not a source grep: computing against a different workspace
    // than FloatingPanel clamps with is how a window is resized on first paint.
    const originalW = window.innerWidth;
    const originalH = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      const workspace = remoteDesktopFileWindowWorkspace();
      expect(workspace.w).toBe(1440);
      // 100px bottom reserve, plus whatever the (absent) tab bar contributes.
      expect(workspace.h, 'the 100px bottom reserve must be honoured')
        .toBeLessThanOrEqual(800);
      expect(workspace.h).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalW, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: originalH, configurable: true });
    }
  });

  it('sizes against the same workspace the clamp enforces', () => {
    // Computing against a different workspace than FloatingPanel clamps with
    // is how a window ends up resized the instant it appears.
    const overlay = read('../src/remote-desktop-pointer-overlay.ts');
    expect(overlay).toContain('viewportWorkspaceBelowSessionTabs');
    expect(overlay).toContain('reserveWorkspaceBottom');
  });
});

describe('quick access targets the daemon-resolved sentinels', () => {
  it('navigates to sentinels, never to a guessed path', () => {
    // Only the daemon can know where these are; a literal '~/Downloads' here
    // would be wrong on a relocated Windows folder and on a localized Linux
    // desktop alike.
    for (const sentinel of ['HOME', 'DESKTOP', 'DOWNLOADS', 'DOCUMENTS'] as const) {
      expect(fileBrowser).toContain(`FILE_TRANSFER_DIRECTORY_PATH.${sentinel}`);
    }
    expect(fileBrowser).not.toMatch(/'~\/(Desktop|Downloads|Documents)'/);
  });

  it('is opt-in, so browsers pointed at anything else are unchanged', () => {
    expect(fileBrowser).toMatch(/quickAccess = false/);
    expect(fileBrowser).toMatch(/\{quickAccess && \(/);
  });

  it('is enabled for the remote machine browser', () => {
    expect(remoteDesktop).toMatch(/\n\s+quickAccess\n/);
  });

  it('imports the drives sentinel instead of redeclaring it', () => {
    // This literal used to be defined twice, in shared and again here.
    expect(fileBrowser).toContain('FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES');
    expect(fileBrowser).not.toMatch(/=\s*':drives:'/);
  });

  it('exposes distinct sentinel values', () => {
    const values = [
      FILE_TRANSFER_DIRECTORY_PATH.HOME,
      FILE_TRANSFER_DIRECTORY_PATH.DESKTOP,
      FILE_TRANSFER_DIRECTORY_PATH.DOWNLOADS,
      FILE_TRANSFER_DIRECTORY_PATH.DOCUMENTS,
      FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES,
    ];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('a sentinel is never accepted as a send destination', () => {
  it('treats every unresolved sentinel as "no destination yet"', () => {
    // navigateTo() publishes the sentinel immediately and only the daemon's
    // resolvedPath replaces it, so there is a window where ':downloads:' is
    // the "current path". Sending into that would target a literal directory
    // named ':downloads:'.
    const handler = remoteDesktop.slice(
      remoteDesktop.indexOf('const handleRemotePathChange'),
      remoteDesktop.indexOf('const handleRemoteSelectionChange'),
    );
    expect(handler).toContain('isFileTransferWellKnownDirectoryPath(path)');
    expect(handler).toMatch(/setDestinationDirectory\(isUnresolved \? '' : path\)/);
  });

  it('guards every sentinel, not just the drives one', () => {
    // The guard must be the shared predicate rather than a hand-written list
    // that a future sentinel would silently fall through.
    expect(remoteDesktop).toContain('isFileTransferWellKnownDirectoryPath');
    for (const sentinel of ['HOME', 'DESKTOP', 'DOWNLOADS', 'DOCUMENTS'] as const) {
      expect(
        isFileTransferWellKnownDirectoryPath(FILE_TRANSFER_DIRECTORY_PATH[sentinel]),
        `${sentinel} must be covered by the shared guard`,
      ).toBe(true);
    }
    // Real paths must obviously not be swallowed by it.
    expect(isFileTransferWellKnownDirectoryPath('C:\\Users\\k\\Downloads')).toBe(false);
    expect(isFileTransferWellKnownDirectoryPath('/home/ai/Downloads')).toBe(false);
  });
});

describe('the file window does not leak pointer input into the desktop', () => {
  /**
   * Reported: dragging or resizing the file window made the remote screen
   * flicker and the drag "kept breaking". The desktop forwards pointer moves
   * from a WINDOW-level capture listener, deciding purely by coordinates --
   * see the comment at that listener, which deliberately ignores
   * `event.target` because pointer capture retargets it. Once the file window
   * became draggable, every drag was also driving the remote cursor.
   */
  it('treats a point over the file window as not on the desktop', () => {
    const overlay = { closest: (sel: string) => (sel === `.${REMOTE_DESKTOP_OVERLAY_CLASS}` ? {} : null) };
    expect(isPointOverRemoteDesktopOverlay(10, 10, () => overlay as unknown as Element)).toBe(true);
  });

  it('lets a point on the bare desktop through', () => {
    const stage = { closest: () => null };
    expect(isPointOverRemoteDesktopOverlay(10, 10, () => stage as unknown as Element)).toBe(false);
    expect(isPointOverRemoteDesktopOverlay(10, 10, () => null)).toBe(false);
  });

  it('guards the forwarder before it reaches the remote client', () => {
    const forwarder = remoteDesktop.slice(
      remoteDesktop.indexOf('const sendDesktopPointerMove'),
      remoteDesktop.indexOf('const onStagePointerMove'),
    );
    expect(forwarder).toContain('isPointOverRemoteDesktopOverlay(clientX, clientY)');
    // The guard must precede the actual send, not merely exist.
    expect(forwarder.indexOf('isPointOverRemoteDesktopOverlay'))
      .toBeLessThan(forwarder.indexOf('clientRef.current?.pointerMove'));
  });

  it('re-reads the window-open flags instead of capturing them once', () => {
    // A stale closure here would leave the guard permanently disabled, and
    // every test above would still pass.
    const forwarder = remoteDesktop.slice(
      remoteDesktop.indexOf('const sendDesktopPointerMove'),
      remoteDesktop.indexOf('const onStagePointerMove'),
    );
    expect(forwarder).toMatch(/\}, \[normalizedClientPoint, filePanelOpen, fileDrawerMinimized\]\)/);
  });

  it('derives the overlay selector from one constant', () => {
    // The class is both applied to the window and matched by the hit test; two
    // literals would drift apart silently.
    expect(remoteDesktop).toContain('className={REMOTE_DESKTOP_OVERLAY_CLASS}');
    expect(remoteDesktop).not.toContain('className="remote-desktop-file-window"');
    expect(styles).toContain('.remote-desktop-file-window');
  });
});

describe('quick access is translated everywhere', () => {
  const locales = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW };
  const required = ['quick_access', 'desktop', 'downloads', 'documents', 'home', 'this_pc'] as const;

  for (const [name, bundle] of Object.entries(locales)) {
    it(`${name} has every quick-access label`, () => {
      const fb = (bundle as Record<string, Record<string, string>>).file_browser;
      for (const key of required) {
        expect(fb?.[key], `${name}.file_browser.${key}`).toBeTruthy();
      }
    });
  }

  it('does not leave any locale on the English string', () => {
    // A copy-pasted bundle is worse than a missing key: it looks translated.
    for (const [name, bundle] of Object.entries(locales)) {
      if (name === 'en') continue;
      const fb = (bundle as Record<string, Record<string, string>>).file_browser;
      expect(fb.downloads, `${name} still shows the English label`).not.toBe(en.file_browser.downloads);
    }
  });
});
