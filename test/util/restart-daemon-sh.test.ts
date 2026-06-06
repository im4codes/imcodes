import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
