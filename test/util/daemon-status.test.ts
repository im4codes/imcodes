import { describe, expect, it, vi } from 'vitest';
import {
  formatDurationSeconds,
  parsePsElapsedSeconds,
  readProcessUptimeSeconds,
  readServiceRestartCount,
} from '../../src/util/daemon-status.js';

describe('daemon status helpers', () => {
  it('parses ps elapsed seconds and elapsed time formats', () => {
    expect(parsePsElapsedSeconds('123')).toBe(123);
    expect(parsePsElapsedSeconds('01:02')).toBe(62);
    expect(parsePsElapsedSeconds('03:04:05')).toBe(11_045);
    expect(parsePsElapsedSeconds('2-03:04:05')).toBe(183_845);
  });

  it('rejects invalid ps elapsed values', () => {
    expect(parsePsElapsedSeconds('')).toBeNull();
    expect(parsePsElapsedSeconds('1-2-3')).toBeNull();
    expect(parsePsElapsedSeconds('00:00:99')).toBeNull();
    expect(parsePsElapsedSeconds('not-time')).toBeNull();
  });

  it('formats uptime compactly', () => {
    expect(formatDurationSeconds(9)).toBe('9s');
    expect(formatDurationSeconds(65)).toBe('1m 5s');
    expect(formatDurationSeconds(3_660)).toBe('1h 1m');
    expect(formatDurationSeconds(90_061)).toBe('1d 1h 1m');
  });

  it('reads process uptime from ps etimes', () => {
    const runner = vi.fn(() => '456\n');

    expect(readProcessUptimeSeconds(123, runner)).toBe(456);
    expect(runner).toHaveBeenCalledWith(
      'ps',
      ['-p', '123', '-o', 'etimes='],
      expect.any(Object),
    );
  });

  it('falls back to ps etime when etimes is unavailable', () => {
    const runner = vi.fn((file: string, args: string[]) => {
      if (args.includes('etimes=')) throw new Error('unsupported');
      return '01:02:03\n';
    });

    expect(readProcessUptimeSeconds(123, runner)).toBe(3_723);
  });

  it('reads systemd restart count on linux when available', () => {
    const runner = vi.fn(() => '7\n');

    expect(readServiceRestartCount('linux', runner)).toBe(7);
    expect(runner).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'show', 'imcodes', '--property=NRestarts', '--value'],
      expect.any(Object),
    );
  });

  it('omits restart count on non-systemd platforms or command failure', () => {
    expect(readServiceRestartCount('darwin', vi.fn())).toBeNull();
    expect(readServiceRestartCount('linux', vi.fn(() => { throw new Error('missing'); }))).toBeNull();
  });
});
