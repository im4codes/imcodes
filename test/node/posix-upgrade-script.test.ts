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

type NodeKind = 'healthy' | 'dead' | 'nolease' | 'badlease' | 'crashloop';
const marker = (kind: NodeKind, leaseAt = 5): string => `NODE kind=${kind} lease_at=${leaseAt}\n`;

const FAKE_STUBS = {
  date: '#!/bin/sh\ncat "$FAKE/clock"\n',
  sleep: [
    '#!/bin/sh',
    'now=$(cat "$FAKE/clock"); now=$((now + $1)); echo "$now" > "$FAKE/clock"',
    // Scripted signal: deliver $SIG to the script (our parent) once the virtual clock passes $AT.
    'if [ -f "$FAKE/signal_at" ]; then at=$(cat "$FAKE/signal_at"); sig=$(cat "$FAKE/signal_name"); if [ "$now" -ge "$at" ]; then rm -f "$FAKE/signal_at"; kill -"$sig" "$PPID"; fi; fi',
    'exit 0',
    '',
  ].join('\n'),
};

/** The fake service manager: derives the node's pid/lease from how long it has been "running". */
const FAKE_SERVICE_MANAGER = [
  'node_state() {',
  '  [ -f "$FAKE/started_at" ] || { PID=0; RESTARTS=0; return; }',
  '  started=$(cat "$FAKE/started_at"); now=$(cat "$FAKE/clock"); el=$((now - started))',
  '  kind=$(sed -n "s/.*kind=\\([a-z]*\\).*/\\1/p" "$DST" | head -n 1); lease_at=$(sed -n "s/.*lease_at=\\([0-9]*\\).*/\\1/p" "$DST" | head -n 1)',
  '  PID=$FAKE_PID_A; RESTARTS=0',
  '  case "$kind" in',
  '    dead) PID=0;;',
  '    crashloop) RESTARTS=$((el / 5)); if [ $((RESTARTS % 2)) = 1 ]; then PID=$FAKE_PID_B; fi;;',
  '    healthy) if [ "$el" -ge "$lease_at" ]; then printf \'{"version":1,"pid":%s,"updatedAt":%s}\\n\' "$PID" $(( (started + lease_at) * 1000 )) > "$LEASE"; fi;;',
  '    badlease) if [ "$el" -ge "$lease_at" ]; then printf \'{"version":1,"pid":999999,"updatedAt":%s}\\n\' $(( (started + lease_at) * 1000 )) > "$LEASE"; fi;;',
  '  esac',
  '}',
  'do_start() { echo "$(cat "$FAKE/clock")" > "$FAKE/started_at"; echo start >> "$FAKE/calls"; [ -f "$FAKE/on_start" ] && sh "$FAKE/on_start"; return 0; }',
  'do_stop() { rm -f "$FAKE/started_at"; echo stop >> "$FAKE/calls"; }',
  '',
].join('\n');

const SYSTEMCTL = `#!/bin/sh
${FAKE_SERVICE_MANAGER}
case "$1" in
  stop) do_stop;;
  start) do_start;;
  reset-failed) echo reset-failed >> "$FAKE/calls";;
  daemon-reload) echo daemon-reload >> "$FAKE/calls";;
  show)
    node_state
    case "$3" in MainPID) echo "MainPID=$PID";; NRestarts) echo "NRestarts=$RESTARTS";; esac;;
esac
exit 0
`;

const LAUNCHCTL = `#!/bin/sh
${FAKE_SERVICE_MANAGER}
case "$1" in
  bootout) echo "bootout $2" >> "$FAKE/calls"; case "$2" in *watchdog) ;; *) rm -f "$FAKE/started_at";; esac;;
  bootstrap) echo "bootstrap $3" >> "$FAKE/calls";;
  kickstart) echo "kickstart $3" >> "$FAKE/calls"; do_start;;
  print) node_state; if [ "$PID" != "0" ]; then printf 'system/cc.imcodes.node = {\\n\\tpid = %s\\n}\\n' "$PID"; fi;;
esac
exit 0
`;

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

async function run(rig: Rig, script: string, env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  const path = join(rig.root, 'upgrade.sh');
  await writeFile(path, script, { mode: 0o755 });
  try {
    await execFileAsync('/bin/sh', [path], {
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${rig.bin}:${process.env.PATH ?? ''}`,
        FAKE: rig.fake, DST: rig.dst, LEASE: rig.lease,
        FAKE_PID_A: String(pidA), FAKE_PID_B: String(pidB),
        ...env,
      },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const e = error as { code?: number | string; stderr?: string; signal?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stderr: e.stderr ?? String(e.signal ?? '') };
  }
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
    const { code, stderr } = await run(rig, script);
    expect(code, stderr).toBe(0);
    expect(await text(rig.dst)).toBe(staged);
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS });
    expect(await elapsedVirtual(rig)).toBeGreaterThan(H.BASE_WINDOW_MS / 1000);
  });

  it('a new node that never starts is rolled back within the spawn allowance; the old node is back and the failure is recorded', async () => {
    const { rig, script } = await scenario({ newNode: marker('dead') });
    const oldBytes = await text(rig.dst);
    const { code } = await run(rig, script);
    expect(code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(JSON.parse(await text(rig.manifest))).toMatchObject({ build: { version: 'old' } });
    expect(JSON.parse(await text(rig.journal))).toMatchObject({ stagedReceipt: { sha256: 'old' } });
    const result = await readResult(rig);
    expect(result).toMatchObject({ status: S.ROLLED_BACK, phase: 'rollback', failedPhase: 'restart_health', targetVersion: TARGET });
    expect(String(result.error)).toContain('fail_no_process');
    expect(result.rollbackProgress).toEqual(expect.arrayContaining(['stop_new_node', 'restore_main', 'restore_manifest', 'restore_journal', 'start_previous_node']));
    expect(await rig.calls()).toEqual(['stop', 'start', 'stop', 'start']);
    expect(await exists(`${rig.dst}.upgrade-old`)).toBe(false);
    const elapsed = await elapsedVirtual(rig);
    expect(elapsed).toBeGreaterThanOrEqual(H.SPAWN_ALLOWANCE_MS / 1000);
    expect(elapsed).toBeLessThan((H.SPAWN_ALLOWANCE_MS + 60_000) / 1000);
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
    const result = await readResult(rig);
    expect(result).toMatchObject({ status: S.ROLLED_BACK });
    expect(String(result.error)).toContain('fail_crash_loop');
    expect(await elapsedVirtual(rig)).toBeLessThan(H.HARD_CAP_MS / 1000 / 4);
  });

  it('a node that stays up but whose lease names the wrong pid is rolled back at the hard cap, and only then', async () => {
    const { rig, script } = await scenario({ newNode: marker('badlease', 3) });
    const oldBytes = await text(rig.dst);
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(String((await readResult(rig)).error)).toContain('fail_hard_cap');
    const elapsed = await elapsedVirtual(rig);
    expect(elapsed).toBeGreaterThanOrEqual(H.HARD_CAP_MS / 1000);
    expect(elapsed).toBeLessThan(H.HARD_CAP_MS / 1000 + 120);
  });

  it('a Linux target that predates the lease is accepted once it survived the watchdog window under one pid', async () => {
    const { rig, script, staged } = await scenario({ newNode: marker('nolease') });
    const { code, stderr } = await run(rig, script);
    expect(code, stderr).toBe(0);
    expect(await text(rig.dst)).toBe(staged);
    expect(await readResult(rig)).toMatchObject({ status: S.SUCCESS });
    expect(await elapsedVirtual(rig)).toBeGreaterThanOrEqual(CONTROLLED_NODE_LINUX_WATCHDOG_SURVIVAL_MS / 1000);
  });

  it('the macOS script has no lease-less shortcut: an alive node that never authenticates is rolled back at the cap', async () => {
    const { rig, script } = await scenario({ newNode: marker('nolease'), platform: 'darwin', extra: { serviceDefinitionPaths: [] } });
    const oldBytes = await text(rig.dst);
    expect((await run(rig, script)).code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    expect(String((await readResult(rig)).error)).toContain('fail_hard_cap');
  });

  it('a stop request (SIGTERM) during the health wait rolls back instead of leaving the new node unverified', async () => {
    const { rig, script } = await scenario({ newNode: marker('healthy', 600) });
    const oldBytes = await text(rig.dst);
    await writeFile(join(rig.fake, 'signal_at'), '1800000040\n');
    await writeFile(join(rig.fake, 'signal_name'), 'TERM\n');
    const { code } = await run(rig, script);
    expect(code).toBe(1);
    expect(await text(rig.dst)).toBe(oldBytes);
    const result = await readResult(rig);
    expect(result).toMatchObject({ status: S.ROLLED_BACK });
    expect(String(result.error)).toContain('fail_interrupted');
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
