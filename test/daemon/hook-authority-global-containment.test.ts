/**
 * Escaped-fixture containment, proven CONTINUOUSLY.
 *
 * ## The real defect this encodes
 *
 * A full `npm run test:unit` with the real `HOME` repeatedly overwrote the live
 * daemon's `~/.imcodes/hook-port` mid-run, breaking `imcodes send` for other
 * sessions. Two properties made it possible:
 *
 *  1. `hook-server.ts` published the machine-global record unconditionally on
 *     every successful bind, and `startHookServer()` had no path seam, so any
 *     suite that started a hook server rewrote production state.
 *  2. The first containment attempt keyed off `process.env.VITEST`. That is
 *     invisible to a CHILD process: suites that spawn the daemon or the stdio
 *     MCP (e.g. `memory-mcp-stdio-lifecycle`, the legacy-discovery spec suites)
 *     produce children which look exactly like production, keep the real HOME,
 *     and publish. Containment therefore cannot depend on the environment.
 *
 * The fence is now the daemon INSTANCE LOCK: only the process that owns the
 * machine's daemon lock may publish the endpoint record. Ownership survives a
 * spawn because it is a property of the machine, not of the environment.
 *
 * ## Why a before/after hash is not enough
 *
 * The original wrapper compared the production file's hash before and after the
 * suite. The escape was INTERMEDIATE: the file was rewritten during the run and
 * happened to be restored by the end, so the wrapper reported "unchanged". This
 * suite therefore watches the production path for the whole test and asserts
 * ZERO modification events, not just equal endpoints.
 *
 * Nothing here writes the production file. It is opened read-only and watched.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOOK_AUTHORITY_ERROR, HOOK_PORT_FILE_NAME } from '../../shared/hook-authority.js';
import {
  DAEMON_INSTANCE_LOCK_FILE_NAME,
  hookPortFilePath,
  imcodesHomeDir,
} from '../../src/daemon/hook-port.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';

/**
 * The watched "machine-global" record.
 *
 * `IMCODES_HOME` is redirected to a temp root for the duration of each test, so
 * `imcodesHomeDir()` - and therefore every production code path - resolves here.
 * The assertion is then hermetic.
 *
 * This matters because the real `~/.imcodes/hook-port` on a developer machine is
 * concurrently written by OTHER processes running not-yet-upgraded code (the
 * installed daemon's `savePort()` and other worktrees' test suites, which write
 * a bare port with no trailing newline). Watching the real file would make this
 * suite fail for someone else's escape, which is unattributable and therefore
 * useless as a regression. What must be pinned is the MECHANISM: production code
 * refuses to publish over the machine record unless it owns the daemon lock.
 */
let machineHome = '';
let machinePortFile = '';

/** Recorded in the seeded machine record; deliberately in a range nothing on a
 *  developer machine serves, so no listener probe can rescue the assertion. */
const SEEDED_PORT = 61888;
/** What a rogue publisher tries to install. */
const ROGUE_PORT = 61999;

type RecordSnapshot =
  | { exists: false }
  | {
    exists: true;
    bytes: string;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };

function recordSnapshot(path: string): RecordSnapshot {
  try {
    const stat = statSync(path, { bigint: true });
    return {
      exists: true,
      bytes: readFileSync(path, 'utf8'),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function sameRecordSnapshot(left: RecordSnapshot, right: RecordSnapshot): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.bytes === right.bytes
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/** Continuous observer of the production record: any write, rename-into-place,
 *  or truncation during the test is a containment failure. */
class MachineRecordGuard {
  private fileWatcher: FSWatcher | null = null;
  private dirWatcher: FSWatcher | null = null;
  private readonly events: string[] = [];
  private readonly initialSnapshot: RecordSnapshot;

  constructor(private readonly path: string) {
    this.initialSnapshot = recordSnapshot(path);
  }

  private observe(event: string): void {
    // `fs.watch` is only a wake-up signal. macOS may deliver the seed write's
    // FSEvent after the watcher is armed and even after the old 150ms settling
    // window under a loaded runner. Treating the basename alone as proof made
    // a no-I/O test fail as though production had been touched. A real write,
    // truncate, unlink, or atomic rename necessarily changes bytes or file
    // identity/metadata and is still recorded, including a same-bytes rename.
    if (sameRecordSnapshot(this.initialSnapshot, recordSnapshot(this.path))) return;
    this.events.push(event);
  }

  start(): void {
    if (this.initialSnapshot.exists) {
      this.fileWatcher = watch(this.path, (eventType) => {
        this.observe(`file:${eventType}`);
      });
    }
    // The publisher writes tmp + rename, which surfaces on the DIRECTORY watch
    // rather than the file watch - so watch both or the atomic path is missed.
    const dir = dirname(this.path);
    if (existsSync(dir)) {
      this.dirWatcher = watch(dir, (eventType, filename) => {
        if (filename && filename.startsWith(HOOK_PORT_FILE_NAME)) {
          this.observe(`dir:${eventType}:${filename}`);
        }
      });
    }
  }

  /** Drop events queued before the watchers were actually armed.
   *
   *  macOS delivers fs.watch notifications through FSEvents, which registers
   *  asynchronously, so the seed write performed just before `start()` can still
   *  surface afterwards. Without this barrier the suite reports its own setup as
   *  a containment breach. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.events.length = 0;
  }

  simulateDelayedNotificationForTests(event: string): void {
    this.observe(event);
  }

  observedEventsForTests(): string[] {
    return [...this.events];
  }

  async waitForMutationForTests(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.events.length === 0) throw new Error('record guard did not observe a real mutation');
  }

  stop(): { events: string[]; bytesUnchanged: boolean } {
    this.fileWatcher?.close();
    this.dirWatcher?.close();
    this.fileWatcher = null;
    this.dirWatcher = null;
    const current = recordSnapshot(this.path);
    const initialBytes = this.initialSnapshot.exists ? this.initialSnapshot.bytes : null;
    const currentBytes = current.exists ? current.bytes : null;
    return { events: [...this.events], bytesUnchanged: currentBytes === initialBytes };
  }
}

let guard: MachineRecordGuard;
const homes: string[] = [];

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'imcodes-containment-'));
  homes.push(home);
  return home;
}

/**
 * Run `publishHookAuthority` in a REAL child process, the way a suite that
 * spawns the daemon does. The child gets no `VITEST`, so it reports itself as
 * production - which is precisely the case the env-based guard missed.
 */
function publishInChild(
  home: string,
  options: { machineRoot?: string } = {},
): { published: boolean; reason?: string } {
  // Dynamic import with NO top-level await: `tsx --eval` compiles to CJS, where
  // top-level await is rejected outright.
  const modulePath = JSON.stringify(join(process.cwd(), 'src/daemon/hook-port.ts'));
  const script = `import(${modulePath})`
    + `.then((m) => m.publishHookAuthority(${ROGUE_PORT}))`
    + `.then((r) => process.stdout.write(JSON.stringify({ published: r.published, reason: r.reason })))`
    + `.catch((e) => { process.stderr.write(String(e)); process.exit(1); });`;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    IMCODES_HOME: options.machineRoot ?? home,
  };
  // Strip every marker a test runner leaks, so the child is indistinguishable
  // from a production daemon start.
  delete childEnv.VITEST;
  delete childEnv.VITEST_WORKER_ID;
  delete childEnv.VITEST_POOL_ID;

  const run = spawnSync('npx', ['tsx', '--eval', script], {
    encoding: 'utf8',
    env: childEnv,
    cwd: process.cwd(),
    timeout: 60_000,
  });
  const stdout = (run.stdout ?? '').trim();
  const parsed = stdout.slice(stdout.indexOf('{'));
  try {
    return JSON.parse(parsed) as { published: boolean; reason?: string };
  } catch {
    throw new Error(`child did not report a result. stdout=${run.stdout} stderr=${run.stderr}`);
  }
}

beforeEach(async () => {
  machineHome = mkdtempSync(join(tmpdir(), 'imcodes-machine-root-'));
  homes.push(machineHome);
  vi.stubEnv('IMCODES_HOME', machineHome);
  machinePortFile = hookPortFilePath();
  // Sanity: the redirect must actually have taken effect, or the whole suite
  // would be asserting nothing.
  expect(machinePortFile).toBe(join(machineHome, HOOK_PORT_FILE_NAME));
  // Seed the record so there is something a rogue publisher could overwrite.
  // SEEDED_PORT must have no listener, so the only thing that can refuse the
  // child is the instance-lock fence. Seeding a port that IS served locally made
  // this test pass via the unrelated legacy-listener fence.
  writeFileSync(machinePortFile, `${SEEDED_PORT}\n`);
  guard = new MachineRecordGuard(machinePortFile);
  guard.start();
  await guard.settle();
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const observed = guard.stop();
  vi.unstubAllEnvs();
  while (homes.length) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
  // Asserted in afterEach so it holds for EVERY test in this file, including any
  // added later that forgets to check.
  expect(observed.events, `machine hook-port was touched: ${observed.events.join(', ')}`).toEqual([]);
  expect(observed.bytesUnchanged).toBe(true);
});

describe('machine hook-port containment', () => {
  it('ignores a delayed macOS seed notification when the record never changed', () => {
    guard.simulateDelayedNotificationForTests(`dir:rename:${HOOK_PORT_FILE_NAME}`);
    expect(guard.observedEventsForTests()).toEqual([]);
  });

  it('detects an actual same-bytes atomic replacement of the machine record', async () => {
    const staged = join(machineHome, `${HOOK_PORT_FILE_NAME}.positive-control`);
    writeFileSync(staged, `${SEEDED_PORT}\n`);
    renameSync(staged, machinePortFile);
    await guard.waitForMutationForTests();
    const observed = guard.stop();
    expect(observed.events.length).toBeGreaterThan(0);
    // Bytes alone cannot prove containment: atomic replacement can preserve
    // them exactly while changing the inode, which the guard must still catch.
    expect(observed.bytesUnchanged).toBe(true);

    // Re-arm the outer invariant from the new stable snapshot so afterEach can
    // continue proving that this positive control caused no later mutation.
    guard = new MachineRecordGuard(machinePortFile);
    guard.start();
    await guard.settle();
  });

  it('fences a spawned child that has no test-runner environment', () => {
    const home = machineHome;
    // A live daemon lock owned by ANOTHER process - here this very test process,
    // which is certainly alive and is not the child.
    const incumbent = currentDaemonProcessIdentity();
    writeFileSync(
      join(home, DAEMON_INSTANCE_LOCK_FILE_NAME),
      `${JSON.stringify({
        version: 1,
        pid: incumbent.pid,
        startToken: incumbent.startToken,
        acquiredAt: Date.now(),
        socketPath: join(home, 'daemon.sock'),
        sessionIds: [],
        residualResources: [],
      })}\n`,
    );

    const result = publishInChild(home);
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    // Nothing was written, not even into the sandbox.
    // Refused, so the seeded record is byte-for-byte what we wrote.
    expect(readFileSync(join(home, HOOK_PORT_FILE_NAME), 'utf8')).toBe(`${SEEDED_PORT}\n`);
  });

  it('lets the lock-owning process publish, so the fence is not simply "always refuse"', () => {
    // A DIFFERENT machine root, so the watched record stays untouched while we
    // prove the positive case. No lock recorded there: the child IS the daemon.
    const home = sandboxHome();
    const result = publishInChild(home, { machineRoot: home });
    expect(result.published).toBe(true);
    expect(readFileSync(join(home, HOOK_PORT_FILE_NAME), 'utf8')).toBe(`${ROGUE_PORT}\n`);
  });

  it('keeps the production record untouched while a sandboxed hook server runs', async () => {
    const { startHookServer, closeHookServer } = await import('../../src/daemon/hook-server.js');
    const home = sandboxHome();
    const { server, port } = await startHookServer(() => {}, { authorityHome: home });
    try {
      expect(readFileSync(join(home, HOOK_PORT_FILE_NAME), 'utf8')).toBe(`${port}\n`);
    } finally {
      await closeHookServer(server);
    }
  });

  it('proves a sandbox home is genuinely not the machine record', () => {
    const home = sandboxHome();
    mkdirSync(home, { recursive: true });
    expect(join(home, HOOK_PORT_FILE_NAME)).not.toBe(machinePortFile);
    expect(machinePortFile).toBe(join(imcodesHomeDir(), HOOK_PORT_FILE_NAME));
  });
});
