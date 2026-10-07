import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PowerShell for script-level tests of the generated Windows scripts. Windows and
 * GitHub's ubuntu runners ship `pwsh`; elsewhere the suite skips instead of
 * pretending (set IMCODES_TEST_PWSH to a portable pwsh to run it locally).
 */
export function findPowerShell(): string | null {
  const candidates = [process.env.IMCODES_TEST_PWSH, 'pwsh'].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export interface PowerShellRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `script` from a temp .ps1 (so `exit N` and `$ErrorActionPreference` behave as in the real task). */
export function runPowerShell(pwsh: string, script: string, env: Record<string, string> = {}): PowerShellRun {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-pwsh-test-'));
  try {
    const file = join(dir, 'test.ps1');
    writeFileSync(file, script, 'utf8');
    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
