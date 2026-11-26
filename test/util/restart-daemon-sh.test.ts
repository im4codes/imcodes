import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execAsync = promisify(execFile);

const SH_PATH = join(__dirname, '..', '..', 'scripts', 'restart-daemon.sh');

function readScript(): string {
  return readFileSync(SH_PATH, 'utf8');
}

function macosBranch(text: string): string {
  const start = text.indexOf('elif [[ "$(uname -s)" == "Darwin" ]]; then');
  const end = text.indexOf('elif command -v setsid', start);
  expect(start, 'macOS restart branch must exist').toBeGreaterThanOrEqual(0);
  expect(end, 'macOS branch must end before generic setsid fallback').toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('scripts/restart-daemon.sh', () => {
  const text = readScript();

  it('builds, links, verifies the linked manifest, then dispatches restart', () => {
    const installIdx = text.indexOf('npm install');
    const buildIdx = text.indexOf('npm run build');
    const linkIdx = text.indexOf('npm link --force');
    const verifyIdx = text.indexOf('Build manifest verified');
    const dispatchIdx = text.indexOf('Detaching restart; logs:');

    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(installIdx);
    expect(linkIdx).toBeGreaterThan(buildIdx);
    expect(verifyIdx).toBeGreaterThan(linkIdx);
    expect(dispatchIdx).toBeGreaterThan(verifyIdx);
  });

  it('keeps Linux on systemd restart and leaves the macOS fallback out of that branch', () => {
    const linuxStart = text.indexOf('if [[ "$(uname -s)" == "Linux" ]]; then');
    const macStart = text.indexOf('elif [[ "$(uname -s)" == "Darwin" ]]; then');
    expect(linuxStart).toBeGreaterThanOrEqual(0);
    expect(macStart).toBeGreaterThan(linuxStart);
    const linux = text.slice(linuxStart, macStart);
    expect(linux).toContain('systemctl --user daemon-reload && systemctl --user restart imcodes');
    expect(linux).not.toContain('launchctl');
  });

  it('macOS restart drives launchd directly instead of nesting `imcodes service restart`', () => {
    const mac = macosBranch(text);
    expect(mac).toContain('launchctl bootout');
    expect(mac).toContain('launchctl bootstrap');
    expect(mac).toContain('launchctl kickstart -k "$label"');
    expect(mac).not.toContain('imcodes service restart --no-build');
    expect(mac).not.toContain('imcodes restart');
  });

  it('macOS restart captures the old daemon PID and has TERM/KILL fallback', () => {
    const mac = macosBranch(text);
    expect(mac).toContain('pid_file="$HOME/.imcodes/daemon.pid"');
    expect(mac).toContain('old_pid="$(tr -dc "0-9" <"$pid_file"');
    expect(mac).toContain('launchctl list');
    expect(mac).toContain('if ! [[ "$old_pid" =~ ^[0-9]+$ ]]; then');
    expect(mac).toContain('old_pid=""');
    expect(mac).toContain('kill -TERM "$old_pid"');
    expect(mac).toContain('kill -KILL "$old_pid"');
  });

  it('detaches restart output to the documented log file', () => {
    expect(text).toContain('LOG="${TMPDIR:-/tmp}/imcodes-restart-daemon.log"');
    expect(text).toContain('>>"$LOG" 2>&1 &');
    expect(text).toContain('Restart dispatched');
  });
});

// Execute the whole helper against a closed PATH, never the developer's npm,
// node, systemctl or user unit. The fake manager queues work for the test parent
// (outside the simulated runner), just as systemd owns a transient service.
describe.skipIf(process.platform !== 'linux')('isolated Linux restart dispatch', () => {
  const fixtures: string[] = [];
  const blockedChildren = new Set<number>();

  afterEach(() => {
    for (const pid of blockedChildren) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    blockedChildren.clear();
    for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(options: { manager?: 'ok' | 'fail' | 'absent'; setsid?: boolean; reap?: boolean; failure?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-restart-test-'));
    fixtures.push(dir);
    const root = join(dir, 'checkout with spaces');
    const bin = join(dir, 'bin');
    const home = join(dir, 'home');
    const temp = join(dir, 'tmp with spaces');
    for (const path of [join(root, 'scripts'), bin, home, temp]) mkdirSync(path, { recursive: true });
    const script = join(root, 'scripts/restart-daemon.sh');
    writeFileSync(script, readScript());
    const calls = join(dir, 'calls');
    const queue = join(dir, 'queued.json');
    const pidFile = join(dir, 'child.pid');
    const log = join(temp, 'imcodes-restart-daemon.log');
    const writeBin = (name: string, body: string) => writeFileSync(join(bin, name), body, { mode: 0o755 });
    // Only harmless utilities used by the helper; no inherited PATH tail.
    for (const name of ['bash', 'dirname', 'date', 'tee', 'cat']) symlinkSync(`/bin/${name}`, join(bin, name));
    writeBin('uname', '#!/bin/bash\necho Linux\n');
    writeBin('npm', '#!/bin/bash\nprintf "npm %s\\n" "$*" >>"$CALLS"\n');
    writeBin('node', '#!/bin/bash\ncat >/dev/null\necho manifest-stub >>"$CALLS"\n');
    writeBin('systemctl', '#!/bin/bash\nprintf "systemctl %s\\n" "$*" >>"$CALLS"\n[[ "$*" != "$FAILURE" ]] || exit 7\n');
    const manager = options.manager ?? 'ok';
    if (manager !== 'absent') writeBin('systemd-run', `#!${process.execPath}\n` + `
      const fs = require('fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.CALLS, 'systemd-run ' + JSON.stringify(args) + '\\n');
      if (${JSON.stringify(manager)} === 'fail') process.exit(1);
      fs.writeFileSync(process.env.QUEUE, JSON.stringify(args.slice(args.indexOf('-c') - 1)));
    `);
    if (options.setsid !== false) {
      writeBin('setsid', options.reap ? `#!${process.execPath}\n` + `
        require('fs').writeFileSync(process.env.PID_FILE, String(process.pid));
        setInterval(() => {}, 1000); // runner kills this before it can execute
      ` : '#!/bin/bash\necho setsid >>"$CALLS"\nexec "$@"\n');
    }
    writeBin('nohup', '#!/bin/bash\necho nohup >>"$CALLS"\nexec "$@"\n');
    const env = {
      HOME: home, TMPDIR: temp, PATH: bin, CALLS: calls, QUEUE: queue,
      PID_FILE: pidFile, FAILURE: options.failure ?? '',
    };
    return { root, home, script, calls, queue, pidFile, log, env };
  }

  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
  const run = (f: ReturnType<typeof fixture>, args: string[] = []) => execAsync('/bin/bash', [f.script, ...args], { env: f.env, timeout: 5000 });
  async function runManagerJob(f: ReturnType<typeof fixture>) {
    const [command, ...args] = JSON.parse(read(f.queue)) as string[];
    return execAsync(command, args, { env: f.env, timeout: 5000 });
  }

  it.each([[], ['restart']])('dispatches a collected user service, preserving positional compatibility (%j)', async (...args) => {
    const f = fixture();
    const { stdout } = await run(f, args as string[]);
    expect(stdout).toContain('Restart dispatched via user systemd unit');
    const calls = read(f.calls);
    expect(calls).toMatch(/npm install\nnpm run build\nnpm link --force\nmanifest-stub\nsystemd-run /);
    const managerArgs = JSON.parse(calls.split('systemd-run ')[1].trim()) as string[];
    expect(managerArgs).toEqual(expect.arrayContaining(['--user', '--collect', '--quiet', '--property=Type=exec', `--setenv=PATH=${f.env.PATH}`]));
    expect(managerArgs.some(arg => /^--unit=imcodes-restart-\d+-\d+$/.test(arg))).toBe(true);
    expect(managerArgs).not.toContain('--scope');
    expect(managerArgs).not.toContain('--wait');
    expect(calls).not.toMatch(/\n(setsid|nohup|systemctl)/);
    await runManagerJob(f); // executes AFTER the calling shell has exited
    expect(read(f.calls)).toContain('systemctl --user daemon-reload\nsystemctl --user restart imcodes\n');
    expect(read(f.log)).toMatch(/started at .*\n=== Linux daemon restart finished at .*\(status=0\)/);
    expect(existsSync(join(f.home, '.config/systemd/user/imcodes.service'))).toBe(false);
    expect(existsSync(join(f.root, 'node_modules'))).toBe(false);
  });

  it.each([
    { manager: 'fail' as const, setsid: true, launcher: 'setsid' },
    { manager: 'absent' as const, setsid: true, launcher: 'setsid' },
    { manager: 'absent' as const, setsid: false, launcher: 'nohup' },
  ])('falls back when the manager is $manager (via $launcher)', async options => {
    const f = fixture(options);
    const result = await run(f);
    expect(result.stderr).toContain('best-effort');
    await vi.waitFor(() => expect(read(f.log)).toContain('(status=0)'));
    expect(read(f.calls)).toContain(`${options.launcher}\nsystemctl --user daemon-reload\nsystemctl --user restart imcodes\n`);
    expect(read(f.log)).toContain('cannot escape service cgroup teardown');
  });

  it.each(['--user daemon-reload', '--user restart imcodes'])('logs detached failure status from %s without retrying', async failure => {
    const f = fixture({ failure });
    await run(f);
    await expect(runManagerJob(f)).rejects.toMatchObject({ code: 7 });
    expect(read(f.log)).toContain('(status=7)');
    if (failure.endsWith('daemon-reload')) expect(read(f.calls)).not.toMatch(/^systemctl --user restart imcodes$/m);
    expect(read(f.calls)).not.toContain('\nsetsid\n');
  });

  it('reproduces runner reaping of setsid and proves manager-owned work survives shell exit', async () => {
    const legacy = fixture({ manager: 'absent', reap: true });
    await run(legacy);
    await vi.waitFor(() => expect(read(legacy.pidFile)).toMatch(/^\d+$/));
    const pid = Number(read(legacy.pidFile));
    blockedChildren.add(pid);
    process.kill(pid, 'SIGKILL'); // simulated tool-runner descendant cleanup
    blockedChildren.delete(pid);
    expect(read(legacy.calls)).not.toContain('systemctl');
    expect(read(legacy.log)).not.toContain('restart started');

    const fixed = fixture({ reap: true });
    await run(fixed);
    expect(read(fixed.pidFile)).toBe(''); // no runner-owned background child
    await runManagerJob(fixed);
    expect(read(fixed.log)).toContain('(status=0)');
    expect(read(fixed.calls)).toContain('systemctl --user restart imcodes');
  });
});
