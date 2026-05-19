import { describe, expect, it, vi } from 'vitest';
import {
  enableSystemdUserLinger,
  formatSystemdLingerFailureMessage,
  formatSystemdLingerManualCommand,
  resolveSystemdLingerUser,
} from '../../src/util/systemd-linger.js';

describe('systemd linger helper', () => {
  it('enables linger with an explicit current user', () => {
    const execFileSync = vi.fn();

    const result = enableSystemdUserLinger({
      currentUsername: 'ai',
      execFileSync,
    });

    expect(result).toMatchObject({ ok: true, user: 'ai', method: 'loginctl' });
    expect(execFileSync).toHaveBeenCalledWith('loginctl', ['enable-linger', 'ai'], { stdio: 'ignore' });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to passwordless sudo when direct loginctl cannot enable linger', () => {
    const execFileSync = vi.fn((file: string) => {
      if (file === 'loginctl') throw new Error('polkit denied');
      return Buffer.from('');
    });

    const result = enableSystemdUserLinger({
      currentUsername: 'ai',
      execFileSync,
    });

    expect(result).toMatchObject({ ok: true, user: 'ai', method: 'sudo-loginctl' });
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'loginctl', ['enable-linger', 'ai'], { stdio: 'ignore' });
    expect(execFileSync).toHaveBeenNthCalledWith(2, 'sudo', ['-n', 'loginctl', 'enable-linger', 'ai'], { stdio: 'ignore' });
  });

  it('targets the sudo caller when the process is running as root', () => {
    expect(resolveSystemdLingerUser({
      currentUsername: 'root',
      env: { SUDO_USER: 'ai' },
    })).toBe('ai');
  });

  it('prints a safe manual command when automatic enablement fails', () => {
    expect(formatSystemdLingerManualCommand('ai')).toBe('sudo loginctl enable-linger ai');
    expect(formatSystemdLingerManualCommand('space user')).toBe("sudo loginctl enable-linger 'space user'");
  });

  it('returns a manual sudo command when direct loginctl and sudo fallback both fail', () => {
    const execFileSync = vi.fn(() => {
      throw new Error('not authorized');
    });

    const result = enableSystemdUserLinger({
      currentUsername: 'ai',
      execFileSync,
    });

    expect(result).toMatchObject({ ok: false, user: 'ai', method: null });
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'loginctl', ['enable-linger', 'ai'], { stdio: 'ignore' });
    expect(execFileSync).toHaveBeenNthCalledWith(2, 'sudo', ['-n', 'loginctl', 'enable-linger', 'ai'], { stdio: 'ignore' });
    expect(formatSystemdLingerFailureMessage(result.user)).toContain('passwordless sudo');
    expect(formatSystemdLingerFailureMessage(result.user)).toContain('sudo loginctl enable-linger ai');
  });
});
