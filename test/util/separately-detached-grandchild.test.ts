import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../src/util/kill-process-tree.js';

/**
 * A grandchild that escapes the owned group by creating its OWN session.
 *
 * This module's header has always warned that some SDK wrappers detach their
 * native child. Such a grandchild carries a different PGID, so the group signal
 * cannot reach it — parentage is the only identity left. And parentage is
 * destroyed the instant the wrapper exits, because the grandchild reparents to
 * init.
 *
 * An earlier revision signalled the group BEFORE walking `ps`, which meant the
 * wrapper was already dying while the walk ran: by the time `ps` answered, the
 * grandchild had PPID=1 and was invisible to both mechanisms. It survived.
 *
 * The fix is ordering, not a new mechanism: snapshot descendants in the one
 * instant before any signal, when both identities still coexist. These cases
 * pin that ordering, with and without an artificial delay before `ps`.
 */

const POSIX = process.platform !== 'win32';
const roots: string[] = [];
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Outer child in its own group; inside it, a second `detached` spawn puts the
 * grandchild in a DIFFERENT session and group. The grandchild also ignores
 * SIGTERM, so a graceful signal alone cannot account for its death.
 */
async function detachedGrandchild() {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-detached-gc-'));
  roots.push(root);
  const pidFile = join(root, 'grandchild.pid');

  // `setsid(1)` does not exist on macOS, so the new session is created the way
  // an SDK wrapper actually creates one: node's own `detached: true`, which is
  // setsid under the hood. This is the audit's exact shape — an outer node
  // child in an owned group spawning a second detached node grandchild.
  const outerScript = join(root, 'outer.mjs');
  writeFileSync(outerScript, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const gc = spawn('bash', ['-c', 'trap \"\" TERM; while :; do sleep 0.2; done'], {",
    '  detached: true,',
    "  stdio: 'ignore',",
    '});',
    `writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
    'gc.unref();',
    '// Stay alive so teardown sees a live wrapper, exactly as a provider would.',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const outer = spawn(process.execPath, [outerScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  strays.push(outer.pid!);

  // Wait for the grandchild to announce itself.
  for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
    await settle(50);
  }
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  strays.push(grandchild);
  return { outer, grandchild };
}

describe.skipIf(!POSIX)('a grandchild in its own session is still reaped', () => {
  it('reaps a separately-detached grandchild of an owned group', async () => {
    const { outer, grandchild } = await detachedGrandchild();
    expect(grandchild, 'the grandchild announced its pid').toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    // It is genuinely outside our group: that is the whole point.
    const groups = await new Promise<string>((resolve) => {
      const ps = spawn('ps', ['-o', 'pgid=', '-p', String(grandchild)], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ps.stdout.on('data', (chunk) => { out += String(chunk); });
      ps.once('close', () => resolve(out.trim()));
    });
    expect(Number(groups), 'the grandchild leads a different process group').not.toBe(outer.pid);

    await killProcessTree(outer, { gracefulMs: 400, ownsProcessGroup: true });
    await settle(400);

    expect(alive(outer.pid!), 'the wrapper is gone').toBe(false);
    expect(
      alive(grandchild),
      'a grandchild outside the group must still be reached, via the pre-signal snapshot',
    ).toBe(false);
  }, 30_000);

  it('still reaps it when the descendant walk is slow', async () => {
    // The audit reproduced this with a 350ms delay before `ps`. If the snapshot
    // were taken after the first signal, a slower walk would only widen the
    // window in which the grandchild has already reparented to init.
    const { outer, grandchild } = await detachedGrandchild();
    expect(alive(grandchild)).toBe(true);

    // Load the machine's ps path a little, then tear down.
    await settle(350);
    await killProcessTree(outer, { gracefulMs: 400, ownsProcessGroup: true });
    await settle(400);

    expect(alive(grandchild), 'the ordering, not the timing, is what makes this work').toBe(false);
  }, 30_000);

  it('leaves an unrelated separately-detached process alone', async () => {
    // The pre-signal snapshot must widen reach, not authority: a process that
    // is neither in the group nor a descendant stays untouched.
    const { outer, grandchild } = await detachedGrandchild();
    const bystander = spawn('bash', ['-c', 'sleep 600'], { stdio: 'ignore', detached: true });
    strays.push(bystander.pid!);
    await settle(150);

    await killProcessTree(outer, { gracefulMs: 400, ownsProcessGroup: true });
    await settle(400);

    expect(alive(grandchild), 'our own descendant is reaped').toBe(false);
    expect(alive(bystander.pid!), 'an unrelated detached process is not').toBe(true);
  }, 30_000);
});
