#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname, loadavg } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const DEFAULT_PID_FILE = join(homedir(), '.imcodes', 'daemon.pid');
const DEFAULT_LOG_DIR = join(homedir(), '.imcodes', 'logs');

function usage() {
  console.log(`Usage: node scripts/trace-daemon-latency.mjs [options]

Options:
  --pid <pid>            Trace this PID instead of ~/.imcodes/daemon.pid
  --pid-file <path>      PID file path (default: ${DEFAULT_PID_FILE})
  --interval <ms>        Sample interval (default: 1000)
  --duration <sec>       Stop after N seconds (default: run until Ctrl+C)
  --out <path>           NDJSON output path
  --strace               Also attach strace to the daemon (more intrusive)
  --help                 Show this help

Output is NDJSON. It records process CPU, memory, context switches, fd count,
thread-level CPU deltas, and optional strace metadata.`);
}

function parseArgs(argv) {
  const args = {
    pidFile: DEFAULT_PID_FILE,
    intervalMs: 1000,
    durationSec: 0,
    strace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--pid') {
      args.pid = Number(argv[++i]);
    } else if (arg === '--pid-file') {
      args.pidFile = argv[++i];
    } else if (arg === '--interval') {
      args.intervalMs = Math.max(100, Number(argv[++i]));
    } else if (arg === '--duration') {
      args.durationSec = Math.max(0, Number(argv[++i]));
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--strace') {
      args.strace = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function readPid(args) {
  if (Number.isInteger(args.pid) && args.pid > 0) return args.pid;
  const raw = readFileSync(args.pidFile, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid in ${args.pidFile}: ${raw}`);
  return pid;
}

function getconf(name, fallback) {
  try {
    const raw = execFileSync('getconf', [name], { encoding: 'utf8' }).trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

const CLK_TCK = getconf('CLK_TCK', 100);
const PAGE_SIZE = getconf('PAGESIZE', 4096);

function parseProcStat(raw) {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error('invalid proc stat');
  const pid = Number(raw.slice(0, open).trim());
  const comm = raw.slice(open + 1, close);
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  return {
    pid,
    comm,
    state: fields[0],
    ppid: Number(fields[1]),
    utimeTicks: Number(fields[11]),
    stimeTicks: Number(fields[12]),
    numThreads: Number(fields[17]),
    starttimeTicks: Number(fields[19]),
    vsize: Number(fields[20]),
    rssPages: Number(fields[21]),
  };
}

function readStatus(pid) {
  const status = {};
  const raw = readFileSync(`/proc/${pid}/status`, 'utf8');
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    status[key] = value;
  }
  return status;
}

function readIo(pid) {
  try {
    const io = {};
    const raw = readFileSync(`/proc/${pid}/io`, 'utf8');
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      io[line.slice(0, idx)] = Number(line.slice(idx + 1).trim());
    }
    return io;
  } catch {
    return {};
  }
}

function countFds(pid) {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return undefined;
  }
}

function readThreads(pid) {
  const out = [];
  let tids;
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8'));
      out.push({
        tid: Number(tid),
        name: stat.comm,
        state: stat.state,
        cpuTicks: stat.utimeTicks + stat.stimeTicks,
      });
    } catch {
      // thread exited between readdir and read
    }
  }
  return out;
}

function numberFromStatus(value) {
  if (!value) return undefined;
  const match = String(value).match(/-?\d+/);
  return match ? Number(match[0]) : undefined;
}

function makeSample(pid, previous, elapsedMs) {
  const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  const status = readStatus(pid);
  const io = readIo(pid);
  const threads = readThreads(pid);
  const cpuTicks = stat.utimeTicks + stat.stimeTicks;
  const prevCpuTicks = previous?.cpuTicks ?? cpuTicks;
  const cpuPctOneCore = elapsedMs > 0 ? ((cpuTicks - prevCpuTicks) / CLK_TCK) / (elapsedMs / 1000) * 100 : 0;
  const prevThreads = previous?.threadsByTid ?? new Map();
  const topThreads = threads
    .map((thread) => {
      const prevTicks = prevThreads.get(thread.tid)?.cpuTicks ?? thread.cpuTicks;
      const cpuPct = elapsedMs > 0 ? ((thread.cpuTicks - prevTicks) / CLK_TCK) / (elapsedMs / 1000) * 100 : 0;
      return { ...thread, cpuPctOneCore: Number(cpuPct.toFixed(1)) };
    })
    .sort((a, b) => b.cpuPctOneCore - a.cpuPctOneCore)
    .slice(0, 8);
  const [load1, load5, load15] = loadavg();
  return {
    state: {
      cpuTicks,
      threadsByTid: new Map(threads.map((thread) => [thread.tid, thread])),
    },
    record: {
      event: 'proc_sample',
      pid,
      comm: stat.comm,
      state: stat.state,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      cpuPctOneCore: Number(cpuPctOneCore.toFixed(1)),
      rssMB: Number((stat.rssPages * PAGE_SIZE / 1024 / 1024).toFixed(1)),
      vsizeMB: Number((stat.vsize / 1024 / 1024).toFixed(1)),
      numThreads: stat.numThreads,
      fdCount: countFds(pid),
      voluntaryCtxtSwitches: numberFromStatus(status.voluntary_ctxt_switches),
      nonvoluntaryCtxtSwitches: numberFromStatus(status.nonvoluntary_ctxt_switches),
      vmRSS: status.VmRSS,
      vmHWM: status.VmHWM,
      readBytes: io.read_bytes,
      writeBytes: io.write_bytes,
      cancelledWriteBytes: io.cancelled_write_bytes,
      load1: Number(load1.toFixed(2)),
      load5: Number(load5.toFixed(2)),
      load15: Number(load15.toFixed(2)),
      topThreads,
    },
  };
}

function write(stream, record) {
  stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

function startStrace(pid, outPath, stream) {
  const stracePath = outPath.replace(/\.ndjson$/, '') + '.strace.log';
  const args = ['-f', '-tt', '-T', '-p', String(pid), '-o', stracePath, '-e', 'trace=%file,%network,%process,%signal'];
  const child = spawn('strace', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => {
    write(stream, { event: 'strace_stderr', message: String(chunk).trim() });
  });
  child.on('exit', (code, signal) => {
    write(stream, { event: 'strace_exit', code, signal, stracePath });
  });
  write(stream, { event: 'strace_start', pid, stracePath, args: ['strace', ...args] });
  return child;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pid = readPid(args);
  const procDir = `/proc/${pid}`;
  if (!existsSync(procDir)) throw new Error(`process ${pid} is not alive`);
  const outPath = args.out || join(DEFAULT_LOG_DIR, `daemon-proc-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
  mkdirSync(dirname(outPath), { recursive: true });
  const stream = createWriteStream(outPath, { flags: 'a' });
  let straceChild = null;
  if (args.strace) straceChild = startStrace(pid, outPath, stream);

  write(stream, {
    event: 'trace_start',
    host: hostname(),
    pid,
    pidFile: args.pidFile,
    outPath,
    intervalMs: args.intervalMs,
    durationSec: args.durationSec || null,
    strace: Boolean(args.strace),
    clkTck: CLK_TCK,
    pageSize: PAGE_SIZE,
    procCmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(),
  });

  let previous = null;
  let lastAt = Date.now();
  const deadline = args.durationSec > 0 ? Date.now() + args.durationSec * 1000 : 0;
  const timer = setInterval(() => {
    try {
      if (!existsSync(procDir)) {
        write(stream, { event: 'process_exit_observed', pid });
        clearInterval(timer);
        straceChild?.kill('SIGINT');
        stream.end();
        return;
      }
      const now = Date.now();
      const elapsedMs = now - lastAt;
      const sample = makeSample(pid, previous, elapsedMs);
      previous = sample.state;
      lastAt = now;
      write(stream, sample.record);
      if (deadline && now >= deadline) {
        write(stream, { event: 'trace_stop', reason: 'duration' });
        clearInterval(timer);
        straceChild?.kill('SIGINT');
        stream.end();
      }
    } catch (error) {
      write(stream, { event: 'sample_error', message: error instanceof Error ? error.message : String(error) });
    }
  }, args.intervalMs);

  const stop = () => {
    write(stream, { event: 'trace_stop', reason: 'signal' });
    clearInterval(timer);
    straceChild?.kill('SIGINT');
    stream.end();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`Tracing daemon PID ${pid} -> ${outPath}`);
  if (args.strace) console.log(`strace enabled -> ${outPath.replace(/\.ndjson$/, '')}.strace.log`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

