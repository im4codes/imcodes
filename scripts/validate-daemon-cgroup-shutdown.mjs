#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertNoCgroupSurvivors,
  assertDaemonDescendants,
  assertOrderedShutdownLog,
  assertPidsInControlGroup,
  assertSystemdShutdownAuthority,
} from '../dist/src/util/systemd-cgroup-validation.js';

const REQUIRED_NODE_ID = '9535523706';
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const nodeId = args.get('--node-id');
const cycles = Number(args.get('--cycles') ?? '100');
const candidateRoot = resolve(args.get('--candidate-root') ?? '');
const nodeExecutable = process.execPath;
const evidencePath = resolve(args.get('--evidence') ?? join(process.cwd(), 'daemon-cgroup-validation.json'));
if (nodeId !== REQUIRED_NODE_ID) throw new Error(`destructive validation is restricted to canonical nodeId=${REQUIRED_NODE_ID}; received ${nodeId ?? 'missing'}`);
if (process.platform !== 'linux') throw new Error('daemon cgroup validation requires Linux systemd');
if (!Number.isSafeInteger(cycles) || cycles !== 100) throw new Error('production acceptance requires exactly 100 cycles');
if (!args.has('--candidate-root') || !existsSync(join(candidateRoot, 'dist', 'src', 'index.js'))) {
  throw new Error('--candidate-root must contain the exact built candidate dist/src/index.js');
}
if (/\s/.test(candidateRoot)) throw new Error('--candidate-root cannot contain whitespace');
if (/\s/.test(nodeExecutable)) throw new Error(`Node executable cannot contain whitespace: ${nodeExecutable}`);

const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
}).trim();
const systemctl = (...commandArgs) => run('systemctl', ['--user', ...commandArgs]);
const isActive = () => spawnSync('systemctl', ['--user', 'is-active', '--quiet', service], {
  stdio: 'ignore',
}).status === 0;
const service = 'imcodes.service';
const initialActive = isActive();
const scratch = mkdtempSync(join(tmpdir(), 'imcodes-cgroup-validation-'));
const dropInDir = join(homedir(), '.config', 'systemd', 'user', `${service}.d`);
const dropIn = join(dropInDir, 'zz-cgroup-validation.conf');
const pidFile = join(scratch, 'probe-pids.json');
const daemonLog = join(homedir(), '.imcodes', 'logs', 'daemon.log');
const results = { nodeId, cycles, normalCycles: [], timeoutFallback: null, restoredInitialState: false };

function snapshot() {
  const values = systemctl('show', service,
    '-p', 'KillMode', '-p', 'SendSIGKILL', '-p', 'TimeoutStopUSec', '-p', 'ControlGroup', '-p', 'MainPID')
    .split('\n').reduce((out, line) => {
      const split = line.indexOf('=');
      if (split > 0) out[line.slice(0, split)] = line.slice(split + 1);
      return out;
    }, {});
  return {
    killMode: values.KillMode ?? '', sendSigkill: values.SendSIGKILL ?? '',
    timeoutStopUs: values.TimeoutStopUSec ?? '', controlGroup: values.ControlGroup ?? '',
    mainPid: Number(values.MainPID ?? 0),
  };
}

function writeProbe(ignoreTerm) {
  rmSync(pidFile, { force: true });
  mkdirSync(dropInDir, { recursive: true });
  writeFileSync(dropIn, `[Service]\nExecStart=\nExecStart=${nodeExecutable} ${candidateRoot}/dist/src/index.js start --foreground\nKillMode=control-group\nSendSIGKILL=yes\nTimeoutStopSec=${ignoreTerm ? 2 : 45}s\nStandardOutput=journal\nStandardError=journal\nEnvironment=IMCODES_CGROUP_VALIDATION_PROBE_FILE=${pidFile}\nEnvironment=IMCODES_CGROUP_VALIDATION_HANG_PHASE=${ignoreTerm ? 'container' : 'none'}\n`, 'utf8');
  systemctl('daemon-reload');
}

function probePids(daemonPid) {
  for (let i = 0; i < 1_200; i++) {
    if (existsSync(pidFile)) {
      try {
        const recorded = JSON.parse(readFileSync(pidFile, 'utf8'));
        const pids = recorded.probes?.map(({ pid }) => Number(pid)) ?? [];
        if (recorded.daemonPid === daemonPid && recorded.ready === true
          && pids.length === 4 && pids.every((pid) => pid > 0)) return pids;
      } catch { /* daemon is atomically replacing evidence */ }
    }
    run('sleep', ['0.05']);
  }
  throw new Error('probe descendants were not materialized');
}

function parentMap(pids) {
  const parents = new Map();
  const pending = [...pids];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!pid || parents.has(pid) || !existsSync(`/proc/${pid}/stat`)) continue;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    parents.set(pid, ppid);
    if (ppid > 1) pending.push(ppid);
  }
  return parents;
}

function memberships(pids) {
  return new Map(pids.map((pid) => [pid, readFileSync(`/proc/${pid}/cgroup`, 'utf8')]));
}

function cgroupPids(controlGroup) {
  const path = join('/sys/fs/cgroup', controlGroup, 'cgroup.procs');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
}

function assertStopped(pids, controlGroup) {
  const alive = new Set(pids.filter((pid) => existsSync(`/proc/${pid}`)));
  assertNoCgroupSurvivors(pids, alive, cgroupPids(controlGroup));
}

function daemonLogAfter(offset) {
  let log = '';
  for (let i = 0; i < 100; i++) {
    if (existsSync(daemonLog)) {
      const bytes = readFileSync(daemonLog);
      log = bytes.subarray(bytes.length >= offset ? offset : 0).toString('utf8');
    }
    if (log.includes('Daemon shutdown phase container started')) return log;
    run('sleep', ['0.05']);
  }
  return log;
}

try {
  writeProbe(false);
  for (let cycle = 1; cycle <= cycles; cycle++) {
    systemctl('restart', service);
    const authority = snapshot();
    assertSystemdShutdownAuthority(authority);
    const pids = probePids(authority.mainPid);
    assertDaemonDescendants(authority.mainPid, pids, parentMap(pids));
    assertPidsInControlGroup(authority.controlGroup, [authority.mainPid, ...pids], memberships([authority.mainPid, ...pids]));
    const logOffset = existsSync(daemonLog) ? statSync(daemonLog).size : 0;
    systemctl('stop', service);
    assertStopped([authority.mainPid, ...pids], authority.controlGroup);
    assertOrderedShutdownLog(daemonLogAfter(logOffset));
    results.normalCycles.push({ cycle, controlGroup: authority.controlGroup, mainPid: authority.mainPid, descendantPids: pids });
  }

  writeProbe(true);
  systemctl('restart', service);
  const authority = snapshot();
  assertSystemdShutdownAuthority(authority);
  const pids = probePids(authority.mainPid);
  assertDaemonDescendants(authority.mainPid, pids, parentMap(pids));
  assertPidsInControlGroup(authority.controlGroup, [authority.mainPid, ...pids], memberships([authority.mainPid, ...pids]));
  const started = Date.now();
  systemctl('stop', service);
  const elapsedMs = Date.now() - started;
  assertStopped([authority.mainPid, ...pids], authority.controlGroup);
  if (elapsedMs < 1_500 || elapsedMs > 10_000) throw new Error(`bounded cgroup SIGKILL fallback elapsed ${elapsedMs}ms`);
  results.timeoutFallback = { elapsedMs, controlGroup: authority.controlGroup, mainPid: authority.mainPid, descendantPids: pids };
} finally {
  rmSync(dropIn, { force: true });
  systemctl('daemon-reload');
  if (initialActive) systemctl('start', service);
  else systemctl('stop', service);
  results.restoredInitialState = isActive() === initialActive;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({ status: 'PASS', evidencePath, cycles, nodeId }));
