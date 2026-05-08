/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { resolveFrontmostMaximized } from '../../src/desktop-window-maximize.js';
import { DESKTOP_WINDOW_IDS } from '../../src/window-stack.js';

describe('desktop multi-window maximize state', () => {
  it('allows multiple managed windows to be maximized and restores only the frontmost one', () => {
    const maximizedWindowIds = [
      DESKTOP_WINDOW_IDS.fileBrowser,
      DESKTOP_WINDOW_IDS.subSession('alpha'),
      DESKTOP_WINDOW_IDS.subSession('beta'),
    ];
    const first = resolveFrontmostMaximized([
      DESKTOP_WINDOW_IDS.fileBrowser,
      DESKTOP_WINDOW_IDS.subSession('beta'),
      DESKTOP_WINDOW_IDS.subSession('alpha'),
    ], maximizedWindowIds);

    expect(first).toBe(DESKTOP_WINDOW_IDS.subSession('alpha'));

    const afterRestore = maximizedWindowIds.filter((id) => id !== first);
    expect(resolveFrontmostMaximized([
      DESKTOP_WINDOW_IDS.fileBrowser,
      DESKTOP_WINDOW_IDS.subSession('beta'),
      DESKTOP_WINDOW_IDS.subSession('alpha'),
    ], afterRestore)).toBe(DESKTOP_WINDOW_IDS.subSession('beta'));
    expect(afterRestore).toContain(DESKTOP_WINDOW_IDS.fileBrowser);
  });

  it('ignores closed sub-session windows that are no longer in the managed maximized list', () => {
    const maximizedWindowIds = [DESKTOP_WINDOW_IDS.fileBrowser];

    expect(resolveFrontmostMaximized([
      DESKTOP_WINDOW_IDS.fileBrowser,
      DESKTOP_WINDOW_IDS.subSession('closed'),
    ], maximizedWindowIds)).toBe(DESKTOP_WINDOW_IDS.fileBrowser);
  });
});
