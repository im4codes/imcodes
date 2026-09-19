import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

/**
 * Does the SIGTERM -> SIGKILL escalation finish when NOTHING else is keeping the
 * killer alive?
 *
 * Every other process test in this repo runs inside vitest, where the runner
 * always holds unrelated handles open, so an abandoned or unref'd escalation
 * still gets to complete. That is precisely the shape those tests cannot
 * falsify, and it is the shape that matters: a daemon in shutdown, where the
 * escalation is the last pending work in the process.
 *
 * So the killer runs as its OWN node subprocess. It spawns a group whose member
 * ignores SIGTERM, kills the leader first (the incident ordering), starts the
 * escalation, and exits. The assertion is made from out here, AFTER that
 * subprocess is gone.
 *
 * WHAT THIS PROVES, and what it does not — established by mutating it:
 *
 *   - Dropping `ownsProcessGroup` makes this case FAIL. So it is load-bearing
 *     for the property that a group reap actually completes inside a process
 *     that has no unrelated handles keeping it alive.
 *
 *   - Re-adding `unref()` to the grace timer does NOT make it fail.
 *   - Discarding the escalation promise entirely does NOT make it fail either.
 *
 * The reason is that `killProcessTree` spawns `ps` during the walk, and those
 * child handles plus the exited ChildProcess's stdio keep the loop alive across
 * the grace window. So the "event loop exits before the grace timer fires"
 * mechanism is NOT reproducible here, and the same probe on Linux 211 agreed.
 * Keeping the timer referenced and awaiting the teardown are therefore
 * defensive hardening, not fixes this evidence demonstrates. Stated here so the
 * test is not read as proving more than it does.
 */

const POSIX = process.platform !== 'win32';
let workdir = '';
let killerPath = '';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

beforeAll(async () => {
  if (!POSIX) return;
  workdir = mkdtempSync(join(tmpdir(), 'imcodes-escalation-iso-'));

  // The subprocess is plain node, so the module under test is bundled rather
  // than imported as TypeScript. esbuild is already a dev dependency here.
  const lib = join(workdir, 'kill-process-tree.mjs');
  await execFileP(join(process.cwd(), 'node_modules/.bin/esbuild'), [
    join(process.cwd(), 'src/util/kill-process-tree.ts'),
    '--format=esm',
    '--platform=node',
    `--outfile=${lib}`,
    '--log-level=error',
  ]);

  // A member that ignores SIGTERM: only the SIGKILL half of the escalation can
  // reap it, so the test cannot pass on the graceful signal alone.
  const member = join(workdir, 'member.sh');
  writeFileSync(member, '#!/bin/bash\ntrap "" TERM\necho $$\nwhile :; do sleep 0.2; done\n');

  killerPath = join(workdir, 'killer.mjs');
  writeFileSync(killerPath, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { killProcessTree } from ${JSON.stringify(lib)};

const child = spawn('bash', ['-c', ${JSON.stringify(`bash ${member} & wait`)}], {
  stdio: ['ignore', 'pipe', 'ignore'],
  detached: true,
});

const member = await new Promise((resolve) => {
  child.stdout.on('data', (chunk) => {
    const pid = Number(String(chunk).trim().split('\\n')[0]);
    if (Number.isInteger(pid) && pid > 0) resolve(pid);
  });
});
writeFileSync(${JSON.stringify(join(workdir, 'member.pid'))}, String(member));

// The incident ordering: the leader is already gone when teardown runs, so the
// group id is the only ownership token left.
process.kill(child.pid, 'SIGKILL');
await new Promise((resolve) => child.once('exit', resolve));

// From here the escalation is the ONLY pending work in this process.
await killProcessTree(child, { gracefulMs: 600, ownsProcessGroup: true });
writeFileSync(${JSON.stringify(join(workdir, 'completed'))}, 'yes');
`);
}, 60_000);

afterAll(() => {
  if (!workdir) return;
  try {
    const pid = Number(readFileSync(join(workdir, 'member.pid'), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch { /* nothing left to clean */ }
  rmSync(workdir, { recursive: true, force: true });
});

describe.skipIf(!POSIX)('escalation completes with no unrelated handles holding the killer open', () => {
  it('reaps a TERM-ignoring group member even though the killer process exits', async () => {
    const killer = spawn(process.execPath, [killerPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    killer.stderr?.on('data', (chunk) => { stderr += String(chunk); });

    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      killer.once('exit', (exitCode, signal) => resolve([exitCode, signal]));
    });

    // A non-zero exit here would mean the killer died rather than finished —
    // e.g. node exit code 13 for an unsettled top-level await, which is exactly
    // how an abandoned escalation manifests.
    expect(code, `killer exited ${code}; stderr: ${stderr}`).toBe(0);

    const member = Number(readFileSync(join(workdir, 'member.pid'), 'utf8').trim());
    expect(member, 'the member announced its pid').toBeGreaterThan(0);
    expect(
      readFileSync(join(workdir, 'completed'), 'utf8'),
      'the escalation ran to completion inside the killer',
    ).toBe('yes');

    // The killer is gone. Nothing else was ever going to signal this group.
    await settle(300);
    expect(
      alive(member),
      'a TERM-ignoring member must be reaped by the escalation, not outlive the killer',
    ).toBe(false);
  }, 60_000);
});
