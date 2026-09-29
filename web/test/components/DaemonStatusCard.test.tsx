/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { DaemonStatusCard, DaemonUpgradeConfirmDialog } from '../../src/components/DaemonStatusCard.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.count ? `${key}:${values.count}` : key }),
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
