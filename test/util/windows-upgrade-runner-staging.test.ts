import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { WINDOWS_UPGRADE_RUNNER_STAGED_FILES } from '../../src/util/windows-upgrade-runner-staged-files.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerSource = resolve(repoRoot, 'src/util/windows-upgrade-runner.mjs');
const stagedPaths = new Set(['windows-upgrade-runner.mjs', ...WINDOWS_UPGRADE_RUNNER_STAGED_FILES]);

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
        const stagedPath = relative(dirname(runnerSource), dependency).split(sep).join('/');
        expect(stagedPaths.has(stagedPath), `${specifier} must be in the staged closure`).toBe(true);
        pending.push(dependency);
      }
    }
  });

  it('copies the staged set into an empty temp dir and loads with dry-run', () => {
    const stagingDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-stage-test-'));
    try {
      for (const relativePath of ['windows-upgrade-runner.mjs', ...WINDOWS_UPGRADE_RUNNER_STAGED_FILES]) {
        const destination = join(stagingDir, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(
          relativePath === 'windows-upgrade-runner.mjs'
            ? runnerSource
            : resolve(dirname(runnerSource), relativePath),
          destination,
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
