/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { DaemonStatusCard, DaemonUpgradeConfirmDialog } from '../../src/components/DaemonStatusCard.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (
      values?.count ? `${key}:${values.count}`
        : values?.reason ? `${key}:${values.reason}`
          : values?.names ? `${key}:${values.names}` : key
    ),
  }),
}));

afterEach(cleanup);

const baseProps = {
  currentVersion: '2026.4.904-dev.100',
  latestVersion: '2026.4.905-dev.877',
  online: true,
  busySessions: 0,
  upgrading: false,
  requestState: { phase: 'idle' as const },
  onUpgrade: vi.fn(),
};

describe('DaemonStatusCard', () => {
  it('hides the upgrade icon when versions are equal and shows current/latest on demand', () => {
    const { rerender } = render(<DaemonStatusCard {...baseProps} currentVersion="2026.4.905-dev.877" latestVersion="2026.4.905-dev.877" />);
    expect(document.querySelector('.daemon-upgrade-icon')).toBeNull();

    rerender(<DaemonStatusCard {...baseProps} />);
    const icon = screen.getByRole('button', { name: 'server.daemon_upgrade_available' });
    fireEvent.click(icon);
    expect(screen.getByText('server.daemon_current_version')).toBeTruthy();
    expect(screen.getByText('server.daemon_latest_version')).toBeTruthy();
    expect(screen.getByText('v2026.4.904-dev.100')).toBeTruthy();
    expect(screen.getByText('v2026.4.905-dev.877')).toBeTruthy();
  });

  it('keeps the button accessible and invokes the caller upgrade flow exactly once', () => {
    const onUpgrade = vi.fn();
    render(<DaemonStatusCard {...baseProps} onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByRole('button', { name: 'server.daemon_upgrade_available' }));
    fireEvent.click(screen.getByRole('button', { name: 'server.daemon_upgrade_button' }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('surfaces a dev/stable channel mismatch even when the stable build sorts newer', () => {
    render(<DaemonStatusCard {...baseProps} currentVersion="2026.4.905" latestVersion="2026.4.905-dev.877" />);
    expect(screen.getByRole('button', { name: 'server.daemon_upgrade_available' })).toBeTruthy();
  });

  it('renders the confirmation warning and separates cancel from confirm', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<DaemonUpgradeConfirmDialog busySessions={2} targetCount={3} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const dialogText = screen.getByRole('dialog').textContent ?? '';
    expect(dialogText).toContain('server.daemon_upgrade_confirm_warning');
    expect(dialogText).toContain('server.daemon_upgrade_confirm_busy:2');
    expect(dialogText).toContain('server.daemon_upgrade_confirm_multiple:3');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'server.daemon_upgrade_confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('automatic upgrade line on the card', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'server.daemon_upgrade_available' }));
  const view = (over: Record<string, unknown>) => ({
    status: 'deferred' as const, reason: 'session_busy', targetVersion: '2026.4.905-dev.877', nextRetryAt: null, ...over,
  });

  it('says what the automatic upgrade is waiting for, from the daemon\'s own reason', () => {
    render(<DaemonStatusCard {...baseProps} autoUpgrade={view({ reason: 'p2p_active' })} />);
    open();
    expect(screen.getByText('server.daemon_auto_upgrade_waiting:server.daemon_auto_upgrade_reason_p2p_active')).toBeTruthy();
  });

  it.each([
    ['transport_busy'], ['session_busy'], ['auto_deliver_active'], ['master_compaction_active'], ['cooldown_active'],
  ])('maps the busy gate %s to its own label', (reason) => {
    render(<DaemonStatusCard {...baseProps} autoUpgrade={view({ reason })} />);
    open();
    expect(screen.getByText(`server.daemon_auto_upgrade_waiting:server.daemon_auto_upgrade_reason_${reason}`)).toBeTruthy();
  });

  it('falls back to a generic label for a reason this build does not know', () => {
    render(<DaemonStatusCard {...baseProps} autoUpgrade={view({ reason: 'some_future_reason' })} />);
    open();
    expect(screen.getByText('server.daemon_auto_upgrade_waiting:server.daemon_auto_upgrade_reason_unknown')).toBeTruthy();
  });

  it('shows a failed attempt as retrying, and the daemon opt-out as turned off', () => {
    const { rerender } = render(<DaemonStatusCard {...baseProps} autoUpgrade={view({ status: 'failed', reason: 'install_failed' })} />);
    open();
    expect(screen.getByText('server.daemon_auto_upgrade_retrying:server.daemon_auto_upgrade_reason_install_failed')).toBeTruthy();
    rerender(<DaemonStatusCard {...baseProps} autoUpgrade={view({ reason: 'auto_upgrade_disabled' })} />);
    expect(screen.getByText('server.daemon_auto_upgrade_disabled')).toBeTruthy();
  });

  it('shows nothing when no automatic upgrade is pending, when it is simply under way, or the daemon is current', () => {
    const { rerender } = render(<DaemonStatusCard {...baseProps} autoUpgrade={null} />);
    open();
    expect(document.querySelector('.daemon-auto-upgrade-state')).toBeNull();
    rerender(<DaemonStatusCard {...baseProps} autoUpgrade={view({ status: 'upgrading', reason: null })} />);
    expect(document.querySelector('.daemon-auto-upgrade-state')).toBeNull();
    rerender(<DaemonStatusCard {...baseProps} currentVersion="2026.4.905-dev.877" autoUpgrade={view({})} />);
    expect(document.querySelector('.daemon-auto-upgrade-state')).toBeNull();
  });
});

describe('forced-upgrade confirmation', () => {
  it('lists what the daemon last held the upgrade back for, so the operator knows what will be interrupted', () => {
    render(<DaemonUpgradeConfirmDialog
      busySessions={0}
      blockedReason="auto_deliver_active"
      blockedSessionNames={['deck_a_brain', 'deck_a_w1']}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />);
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain('server.daemon_upgrade_confirm_warning');
    expect(text).toContain('server.daemon_upgrade_confirm_blocked:server.daemon_auto_upgrade_reason_auto_deliver_active');
    expect(text).toContain('server.daemon_upgrade_confirm_blocked_sessions:deck_a_brain, deck_a_w1');
  });

  it('keeps the plain warning when there is no recent block receipt', () => {
    render(<DaemonUpgradeConfirmDialog busySessions={0} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain('server.daemon_upgrade_confirm_warning');
    expect(text).not.toContain('server.daemon_upgrade_confirm_blocked');
  });
});

