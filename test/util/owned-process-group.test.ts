import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { killProcessTree } from '../../src/util/kill-process-tree.js';

/**
 * Orphan reaping across a dead parent.
 *
 * Production incident: eight `vitest` workers outlived their agent parent,
 * were reparented to PPID=1, and starved the daemon.
 *
 * The mechanism, proven on authorized host 211 and recorded under
 * asg_j9a/evidence-r1/process-tree: a reparented process LOSES its PPID — it
 * becomes 1 — but KEEPS its process group id. `killProcessTree` identifies
 * work by parentage, enumerating `ps -A -o pid,ppid` exactly once
 * (src/util/kill-process-tree.ts:57) and iterating that one snapshot in both
 * the SIGTERM sweep (:177) and the SIGKILL sweep (:195). So the very event
 * that creates the orphan is the event that destroys the only identity the
 * teardown can see.
 *
 * These are real processes, not mocks: the defect lives in kernel process
 * bookkeeping, and a mocked `spawn` cannot reparent anything.
 */

const POSIX = process.platform !== 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

/** Reads the single pid the shell prints on stdout. */
async function firstPid(stream: NodeJS.ReadableStream | null): Promise<number> {
  if (!stream) throw new Error('no stdout');
  for await (const chunk of stream) {
    const pid = Number(String(chunk).trim().split('\n')[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  throw new Error('grandchild never announced its pid');
}

describe.skipIf(!POSIX)('reaping a grandchild whose parent already died', () => {
  it('documents the defect: parentage alone cannot reach a reparented grandchild', async () => {
    // Spawned the way every provider spawns today — no own process group.
    const child = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const orphan = await firstPid(child.stdout);
    try {
      // The incident ordering: the agent parent dies FIRST, so the grandchild
      // is already reparented by the time teardown runs.
      process.kill(child.pid!, 'SIGKILL');
      await once(child, 'exit');
      await settle(200);
      expect(alive(orphan), 'the grandchild outlives its parent').toBe(true);

      await killProcessTree(child, { gracefulMs: 200 });

      // Not a wish — a statement of what parentage-based teardown can do.
      // This is why the spawn side must establish a group, and it is asserted
      // so that a future change claiming to fix reaping cannot quietly leave
      // the ungrouped path believing itself covered.
      expect(
        alive(orphan),
        'without a group there is no surviving token, so the orphan cannot be found',
      ).toBe(true);
    } finally {
      try { process.kill(orphan, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('reaps a reparented grandchild when the child owns its process group', async () => {
    // `detached: true` makes the child a session and group leader on POSIX
    // (verified on 211: PGID === SID === child pid). The group id then
    // survives the parent's death, which PPID does not.
    const child = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const orphan = await firstPid(child.stdout);
    try {
      process.kill(child.pid!, 'SIGKILL');
      await once(child, 'exit');
      await settle(200);
      expect(alive(orphan), 'the grandchild outlives its parent here too').toBe(true);

      await killProcessTree(child, { gracefulMs: 300, ownsProcessGroup: true });
      await settle(200);

      expect(
        alive(orphan),
        'an owned group must be reaped whole, even with the parent already gone',
      ).toBe(false);
    } finally {
      try { process.kill(orphan, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('reaps a whole owned group even while the parent is still alive', async () => {
    const child = spawn('bash', ['-c', 'sleep 600 & sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const orphan = await firstPid(child.stdout);
    try {
      await killProcessTree(child, { gracefulMs: 300, ownsProcessGroup: true });
      await settle(200);
      expect(alive(child.pid!), 'the group leader is gone').toBe(false);
      expect(alive(orphan), 'and so is everything it forked').toBe(false);
    } finally {
      try { process.kill(orphan, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('never signals a process outside the owned group', async () => {
    // A bystander in the test runner's own group. If teardown ever widened to
    // the caller's group, or guessed by command text, this would die.
    const bystander = spawn('bash', ['-c', 'sleep 600'], { stdio: 'ignore' });
    const owned = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const ownedGrandchild = await firstPid(owned.stdout);
    try {
      await killProcessTree(owned, { gracefulMs: 300, ownsProcessGroup: true });
      await settle(200);
      expect(alive(ownedGrandchild), 'the owned group is reaped').toBe(false);
      expect(
        alive(bystander.pid!),
        'an unrelated process running the SAME command text is untouched',
      ).toBe(true);
    } finally {
      try { process.kill(bystander.pid!, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(ownedGrandchild, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('refuses to group-signal a bare pid, because a pid proves no ownership', async () => {
    // Same shape as the incident, but teardown is handed only a number. Once
    // the leader is reaped its pid slot is free for anyone, so a caller that
    // merely claims ownership must not be believed: the group signal would be
    // aimed at whatever now holds that id.
    const child = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const orphan = await firstPid(child.stdout);
    const leaderPid = child.pid!;
    try {
      process.kill(leaderPid, 'SIGKILL');
      await once(child, 'exit');
      await settle(200);

      await killProcessTree(leaderPid, { gracefulMs: 200, ownsProcessGroup: true });
      await settle(150);
      expect(
        alive(orphan),
        'a bare pid must not authorise a group signal',
      ).toBe(true);

      // The same group, reaped once the handle proves it is ours.
      await killProcessTree(child, { gracefulMs: 300, ownsProcessGroup: true });
      await settle(200);
      expect(alive(orphan), 'the handle is the proof, and it works').toBe(false);
    } finally {
      try { process.kill(orphan, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('escalates the group to SIGKILL when the grandchild ignores SIGTERM', async () => {
    // A worker that traps TERM is the realistic case: a graceful signal is a
    // request, not a guarantee, so the group must be escalated.
    const child = spawn('bash', ['-c', 'bash -c \'trap "" TERM; echo $$; while :; do sleep 1; done\' & wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const stubborn = await firstPid(child.stdout);
    try {
      process.kill(child.pid!, 'SIGKILL');
      await once(child, 'exit');
      await settle(200);
      expect(alive(stubborn), 'the stubborn grandchild is orphaned and alive').toBe(true);

      await killProcessTree(child, { gracefulMs: 300, ownsProcessGroup: true });
      await settle(300);
      expect(
        alive(stubborn),
        'a TERM-ignoring member must still be reaped by the group SIGKILL',
      ).toBe(false);
    } finally {
      try { process.kill(stubborn, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('gives the group a graceful SIGTERM before escalating', async () => {
    // A group that is only ever SIGKILLed is not an escalation. The member here
    // traps TERM, records that it arrived, and exits by itself; if the graceful
    // half were dropped the marker would never be written.
    //
    // The member script lives in a file rather than a nested `bash -c` string:
    // inlining it let the OUTER shell expand `$$` first, so the test captured
    // the wrong pid and passed for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-group-term-'));
    const marker = join(dir, 'term-received');
    const script = join(dir, 'member.sh');
    writeFileSync(script, [
      '#!/bin/bash',
      `trap 'touch ${marker}; exit 0' TERM`,
      'echo $$',
      'while :; do sleep 0.2; done',
      '',
    ].join('\n'));
    const child = spawn('bash', ['-c', `bash ${script} & wait`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const member = await firstPid(child.stdout);
    try {
      // Leader dies first, so only the group signal can reach the member.
      process.kill(child.pid!, 'SIGKILL');
      await once(child, 'exit');
      await settle(250);
      expect(alive(member), 'the member is orphaned and still running').toBe(true);

      await killProcessTree(child, { gracefulMs: 800, ownsProcessGroup: true });
      await settle(250);

      expect(alive(member), 'the member is gone either way').toBe(false);
      expect(
        existsSync(marker),
        'it must have been asked to stop before it was forced to',
      ).toBe(true);
    } finally {
      try { process.kill(member, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is still a no-op for a pid that is already dead', async () => {
    const child = spawn('bash', ['-c', 'exit 0'], { stdio: 'ignore', detached: true });
    await once(child, 'exit');
    await expect(killProcessTree(child, { gracefulMs: 50, ownsProcessGroup: true })).resolves.toBeUndefined();
  });
});
