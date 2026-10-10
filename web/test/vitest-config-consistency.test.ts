import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every jsdom vitest config in this project must install the storage shim.
 *
 * `vitest.filebrowser.config.ts` shipped without `setupFiles` and every one of
 * its 110 tests died on `localStorage.clear is not a function`, because some
 * vitest/jsdom combinations hand back a plain object instead of a Storage. It
 * went unnoticed for a long time precisely because that config is not a CI job
 * — it exists so a human can run one heavy file in isolation. A debugging tool
 * that disagrees with the config CI gates on is worse than no tool: it makes
 * "it passes/fails in isolation" mean nothing.
 *
 * This is asserted over the config FILES rather than a running environment so
 * a newly added config is covered the moment it exists, without needing anyone
 * to remember to run it.
 */
const CONFIG_NAME = /^vitest\..*config\.ts$/;

function configsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => CONFIG_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Locate the web project by probing, not by assuming a cwd.
 *
 * The per-config web runs have cwd at `web/`, but `npm run test:coverage` runs
 * from the repo root with `--project web` — where the same relative read finds
 * the ROOT's two vitest configs and silently guards the wrong directory.
 * `import.meta.url` is not an escape hatch either: Vite rewrites it to a
 * `/@fs/...` specifier that fs cannot open.
 *
 * The probe keys on the very thing being counted, so there is no second marker
 * to drift out of sync with a rename.
 */
function resolveWebRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, join(cwd, 'web')];
  let best = cwd;
  for (const candidate of candidates) {
    if (configsIn(candidate).length > configsIn(best).length) best = candidate;
  }
  return best;
}

const WEB_ROOT = resolveWebRoot();

function webVitestConfigs(): string[] {
  return configsIn(WEB_ROOT);
}

describe('web vitest configs', () => {
  it('finds the configs it is supposed to be guarding', () => {
    // A rename or a bad glob must fail loudly instead of vacuously passing
    // over an empty list.
    expect(webVitestConfigs().length).toBeGreaterThanOrEqual(4);
  });

  it('gives every jsdom config a setup that guarantees a real Storage', () => {
    const offenders: string[] = [];
    for (const name of webVitestConfigs()) {
      const source = readFileSync(join(WEB_ROOT, name), 'utf8');
      if (!source.includes("environment: 'jsdom'")) continue;
      const setup = source.match(/setupFiles:\s*\[([^\]]*)\]/)?.[1] ?? '';
      const files = [...setup.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      if (files.length === 0) { offenders.push(`${name}: no setupFiles`); continue; }
      // The setup must actually establish storage, not merely exist.
      const establishesStorage = files.some((file) => {
        try {
          return /clear:\s*\(\)/.test(readFileSync(join(WEB_ROOT, file), 'utf8'));
        } catch {
          return false;
        }
      });
      if (!establishesStorage) offenders.push(`${name}: ${files.join(', ')} never defines Storage.clear`);
    }
    expect(offenders).toEqual([]);
  });
});
