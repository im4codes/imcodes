import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

export interface PlaywrightBrowsersEnvOptions {
  platform?: NodeJS.Platform;
  homedir?: () => string | undefined;
  pathExists?: (dir: string) => boolean;
}

export function resolvePlaywrightBrowsersOverride(
  env: NodeJS.ProcessEnv = process.env,
  options: PlaywrightBrowsersEnvOptions = {},
): string | undefined {
  const existing = env.PLAYWRIGHT_BROWSERS_PATH;
  if (existing !== undefined && existing.trim() !== '') {
    // Respect explicit configuration verbatim (including '0' or relative paths).
    return undefined;
  }
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? existsSync;
  const realHome = (() => {
    try {
      return (options.homedir ?? (() => userInfo().homedir))();
    } catch {
      return undefined;
    }
  })();
  const candidates: string[] = [];
  if (platform === 'darwin') {
    if (env.HOME?.trim()) candidates.push(path.join(env.HOME.trim(), 'Library', 'Caches', 'ms-playwright'));
    if (realHome) candidates.push(path.join(realHome, 'Library', 'Caches', 'ms-playwright'));
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA?.trim()) candidates.push(path.join(env.LOCALAPPDATA.trim(), 'ms-playwright'));
    if (realHome) candidates.push(path.join(realHome, 'AppData', 'Local', 'ms-playwright'));
  } else {
    if (env.XDG_CACHE_HOME?.trim()) candidates.push(path.join(env.XDG_CACHE_HOME.trim(), 'ms-playwright'));
    if (env.HOME?.trim()) candidates.push(path.join(env.HOME.trim(), '.cache', 'ms-playwright'));
    if (realHome) candidates.push(path.join(realHome, '.cache', 'ms-playwright'));
  }
  return candidates.find((dir) => pathExists(dir));
}

export function applyPlaywrightBrowsersOverride(
  env: NodeJS.ProcessEnv = process.env,
  options: PlaywrightBrowsersEnvOptions = {},
): () => void {
  const hadKey = Object.prototype.hasOwnProperty.call(env, 'PLAYWRIGHT_BROWSERS_PATH');
  const prevValue = env.PLAYWRIGHT_BROWSERS_PATH;
  const override = resolvePlaywrightBrowsersOverride(env, options);
  if (!override) {
    return () => {};
  }
  env.PLAYWRIGHT_BROWSERS_PATH = override;
  return () => {
    if (hadKey) {
      env.PLAYWRIGHT_BROWSERS_PATH = prevValue;
    } else {
      delete env.PLAYWRIGHT_BROWSERS_PATH;
    }
  };
}
