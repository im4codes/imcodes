import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildWindowsUpgradeRunnerVbs,
  resolveWindowsUpgradePrefix,
  stageWindowsUpgradeRunner,
  WINDOWS_UPGRADE_RUNNER_ENTRY_FILE,
} from '../../src/util/windows-upgrade-script.js';
import { WINDOWS_UPGRADE_RUNNER_STAGED_FILES } from '../../src/util/windows-upgrade-runner-staged-files.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerSource = resolve(repoRoot, 'src/util/windows-upgrade-runner.mjs');
const stagedPaths = new Set([WINDOWS_UPGRADE_RUNNER_ENTRY_FILE, ...WINDOWS_UPGRADE_RUNNER_STAGED_FILES]);

function relativeImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

describe('Windows staged upgrade runner closure', () => {
  it('derives the owning npm prefix from default and custom package layouts', () => {
    expect(resolveWindowsUpgradePrefix('C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\util\\windows-upgrade-runner.mjs'))
      .toBe('C:/Users/admin/AppData/Roaming/npm');
    expect(resolveWindowsUpgradePrefix('C:\\scope3-prefix\\node_modules\\imcodes\\dist\\src\\util\\windows-upgrade-runner.mjs'))
      .toBe('C:/scope3-prefix');
    expect(resolveWindowsUpgradePrefix('/tmp/runner.mjs')).toBeNull();
  });

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

  it('uses the real staging helper and loads from an empty temp dir with dry-run', () => {
    const stagingDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-stage-test-'));
    try {
      const { runnerPath } = stageWindowsUpgradeRunner(stagingDir, runnerSource);
      expect(runnerPath).toBe(join(stagingDir, WINDOWS_UPGRADE_RUNNER_ENTRY_FILE));
      expect(existsSync(runnerPath)).toBe(true);
      const result = spawnSync(process.execPath, [runnerPath, '--dry-run'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('staged dependency closure loaded');
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  it('passes the helper-returned runner path to the VBS launcher', () => {
    const stagingDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-vbs-test-'));
    try {
      const { runnerPath } = stageWindowsUpgradeRunner(stagingDir, runnerSource);
      const vbs = buildWindowsUpgradeRunnerVbs({
        nodeExe: process.execPath,
        runnerPath,
        args: ['log', 'npm', 'imcodes@next', 'next', stagingDir, '-', 'current'],
      });
      expect(vbs).toContain(`""${runnerPath}""`);
      expect(readFileSync(resolve(repoRoot, 'src/util/windows-upgrade-script.ts'), 'utf8'))
        .toContain('const runnerCopy = stageWindowsUpgradeRunner(input.scriptDir, runnerSrc).runnerPath');
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});
