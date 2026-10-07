import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_LINUX_WATCHDOG_SURVIVAL_MS,
  CONTROLLED_NODE_UPGRADE_HEALTH as H,
  CONTROLLED_NODE_UPGRADE_RESULT_FILE,
  CONTROLLED_NODE_UPGRADE_RESULT_STATUS as S,
  CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED as PREFLIGHT_FAILED,
} from '../../shared/controlled-node-service.js';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';
import { buildPosixControlledNodeUpgradeScript } from '../../src/node/posix-upgrade-script.js';
import { posixUpgradeHealthWaitScript } from '../../src/node/upgrade-health-script.js';
import { reconcilePreviousUpgrade } from '../../src/node/upgrade-result.js';
import { createHash } from 'node:crypto';
import { FAKE_STUBS, LAUNCHCTL, SYSTEMCTL, marker } from './posix-upgrade-fakes.js';

const execFileAsync = promisify(execFile);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const posixOnly = process.platform === 'win32';

// ---- the pure verdict, from the same numbers as the Windows function ----------------------------

async function verdict(args: Array<number | string>): Promise<string> {
  const script = `${posixUpgradeHealthWaitScript()}\nimcodes_upgrade_health_verdict ${args.map((a) => `'${a}'`).join(' ')}\n`;
  const { stdout } = await execFileAsync('/bin/sh', ['-c', script]);
  return stdout.trim();
}

describe.skipIf(posixOnly)('POSIX health verdict (shared numbers with the Windows wait)', () => {
  // elapsed first_seen alive absent healthy restarts interrupted
  it.each([
    [[5_000, 2_000, 1, 0, 1, 0, ''], 'healthy'],
    [[5_000, 2_000, 1, 0, 2, 0, ''], 'healthy'],
    [[5_000, '', 0, 3, 0, 0, ''], 'wait'],
    [[H.SPAWN_ALLOWANCE_MS, '', 0, 90, 0, 0, ''], 'fail_no_process'],
    [[H.HARD_CAP_MS, 1_000, 1, 0, 0, 0, ''], 'fail_hard_cap'],
    [[H.HARD_CAP_MS - 1, 1_000, 1, 0, 0, 0, ''], 'wait'],
    [[1_000 + H.BASE_WINDOW_MS - 1, 1_000, 0, 50, 0, 0, ''], 'wait'],
    [[1_000 + H.BASE_WINDOW_MS, 1_000, 1, 0, 0, 0, ''], 'wait'],
    [[1_000 + H.BASE_WINDOW_MS, 1_000, 0, H.ABSENT_POLLS_AFTER_FLOOR - 1, 0, 0, ''], 'wait'],
    [[1_000 + H.BASE_WINDOW_MS, 1_000, 0, H.ABSENT_POLLS_AFTER_FLOOR, 0, 0, ''], 'fail_process_gone'],
    [[10_000, 1_000, 1, 0, 0, H.CRASH_LOOP_RESTARTS - 1, ''], 'wait'],
    [[10_000, 1_000, 1, 0, 0, H.CRASH_LOOP_RESTARTS, ''], 'fail_crash_loop'],
    [[10_000, 1_000, 1, 0, 0, 0, '1'], 'fail_interrupted'],
    // an authenticated lease beats an interrupt that arrives in the same poll: the node IS healthy
    [[10_000, 1_000, 1, 0, 1, 0, '1'], 'healthy'],
  ] as const)('%j -> %s', async (args, expected) => {
    expect(await verdict([...args])).toBe(expected);
  });
});

// ---- the real generated script, under sh, with a virtual clock and a scripted node --------------


interface Rig {
  root: string;
  fake: string;
  bin: string;
  dst: string;
  manifest: string;
  journal: string;
  lease: string;
  resultPath: string;
  stage: string;
  stagedArtifact: string;
  stagedManifest: string;
  stagedJournal: string;
  unit: string;
  calls: () => Promise<string[]>;
}

const roots: string[] = [];
const helpers: ChildProcess[] = [];
let pidA = 0;
let pidB = 0;

beforeAll(() => {
  if (posixOnly) return;
  for (const slot of [0, 1]) {
    const child = spawn('sleep', ['3600'], { stdio: 'ignore' });
    helpers.push(child);
    if (slot === 0) pidA = child.pid ?? 0; else pidB = child.pid ?? 0;
  }
});
afterAll(() => { for (const child of helpers) child.kill('SIGKILL'); });
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function makeRig(options: { oldNode?: string; newNode?: string; platform?: 'linux' | 'darwin'; journalOld?: string } = {}): Promise<Rig> {
  const platform = options.platform ?? 'linux';
  const root = await mkdtemp(join(tmpdir(), 'imcodes-posix-upgrade-'));
  roots.push(root);
  const fake = join(root, 'fake');
  const bin = join(root, 'bin');
  const installed = join(root, 'installed');
  const stage = join(root, 'imcodes-node-upgrade-abcd12');
  for (const dir of [fake, bin, installed, stage]) await mkdir(dir, { recursive: true });
  await writeFile(join(fake, 'clock'), '1800000000\n');
  for (const [name, body] of Object.entries({ ...FAKE_STUBS, systemctl: SYSTEMCTL, launchctl: LAUNCHCTL })) {
    await writeFile(join(bin, name), body, { mode: 0o755 });
    await chmod(join(bin, name), 0o755);
  }
  const dst = join(installed, 'imcodes-node');
  const rig: Rig = {
    root, fake, bin, dst,
    manifest: `${dst}.manifest.json`,
    journal: join(installed, 'install-journal.json'),
    lease: join(installed, 'health-lease.json'),
    resultPath: join(installed, CONTROLLED_NODE_UPGRADE_RESULT_FILE),
    stage,
    stagedArtifact: join(stage, 'imcodes-node'),
    stagedManifest: join(stage, 'imcodes-node.manifest.json'),
    stagedJournal: join(stage, 'install-journal.json'),
    unit: join(installed, 'imcodes-node.service'),
    // reset-failed / daemon-reload are bookkeeping around start; the assertions are about stop/start order
    calls: async () => (await readFile(join(fake, 'calls'), 'utf8').catch(() => '')).split('\n').filter((call) => call && call !== 'reset-failed'),
  };
  await writeFile(dst, options.oldNode ?? marker('healthy', 2), { mode: 0o755 });
  await writeFile(rig.manifest, JSON.stringify({ build: { version: 'old' } }));
  await writeFile(rig.journal, options.journalOld ?? JSON.stringify({ stagedReceipt: { sha256: 'old' } }));
  await writeFile(rig.unit, '[Service]\nExecStart=/old\n');
  await writeFile(rig.stagedArtifact, options.newNode ?? marker('healthy', 5), { mode: 0o755 });
  await writeFile(rig.stagedManifest, JSON.stringify({ build: { version: 'new' } }));
  await writeFile(rig.stagedJournal, JSON.stringify({ stagedReceipt: { sha256: 'new' } }));
  await writeFile(join(stage, '.imcodes-controlled-node-upgrade.json'), JSON.stringify({
    schemaVersion: 1, product: 'imcodes-controlled-node-upgrade', directoryName: 'imcodes-node-upgrade-abcd12',
    ownerToken: '12345678-1234-4123-8123-123456789abc', createdAt: 1, pid: 1,
  }));
  // the old node is "running": its service has been up since before the upgrade
  await writeFile(join(fake, 'started_at'), '1799999000\n');
  void platform;
  return rig;
}

const TARGET = '2026.10.9000-dev.9000';

function scriptFor(rig: Rig, extra: Partial<Parameters<typeof buildPosixControlledNodeUpgradeScript>[0]> = {}): string {
  return buildPosixControlledNodeUpgradeScript({
    platform: 'linux',
    stagedArtifactPath: rig.stagedArtifact,
    stagedManifestPath: rig.stagedManifest,
    stagedJournalPath: rig.stagedJournal,
    destinationPath: rig.dst,
    destinationManifestPath: rig.manifest,
    destinationJournalPath: rig.journal,
    targetVersion: TARGET,
    serviceDefinitionPaths: [rig.unit],
    stagingOwnership: {
      directoryPath: rig.stage,
      markerPath: join(rig.stage, '.imcodes-controlled-node-upgrade.json'),
      ownerToken: '12345678-1234-4123-8123-123456789abc',
    },
    ...extra,
  });
}

interface RunOptions { scale?: number; env?: Record<string, string>; allowRunaway?: boolean }

/**
 * Runs the generated script. There is deliberately NO wall-clock timeout that could signal it: the script
 * traps TERM as "stop requested" and rolls back (fail_interrupted), so a harness timeout on a slow runner
 * used to surface as a wrong verdict. Time is virtual; the runaway guard in the sleep stub bounds a loop.
 */
async function run(rig: Rig, script: string, options: RunOptions = {}): Promise<{ code: number; stderr: string; runaway: boolean }> {
  const path = join(rig.root, 'upgrade.sh');
  await writeFile(path, script, { mode: 0o755 });
  let result: { code: number; stderr: string };
  try {
    await execFileAsync('/bin/sh', [path], {
      env: {
        ...process.env,
        PATH: `${rig.bin}:${process.env.PATH ?? ''}`,
        FAKE: rig.fake, DST: rig.dst, LEASE: rig.lease,
        FAKE_PID_A: String(pidA), FAKE_PID_B: String(pidB),
        FAKE_SLEEP_SCALE: String(options.scale ?? 1),
        ...options.env,
      },
    });
    result = { code: 0, stderr: '' };
  } catch (error) {
    const e = error as { code?: number | string; stderr?: string; signal?: string };
    result = { code: typeof e.code === 'number' ? e.code : -1, stderr: e.stderr ?? String(e.signal ?? '') };
  }
  const runaway = await exists(join(rig.fake, 'runaway'));
  if (runaway && !options.allowRunaway) throw new Error('the script never reached a verdict (runaway guard fired)');
  return { ...result, runaway };
}

/** The recorded rollback names exactly one health verdict: assert it, not a substring of whatever text there is. */
async function expectRollbackVerdict(rig: Rig, verdict: string): Promise<Record<string, unknown>> {
  const result = await readResult(rig);
  expect(result.status).toBe(S.ROLLED_BACK);
  expect(String(result.error)).toMatch(new RegExp(`^controlled node upgrade failed authenticated health verification \\(${verdict} after \\d+s\\)$`));
  return result;
}

const readResult = async (rig: Rig): Promise<Record<string, unknown>> => JSON.parse(await readFile(rig.resultPath, 'utf8')) as Record<string, unknown>;
const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
const text = (path: string): Promise<string> => readFile(path, 'utf8');
const elapsedVirtual = async (rig: Rig): Promise<number> => Number((await text(join(rig.fake, 'clock'))).trim()) - 1_800_000_000;

/** A rig whose staged artifact hash is honest (the script verifies it before touching anything). */
async function scenario(options: { newNode?: string; oldNode?: string; platform?: 'linux' | 'darwin'; extra?: Partial<Parameters<typeof buildPosixControlledNodeUpgradeScript>[0]> } = {}) {
  const rig = await makeRig({ newNode: options.newNode, oldNode: options.oldNode });
  const staged = await text(rig.stagedArtifact);
  const platform = options.platform ?? 'linux';
  const script = scriptFor(rig, { artifactSha256: sha256(staged), platform, ...(options.extra ?? {}) });
  return { rig, script, staged };
}


/** Virtual seconds per poll multiplied for the scenarios that span the 15-minute cap: 15 polls instead of 450. */
const HARD_CAP_SCALE = 30;

/**
 * Everything the "rolled back at the hard cap, and only then" intent says, as a list of violations (empty = holds):
 * rolled back with exactly the hard-cap verdict, the old node is back, and the verdict came at the cap, not before
 * and not more than two (scaled) polls after it.
 */
async function hardCapViolations(rig: Rig, oldBytes: string): Promise<string[]> {
  const violations: string[] = [];
  const result = await readResult(rig).catch(() => ({} as Record<string, unknown>));
  if (result.status !== S.ROLLED_BACK) violations.push(`status ${String(result.status)} is not rolled_back`);
  const verdictMatch = /\((fail_[a-z_]+|healthy) after (\d+)s\)/.exec(String(result.error ?? ''));
  if (verdictMatch?.[1] !== 'fail_hard_cap') violations.push(`verdict ${verdictMatch?.[1] ?? 'none'} is not fail_hard_cap`);
  const cap = H.HARD_CAP_MS / 1000;
  const pollStep = (H.POLL_MS / 1000) * HARD_CAP_SCALE;
  const reported = Number(verdictMatch?.[2] ?? NaN);
  if (!(reported >= cap)) violations.push(`verdict after ${reported}s, before the ${cap}s cap`);
  if (!(reported <= cap + 2 * pollStep)) violations.push(`verdict after ${reported}s, long after the ${cap}s cap`);
  if ((await text(rig.dst)) !== oldBytes) violations.push('the old node was not restored');
  if (await exists(join(rig.fake, 'runaway'))) violations.push('the script never reached a verdict (runaway)');
  return violations;
}

describe.skipIf(posixOnly)('POSIX self-upgrade transaction (generated script under sh)', { timeout: 120_000 }, () => {
  it('a healthy new node: waits for its lease, records success, drops the rollback images and the staging', async () => {
    const { rig, script, staged } = await scenario({ newNode: marker('healthy', 5) });
    const { code, stderr } = await run(rig, script);
    expect(code, stderr).toBe(0);
    expect(await text(rig.dst)).toBe(staged);
    expect(JSON.parse(await text(rig.manifest))).toMatchObject({ build: { version: 'new' } });
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS, phase: 'complete', targetVersion: TARGET, artifactSha256: sha256(staged) });
    expect(await exists(`${rig.dst}.upgrade-old`)).toBe(false);
    expect(await exists(`${rig.manifest}.upgrade-old`)).toBe(false);
    expect(await exists(`${rig.journal}.upgrade-old`)).toBe(false);
    expect(await exists(rig.stage)).toBe(false);
    expect(await readdir(join(rig.root, 'installed'))).not.toContain('imcodes-node.new');
    expect(await rig.calls()).toEqual(['stop', 'start']);
    // the success replaced the previous attempt's record: no stale failure survives
    expect(JSON.stringify(await readResult(rig))).not.toContain('rollback');
  });

  it('a stale failure record from an earlier attempt is replaced by this attempt (in_progress, then success)', async () => {
    const { rig, script } = await scenario();
    await writeFile(rig.resultPath, JSON.stringify({ status: S.ROLLED_BACK, targetVersion: TARGET, recordedAt: 1 }));
    expect((await run(rig, script)).code).toBe(0);
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS });
  });

  it('a slow node (180 s to authenticate) is waited for, not rolled back', async () => {
    const { rig, script, staged } = await scenario({ newNode: marker('healthy', 180) });
    const { code, stderr } = await run(rig, script, { scale: 10 });
    expect(code, stderr).toBe(0);
    expect(await text(rig.dst)).toBe(staged);
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS });
    expect(await elapsedVirtual(rig)).toBeGreaterThan(H.BASE_WINDOW_MS / 1000);
  });

  it('a new node that never starts is rolled back within the spawn allowance; the old node is back and the failure is recorded', async () => {
    const { rig, script } = await scenario({ newNode: marker('dead') });
    const oldBytes = await text(rig.dst);
    const { code } = await run(rig, script, { scale: 10 });
    expect(code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(JSON.parse(await text(rig.manifest))).toMatchObject({ build: { version: 'old' } });
    expect(JSON.parse(await text(rig.journal))).toMatchObject({ stagedReceipt: { sha256: 'old' } });
    const result = await expectRollbackVerdict(rig, 'fail_no_process');
    expect(result).toMatchObject({ phase: 'rollback', failedPhase: 'restart_health', targetVersion: TARGET });
    expect(result.rollbackProgress).toEqual(expect.arrayContaining(['stop_new_node', 'restore_main', 'restore_manifest', 'restore_journal', 'start_previous_node']));
    expect(await rig.calls()).toEqual(['stop', 'start', 'stop', 'start']);
    expect(await exists(`${rig.dst}.upgrade-old`)).toBe(false);
    const elapsed = await elapsedVirtual(rig);
    expect(elapsed).toBeGreaterThanOrEqual(H.SPAWN_ALLOWANCE_MS / 1000);
    expect(elapsed).toBeLessThan((H.SPAWN_ALLOWANCE_MS + 2 * 10 * 20_000) / 1000);
    // the node reports it: a rolled_back record is a failure of exactly this target
    expect(await reconcilePreviousUpgrade({ journalPath: rig.journal, runningVersion: 'old-version', now: Date.now() }))
      .toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
  });

  it('a node that keeps crashing (service manager respawns it) is judged failed fast, not at the 15-minute cap', async () => {
    const { rig, script } = await scenario({ newNode: marker('crashloop') });
    const oldBytes = await text(rig.dst);
    const { code } = await run(rig, script);
    expect(code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    await expectRollbackVerdict(rig, 'fail_crash_loop');
    expect(await elapsedVirtual(rig)).toBeLessThan(H.HARD_CAP_MS / 1000 / 4);
  });

  it('a node that stays up but whose lease names the wrong pid is rolled back at the hard cap, and only then', async () => {
    const { rig, script } = await scenario({ newNode: marker('badlease', 3) });
    const oldBytes = await text(rig.dst);
    await run(rig, script, { scale: HARD_CAP_SCALE });
    expect(await hardCapViolations(rig, oldBytes)).toEqual([]);
  });

  it('a Linux target that predates the lease is accepted once it survived the watchdog window under one pid', async () => {
    const { rig, script, staged } = await scenario({ newNode: marker('nolease') });
    const { code, stderr } = await run(rig, script, { scale: 10 });
    expect(code, stderr).toBe(0);
    expect(await text(rig.dst)).toBe(staged);
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS });
    expect(await elapsedVirtual(rig)).toBeGreaterThanOrEqual(CONTROLLED_NODE_LINUX_WATCHDOG_SURVIVAL_MS / 1000);
  });

  it('the macOS script has no lease-less shortcut: an alive node that never authenticates is rolled back at the cap', async () => {
    const { rig, script } = await scenario({ newNode: marker('nolease'), platform: 'darwin', extra: { serviceDefinitionPaths: [] } });
    const oldBytes = await text(rig.dst);
    await run(rig, script, { scale: HARD_CAP_SCALE });
    expect(await hardCapViolations(rig, oldBytes)).toEqual([]);
  });

  it('a stop request (SIGTERM) during the health wait rolls back instead of leaving the new node unverified', async () => {
    const { rig, script } = await scenario({ newNode: marker('healthy', 600) });
    const oldBytes = await text(rig.dst);
    await writeFile(join(rig.fake, 'signal_at'), '1800000040\n');
    await writeFile(join(rig.fake, 'signal_name'), 'TERM\n');
    const { code } = await run(rig, script);
    expect(code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    await expectRollbackVerdict(rig, 'fail_interrupted');
  });

  it('a script killed outright (SIGKILL / reboot) leaves in_progress and the rollback images; a re-run adopts them, and the node reconciles the record', async () => {
    const { rig, script, staged } = await scenario({ newNode: marker('healthy', 600) });
    const original = await text(rig.dst);
    await writeFile(join(rig.fake, 'signal_at'), '1800000040\n');
    await writeFile(join(rig.fake, 'signal_name'), 'KILL\n');
    const killed = await run(rig, script);
    expect(killed.code).not.toBe(0);
    expect(await readResult(rig)).toMatchObject({ status: S.IN_PROGRESS, targetVersion: TARGET });
    expect(await text(rig.dst)).toBe(staged);
    expect(await text(`${rig.dst}.upgrade-old`)).toBe(original);
    // a live script's record is left alone; a dead one's is repaired and reported once it is stale
    const recordedAt = Number((await readResult(rig)).recordedAt);
    expect(await reconcilePreviousUpgrade({ journalPath: rig.journal, runningVersion: 'v-old', now: recordedAt + 60_000 })).toBeNull();
    expect(await reconcilePreviousUpgrade({ journalPath: rig.journal, runningVersion: 'v-old', now: recordedAt + 3 * H.HARD_CAP_MS }))
      .toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
    // a node that is running the target IS the outcome
    expect(await reconcilePreviousUpgrade({ journalPath: rig.journal, runningVersion: TARGET, now: recordedAt + 3 * H.HARD_CAP_MS })).toBeNull();
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS, recordedBy: 'node' });

    // re-run against the same staged artifact, interrupted again: the killed attempt had already published the
    // target, so the rollback base must be the ORIGINAL node kept by that attempt, not the half-published one
    await writeFile(join(rig.fake, 'signal_at'), '1800000140\n');
    await writeFile(join(rig.fake, 'signal_name'), 'TERM\n');
    await writeFile(join(rig.fake, 'clock'), '1800000100\n');
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.dst)).toBe(original);
    expect(await readResult(rig)).toMatchObject({ status: S.ROLLED_BACK });
  });

  it('preflight refuses a staged artifact whose hash does not match: the service is never stopped and nothing is replaced', async () => {
    const { rig, script } = await scenario();
    await writeFile(rig.stagedArtifact, 'tampered');
    const oldBytes = await text(rig.dst);
    const { code } = await run(rig, script);
    expect(code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(await rig.calls()).toEqual([]);
    expect(await readResult(rig)).toMatchObject({ status: PREFLIGHT_FAILED, phase: 'preflight' });
    expect(await exists(`${rig.dst}.new`)).toBe(false);
  });

  it('a full disk while staging ends in preflight: the old node keeps running untouched', async () => {
    const { rig, script } = await scenario();
    // cp fails for anything written next to the installed node (the pending copy)
    await writeFile(join(rig.bin, 'cp'), '#!/bin/sh\nfor a in "$@"; do case "$a" in *imcodes-node.new) exit 1;; esac; done\nexec /bin/cp "$@"\n', { mode: 0o755 });
    const oldBytes = await text(rig.dst);
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(await rig.calls()).toEqual([]);
    expect(await readResult(rig)).toMatchObject({ status: PREFLIGHT_FAILED });
  });

  it('a publish failure after the service was stopped rolls back and restarts the old node', async () => {
    const { rig, script } = await scenario();
    const oldBytes = await text(rig.dst);
    await writeFile(join(rig.bin, 'mv'), '#!/bin/sh\nfor a in "$@"; do case "$a" in *install-journal.json.new) exit 1;; esac; done\nexec /bin/mv "$@"\n', { mode: 0o755 });
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(JSON.parse(await text(rig.manifest))).toMatchObject({ build: { version: 'old' } });
    expect(await readResult(rig)).toMatchObject({ status: S.ROLLED_BACK, failedPhase: 'install' });
    // stopped for the install, started again after the rollback
    expect(await rig.calls()).toEqual(['stop', 'stop', 'start']);
  });

  it('puts the previous remote-desktop worker back when the upgrade is rolled back', async () => {
    const rig = await makeRig({ newNode: marker('dead') });
    const worker = join(rig.root, 'installed', 'remote-desktop-worker');
    const stagedWorker = join(rig.stage, 'remote-desktop-worker');
    await mkdir(worker, { recursive: true });
    await mkdir(stagedWorker, { recursive: true });
    const { REMOTE_DESKTOP_LINUX_WORKER_FILENAME: workerName } = await import('../../shared/remote-desktop-worker.js');
    await writeFile(join(worker, workerName), 'old-worker', { mode: 0o755 });
    await writeFile(join(stagedWorker, workerName), 'new-worker', { mode: 0o755 });
    const staged = await text(rig.stagedArtifact);
    expect((await run(rig, scriptFor(rig, { artifactSha256: sha256(staged), stagedRemoteDesktopWorkerDir: stagedWorker }))).code).toBe(1);
    expect(await text(join(worker, workerName))).toBe('old-worker');
    expect(await exists(`${worker}.upgrade-old`)).toBe(false);
    expect(await exists(`${worker}.new`)).toBe(false);
    expect(await readResult(rig)).toMatchObject({ status: S.ROLLED_BACK });
    expect((await readResult(rig)).rollbackProgress).toContain('restore_remote_desktop');
  });

  it('a worker that cannot be staged ends in preflight: nothing is replaced and the service is never stopped', async () => {
    const rig = await makeRig();
    const stagedWorker = join(rig.stage, 'remote-desktop-worker');
    await mkdir(stagedWorker, { recursive: true });
    await writeFile(join(stagedWorker, 'not-the-worker'), 'x');
    const staged = await text(rig.stagedArtifact);
    const oldBytes = await text(rig.dst);
    expect((await run(rig, scriptFor(rig, { artifactSha256: sha256(staged), stagedRemoteDesktopWorkerDir: stagedWorker }))).code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(await rig.calls()).toEqual([]);
    expect(await readResult(rig)).toMatchObject({ status: PREFLIGHT_FAILED });
  });

  it('puts back a service definition (unit/plist) that the new node rewrote, and reloads the service manager', async () => {
    const { rig, script } = await scenario({ newNode: marker('dead') });

    const before = await text(rig.unit);
    // the new node rewrites its own unit as it starts
    await writeFile(join(rig.fake, 'on_start'), `grep -q 'kind=dead' "${rig.dst}" && echo '[Service]\nExecStart=/new' > "${rig.unit}"\n`);
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.unit)).toBe(before);
    expect(await rig.calls()).toContain('daemon-reload');
    expect((await readResult(rig)).rollbackProgress).toContain('restore_service_definitions');
    expect(await readdir(join(rig.root, 'installed'))).not.toContain('imcodes-node.service-def-0.upgrade-old');
  });

  it('a rollback step that fails is recorded as rollback_failed, the old node is still restarted, and the images are kept', async () => {
    const { rig, script } = await scenario({ newNode: marker('dead') });
    // corrupt the rollback image while the new node "starts"
    await writeFile(join(rig.fake, 'on_start'), `grep -q 'kind=dead' "${rig.dst}" && { rm -f "${rig.dst}.upgrade-old"; echo corrupted > "${rig.dst}.upgrade-old"; }\n`);
    const { code } = await run(rig, script);
    expect(code).toBe(1);
    const result = await readResult(rig);
    expect(result).toMatchObject({ status: S.ROLLBACK_FAILED });
    expect(result.recoveryFailures).toEqual(['restore_main failed']);
    expect(await rig.calls()).toEqual(['stop', 'start', 'stop', 'start']);
    expect(await exists(`${rig.dst}.upgrade-old`)).toBe(true);
    expect(await reconcilePreviousUpgrade({ journalPath: rig.journal, runningVersion: 'v-old', now: Date.now() }))
      .toEqual({ targetVersion: TARGET, reason: DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_FAILED });
  });

  it('macOS: the watchdog is out for the whole transaction and back after it, on success AND on rollback', async () => {
    for (const [kind, status] of [['healthy', S.SUCCESS], ['dead', S.ROLLED_BACK]] as const) {
      const { rig, script } = await scenario({ newNode: marker(kind, 5), platform: 'darwin', extra: { serviceDefinitionPaths: [] } });
      await run(rig, script);
      expect((await readResult(rig)).status).toBe(status);
      const calls = await rig.calls();
      expect(calls[0]).toBe('bootout system/cc.imcodes.node.watchdog');
      expect(calls[1]).toBe('bootout system/cc.imcodes.node');
      expect(calls.at(-1)).toBe('bootstrap /Library/LaunchDaemons/cc.imcodes.node.watchdog.plist');
      expect(calls.filter((call) => call.includes('watchdog.plist'))).toHaveLength(1);
      expect(calls).toContain('kickstart system/cc.imcodes.node');
    }
  });

  it('macOS: refuses a Mach-O the kernel would kill, before the service is stopped', async () => {
    const { rig, script } = await scenario({ platform: 'darwin', extra: { serviceDefinitionPaths: [] } });
    await writeFile(join(rig.bin, 'file'), '#!/bin/sh\necho "Mach-O 64-bit executable arm64"\n', { mode: 0o755 });
    await writeFile(join(rig.bin, 'codesign'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const oldBytes = await text(rig.dst);
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(await rig.calls()).toEqual([]);
    expect(await readResult(rig)).toMatchObject({ status: PREFLIGHT_FAILED });
  });

  it('never writes the service definition on success either: a successful upgrade leaves the unit byte-identical', async () => {
    const { rig, script } = await scenario();
    const before = await text(rig.unit);
    expect((await run(rig, script)).code).toBe(0);
    expect(await text(rig.unit)).toBe(before);
    expect(script).not.toMatch(/systemctl (enable|disable|edit|mask)/);
  });
});

// ---- mutation guard: the hard-cap assertions must FAIL when the logic they protect is broken -----

describe.skipIf(posixOnly)('mutation guard for the hard-cap behaviour', { timeout: 120_000 }, () => {
  const capLine = `  if [ "$1" -ge ${H.HARD_CAP_MS} ]; then echo fail_hard_cap; return 0; fi`;
  const leasePidLine = `  [ "$lease_pid" = "$(imcodes_service_pid)" ] || return 1`;
  const mutants: Array<[string, (script: string) => string]> = [
    ['the cap fires after 5 minutes instead of 15', (script) => script.replace(capLine, capLine.replace(String(H.HARD_CAP_MS), '300000'))],
    ['there is no hard cap at all (the wait would never end)', (script) => script.replace(`${capLine}\n`, '')],
    ['the cap is reported as a different verdict', (script) => script.replace(capLine, capLine.replace('echo fail_hard_cap', 'echo fail_interrupted'))],
    ['a lease naming a pid that is not the service pid is accepted', (script) => script.replace(`${leasePidLine}\n`, '')],
  ];
  it.each(mutants)('is caught when %s', async (_name, mutate) => {
    const { rig, script } = await scenario({ newNode: marker('badlease', 3) });
    expect(script).toContain(capLine);
    expect(script).toContain(leasePidLine);
    const mutated = mutate(script);
    expect(mutated).not.toBe(script);
    const oldBytes = await text(rig.dst);
    await run(rig, mutated, { scale: HARD_CAP_SCALE, allowRunaway: true });
    expect(await hardCapViolations(rig, oldBytes)).not.toEqual([]);
  });
});
