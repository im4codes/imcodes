import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { WINDOWS_UPGRADE_RUNNER_STAGED_FILES } from '../../src/util/windows-upgrade-runner-staged-files.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerSource = resolve(repoRoot, 'src/util/windows-upgrade-runner.mjs');
const stagedNames = new Set(['windows-upgrade-runner.mjs', ...WINDOWS_UPGRADE_RUNNER_STAGED_FILES]);

function relativeImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

describe('Windows staged upgrade runner closure', () => {
  it('stages every transitive relative import exactly once', () => {
    const pending = [runnerSource];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const specifier of relativeImports(current)) {
        const dependency = resolve(dirname(current), specifier);
        expect(stagedNames.has(basename(dependency))).toBe(true);
        pending.push(dependency);
      }
    }
  });

  it('copies the staged set into an empty temp dir and loads with dry-run', () => {
    const stagingDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-stage-test-'));
    try {
      for (const relativePath of ['windows-upgrade-runner.mjs', ...WINDOWS_UPGRADE_RUNNER_STAGED_FILES]) {
        copyFileSync(
          relativePath === 'windows-upgrade-runner.mjs'
            ? runnerSource
            : resolve(dirname(runnerSource), relativePath),
          join(stagingDir, relativePath),
        );
      }
      const stagedRunner = join(stagingDir, 'windows-upgrade-runner.mjs');
      const result = spawnSync(process.execPath, [stagedRunner, '--dry-run'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('staged dependency closure loaded');
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});
