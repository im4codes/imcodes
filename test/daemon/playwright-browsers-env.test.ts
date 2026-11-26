import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlaywrightBrowsersOverride, resolvePlaywrightBrowsersOverride } from '../util/playwright-browsers-env.js';

describe('Playwright browser cache override helper', () => {
  it('respects explicit PLAYWRIGHT_BROWSERS_PATH values including "0" and relative paths', () => {
    const linuxCache = path.join('/real/home', '.cache', 'ms-playwright');
    for (const explicit of ['0', './local-browsers', '../pw-cache', '/custom/pw']) {
      const env: NodeJS.ProcessEnv = {
        PLAYWRIGHT_BROWSERS_PATH: explicit,
        HOME: '/isolated/home',
      };
      expect(
        resolvePlaywrightBrowsersOverride(env, {
          platform: 'linux',
          homedir: () => '/real/home',
          pathExists: (dir) => dir === linuxCache,
        }),
      ).toBeUndefined();

      const restore = applyPlaywrightBrowsersOverride(env, {
        platform: 'linux',
        homedir: () => '/real/home',
        pathExists: (dir) => dir === linuxCache,
      });
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(explicit);
      restore();
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(explicit);
    }
  });

  it('overrides unset or blank PLAYWRIGHT_BROWSERS_PATH using platform candidates and restores original env state', () => {
    const linuxRealCache = path.join('/real/home', '.cache', 'ms-playwright');
    const unsetEnv: NodeJS.ProcessEnv = { HOME: '/isolated/home' };
    const restoreUnset = applyPlaywrightBrowsersOverride(unsetEnv, {
      platform: 'linux',
      homedir: () => '/real/home',
      pathExists: (dir) => dir === linuxRealCache,
    });
    expect(unsetEnv.PLAYWRIGHT_BROWSERS_PATH).toBe(linuxRealCache);
    restoreUnset();
    expect(Object.prototype.hasOwnProperty.call(unsetEnv, 'PLAYWRIGHT_BROWSERS_PATH')).toBe(false);

    const blankEnv: NodeJS.ProcessEnv = { PLAYWRIGHT_BROWSERS_PATH: '   ', HOME: '/isolated/home' };
    const restoreBlank = applyPlaywrightBrowsersOverride(blankEnv, {
      platform: 'linux',
      homedir: () => '/real/home',
      pathExists: (dir) => dir === linuxRealCache,
    });
    expect(blankEnv.PLAYWRIGHT_BROWSERS_PATH).toBe(linuxRealCache);
    restoreBlank();
    expect(Object.prototype.hasOwnProperty.call(blankEnv, 'PLAYWRIGHT_BROWSERS_PATH')).toBe(true);
    expect(blankEnv.PLAYWRIGHT_BROWSERS_PATH).toBe('   ');
  });

  it('prefers XDG_CACHE_HOME/HOME before userInfo homedir and covers darwin/win32 cache locations', () => {
    const xdgCache = path.join('/xdg', 'ms-playwright');
    expect(
      resolvePlaywrightBrowsersOverride(
        { XDG_CACHE_HOME: '/xdg', HOME: '/env-home' },
        { platform: 'linux', homedir: () => '/real-home', pathExists: () => true },
      ),
    ).toBe(xdgCache);

    expect(
      resolvePlaywrightBrowsersOverride(
        { HOME: '/mac-home' },
        { platform: 'darwin', homedir: () => '/real-mac', pathExists: (d) => d === path.join('/real-mac', 'Library', 'Caches', 'ms-playwright') },
      ),
    ).toBe(path.join('/real-mac', 'Library', 'Caches', 'ms-playwright'));

    expect(
      resolvePlaywrightBrowsersOverride(
        { LOCALAPPDATA: '/win-local' },
        { platform: 'win32', homedir: () => '/real-win', pathExists: (d) => d === path.join('/win-local', 'ms-playwright') },
      ),
    ).toBe(path.join('/win-local', 'ms-playwright'));

    expect(
      resolvePlaywrightBrowsersOverride(
        { HOME: '/missing' },
        { platform: 'linux', homedir: () => { throw new Error('no passwd'); }, pathExists: () => false },
      ),
    ).toBeUndefined();
  });
});
