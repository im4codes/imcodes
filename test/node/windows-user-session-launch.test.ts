import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  launchWindowsActiveUserCommand,
  launchWindowsActiveUserElevatedCommand,
  summariseLauncherFailure,
} from '../../src/node/windows-user-session.js';

/** A spawn stand-in that records how it was called and can fail on cue. */
function fakeSpawn() {
  const calls: { options: { stdio?: unknown } }[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable; stderr: PassThrough; unref(): void;
  };
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.stderr = new PassThrough();
  child.unref = () => {};
  const spawn = vi.fn((_file: string, _args: readonly string[], options: { stdio?: unknown }) => {
    calls.push({ options });
    return child as never;
  });
  return { spawn: spawn as never, child, calls };
}

/** The script the launcher actually sent, decoded out of its stdin payload. */
function launchedScript(
  launch: (exe: string, args: string, spawn: never) => void,
): string {
  let written = '';
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; unref(): void };
  child.stdin = new Writable({ write(chunk, _e, cb) { written += String(chunk); cb(); } });
  child.unref = () => {};
  const spawn = vi.fn(() => child as never) as never;
  launch('C:\\x.exe', '--a', spawn);
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(written);
  if (!encoded) throw new Error('launcher payload was not a base64 script');
  return Buffer.from(encoded[1]!, 'base64').toString('utf8');
}

describe('launching into the active user session', () => {
  it('reports why the launcher refused, instead of leaving a silent timeout', async () => {
    // The failure that hid this for good: stderr was discarded and both error
    // handlers were empty, so CreateProcessAsUser answering
    // ERROR_ELEVATION_REQUIRED produced no trace at all. The only symptom was a
    // connect timeout fifteen seconds later, which names nothing.
    const { spawn, child, calls } = fakeSpawn();
    const failures: string[] = [];
    launchWindowsActiveUserCommand('C:\\x.exe', '--a', spawn, false, false, false, (d) => failures.push(d));

    expect((calls[0]!.options.stdio as unknown[])[2], 'stderr must be captured to be reported').toBe('pipe');
    child.stderr.write('At line:237 char:1\nException calling "Start": "The requested operation requires elevation"\n');
    child.emit('exit', 1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('requires elevation');
  });

  it('stays silent and keeps its old stdio when nobody asked to hear', async () => {
    // Every other caller is fire-and-forget. Capturing stderr for them would
    // hold a pipe open on a detached child nobody reads.
    const { spawn, child, calls } = fakeSpawn();
    launchWindowsActiveUserCommand('C:\\x.exe', '--a', spawn);
    expect((calls[0]!.options.stdio as unknown[])[2]).toBe('ignore');
    expect(() => child.emit('error', new Error('boom'))).not.toThrow();
  });

  it('says something even when the launcher fails without writing a word', async () => {
    const { spawn, child } = fakeSpawn();
    const failures: string[] = [];
    launchWindowsActiveUserCommand('C:\\x.exe', '--a', spawn, false, false, false, (d) => failures.push(d));
    child.emit('exit', 9);
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures[0]).toContain('9');
  });

  it('does not report a launcher that succeeded', async () => {
    const { spawn, child } = fakeSpawn();
    const failures: string[] = [];
    launchWindowsActiveUserCommand('C:\\x.exe', '--a', spawn, false, false, false, (d) => failures.push(d));
    child.emit('exit', 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toEqual([]);
  });

  it('asks for the linked elevated token in the elevated variant', () => {
    // The daemon binary is manifested requireAdministrator so its installer can
    // prompt for UAC. Launched into the interactive user's filtered token it
    // cannot start at all, which is why the OCU helper never connected while
    // the remote-desktop worker -- which always used this variant -- did.
    //
    // The launcher travels base64-encoded through stdin, so the assertion has
    // to decode it. Asserting only that spawn was called would pass whichever
    // token was requested, which is the entire question here.
    expect(launchedScript(launchWindowsActiveUserElevatedCommand))
      .toContain('::Start($exe, $argsLine, $true,');
    expect(launchedScript((exe, args, spawn) => launchWindowsActiveUserCommand(exe, args, spawn)))
      .toContain('::Start($exe, $argsLine, $false,');
  });
});

describe('summariseLauncherFailure', () => {
  it('picks the line that names the cause out of PowerShell s dump', () => {
    const stderr = [
      'powershell.exe : At C:\\probe.ps1:237 char:1',
      '+ [ImcodesUserProc]::Start($exe, $argsLine, $false, $false, $false)',
      '+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      'Exception calling "Start" with "5" argument(s): "The requested operation requires elevation"',
      '    + FullyQualifiedErrorId : Win32Exception',
    ].join('\n');
    // Not the first line: PowerShell leads with a positional dump, and taking
    // that would bury the sentence someone actually needs.
    expect(summariseLauncherFailure(stderr)).toContain('requires elevation');
  });

  it('is bounded, and empty for empty input', () => {
    expect(summariseLauncherFailure('')).toBe('');
    expect(summariseLauncherFailure('x'.repeat(5000)).length).toBeLessThanOrEqual(300);
  });
});
