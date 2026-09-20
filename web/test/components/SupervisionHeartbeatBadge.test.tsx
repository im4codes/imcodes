/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERVISION_MODE } from '../../../shared/supervision-config.js';
import {
  SUPERVISION_HEARTBEAT_KIND,
  SUPERVISION_HEARTBEAT_STATE,
} from '../../../shared/supervision-heartbeat.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key.endsWith('.sending')) return 'sending…';
      if (key.endsWith('.paused')) return 'paused';
      if (key.endsWith('.needsInput')) return 'needs input';
      if (key.endsWith('.kind.waiting')) return 'supervision';
      if (key.endsWith('.kind.audit')) return 'audit';
      if (key.endsWith('.kind.implementation')) return 'implementation';
      return `${key}:${JSON.stringify(values ?? {})}`;
    },
  }),
}));

import {
  SupervisionHeartbeatBadge,
  formatSupervisionHeartbeatCountdown,
} from '../../src/components/SupervisionHeartbeatBadge.js';

describe('SupervisionHeartbeatBadge', () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('formats a clock-skew-safe local countdown, never goes negative, then pulses while sending', () => {
    render(<SupervisionHeartbeatBadge
      mode={SUPERVISION_MODE.SUPERVISED_AUDIT}
      heartbeat={{
        state: SUPERVISION_HEARTBEAT_STATE.ARMED,
        kind: SUPERVISION_HEARTBEAT_KIND.AUDIT,
        updatedAt: 50_000,
        nextHeartbeatAt: 111_000,
      }}
    />);
    expect(screen.getByRole('timer').textContent).toBe('❤️01:01');
    expect(screen.getByRole('timer').getAttribute('aria-label')).toContain('audit');

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole('timer').textContent).toBe('❤️01:00');
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('status').textContent).toBe('❤️sending…');
    expect(screen.getByRole('status').classList.contains('is-sending')).toBe(true);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('status').textContent).not.toContain('-');
  });

  it('does not tick while hidden and resynchronizes immediately when visible', () => {
    render(<SupervisionHeartbeatBadge
      mode={SUPERVISION_MODE.SUPERVISED}
      heartbeat={{
        state: SUPERVISION_HEARTBEAT_STATE.ARMED,
        kind: SUPERVISION_HEARTBEAT_KIND.WAITING,
        updatedAt: 100,
        nextHeartbeatAt: 10_100,
      }}
    />);
    expect(screen.getByRole('timer').textContent).toContain('00:10');
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('timer').textContent).toContain('00:10');
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByRole('timer').textContent).toContain('00:05');
  });

  it('renders paused and needs-input states but nothing when supervision is off', () => {
    const view = render(<SupervisionHeartbeatBadge mode={SUPERVISION_MODE.SUPERVISED} />);
    expect(screen.getByRole('status').textContent).toBe('⏸️');
    view.rerender(<SupervisionHeartbeatBadge
      mode={SUPERVISION_MODE.SUPERVISED}
      heartbeat={{ state: SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT, updatedAt: 1 }}
    />);
    expect(screen.getByRole('status').textContent).toBe('❗');
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('needs input');
    view.rerender(<SupervisionHeartbeatBadge
      mode={SUPERVISION_MODE.OFF}
      heartbeat={{ state: SUPERVISION_HEARTBEAT_STATE.IDLE, updatedAt: 1 }}
    />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('formats boundary durations deterministically', () => {
    expect(formatSupervisionHeartbeatCountdown(-1)).toBe('00:00');
    expect(formatSupervisionHeartbeatCountdown(1)).toBe('00:01');
    expect(formatSupervisionHeartbeatCountdown(60_001)).toBe('01:01');
  });
});
