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
    expect(remoteDesktop).toMatch(/className="remote-desktop-file-window"/);
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
    const drawerAt = remoteDesktop.indexOf('remote-desktop-file-window');
    const bodyReturn = remoteDesktop.indexOf('if (embedded) return panelBody;');
    expect(drawerAt).toBeGreaterThan(-1);
    expect(drawerAt, 'the window must be rendered within panelBody').toBeLessThan(bodyReturn);
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
