import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemdWatchdogTransport, type SystemdWatchdogTransport } from '../../src/node/systemd-watchdog.js';

const transports: SystemdWatchdogTransport[] = [];
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  vi.useRealTimers();
});

function helper() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  return child;
}

function transport(spawnHelper: NonNullable<Parameters<typeof createSystemdWatchdogTransport>[0]>['spawnHelper']) {
  const value = createSystemdWatchdogTransport({ socket: '/run/systemd/notify', python: '/usr/bin/python', spawnHelper, timeoutMs: 200 });
  transports.push(value);
  return value;
}

describe('unit-owned non-spoofing watchdog sender', () => {
  it('has no autonomous pulse; coalesces to one pending pulse and retains the sender for attribution', async () => {
    vi.useFakeTimers();
    const child = helper();
    const spawn = vi.fn(() => child);
    const value = transport(spawn);
    expect(spawn).not.toHaveBeenCalled();
    const sent: string[] = [];
    child.stdin.on('data', (chunk) => sent.push(String(chunk)));
    const first = value.pulse();
    expect(value.pulse()).toBe(first);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0]).toBe('/usr/bin/python');
    expect(spawn.mock.calls[0][1].slice(0, 3)).toEqual(['-E', '-S', '-u']);
    expect(sent).toEqual([]);
    child.stdout.write('REA');
    child.stdout.write('DY\n');
    expect(sent).toEqual(['WATCHDOG\n']);
    child.stdout.write('SENT\n');
    await first;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sent).toEqual(['WATCHDOG\n']);
    expect(child.kill).not.toHaveBeenCalled();
    const second = value.pulse();
    child.stdout.write('SENT\n');
    await second;
    expect(sent).toHaveLength(2);
    expect(spawn).toHaveBeenCalledOnce();
    value.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('bounds a hung helper and restarts only on the next caller-driven pulse', async () => {
    vi.useFakeTimers();
    const firstChild = helper();
    const secondChild = helper();
    const spawn = vi.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const value = transport(spawn);
    const first = value.pulse();
    const rejected = expect(first).rejects.toThrow('pulse_timeout');
    await vi.advanceTimersByTimeAsync(201);
    await rejected;
    expect(firstChild.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawn).toHaveBeenCalledOnce();
    const second = value.pulse();
    // Late events from a killed generation cannot acknowledge the new pulse.
    firstChild.stdout.write('READY\nSENT\n');
    secondChild.stdout.write('READY\nSENT\n');
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('handles death, spawn errors and invalid bounded responses without a queued feed', async () => {
    const children = [helper(), helper(), helper()];
    const value = transport(vi.fn().mockImplementation(() => children.shift()));
    const firstChild = children[0];
    const first = value.pulse();
    firstChild.emit('error', new Error('spawn denied'));
    await expect(first).rejects.toThrow('spawn denied');
    const secondChild = children[0];
    const second = value.pulse();
    secondChild.stdout.write('x'.repeat(129));
    await expect(second).rejects.toThrow('invalid_systemd_watchdog_response');
    const thirdChild = children[0];
    const third = value.pulse();
    thirdChild.emit('exit', 1);
    await expect(third).rejects.toThrow('helper_exited');
  });

  it('rejects non-system interpreters and malformed socket addresses before starting any process', async () => {
    const spawn = vi.fn();
    for (const socket of ['', 'relative', '/run/bad\0socket']) {
      const value = createSystemdWatchdogTransport({ socket, python: '/usr/bin/python', spawnHelper: spawn });
      await expect(value.pulse()).rejects.toThrow('invalid_systemd_notify_socket');
    }
    const value = createSystemdWatchdogTransport({ socket: '@socket', python: 'python', spawnHelper: spawn });
    await expect(value.pulse()).rejects.toThrow('requires_system_python');
    expect(spawn).not.toHaveBeenCalled();
  });
});
