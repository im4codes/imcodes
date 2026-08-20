/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { FeatureAnnouncement, FeatureAnnouncementHost } from '../src/components/FeatureAnnouncement.js';
import { FEATURE_ANNOUNCEMENTS_PREF_KEY } from '../src/feature-announcements.js';

const getUserPref = vi.fn();
const saveUserPref = vi.fn();

vi.mock('../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPref(...args),
  saveUserPref: (...args: unknown[]) => saveUserPref(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('FeatureAnnouncement', () => {
  beforeEach(() => {
    localStorage.clear();
    getUserPref.mockReset();
    saveUserPref.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it('renders only while open and acknowledges through the single action', () => {
    const announcement = { id: 'message-pins', version: 1, messageKey: 'featureAnnouncements.messagePins' };
    const onDismiss = vi.fn();
    const { rerender } = render(<FeatureAnnouncement announcement={announcement} open={false} onDismiss={onDismiss} />);
    expect(screen.queryByTestId('feature-announcement')).toBeNull();

    rerender(<FeatureAnnouncement announcement={announcement} open onDismiss={onDismiss} />);
    expect(screen.getByText('featureAnnouncements.messagePins')).toBeTruthy();
    fireEvent.click(screen.getByText('featureAnnouncements.dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not flash before the server preference has hydrated', async () => {
    let resolvePreference!: (value: string) => void;
    getUserPref.mockReturnValue(new Promise<string>((resolve) => { resolvePreference = resolve; }));
    const onPendingChange = vi.fn();

    render(
      <FeatureAnnouncementHost
        userId="user-a"
        sessionsLoaded
        hasActiveSession
        blockedByModal={false}
        onPendingChange={onPendingChange}
      />,
    );
    expect(screen.queryByTestId('feature-announcement')).toBeNull();

    resolvePreference(JSON.stringify({ v: { dismissed: ['message-pins@1'] }, t: 10 }));
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
    expect(getUserPref).toHaveBeenCalledWith(FEATURE_ANNOUNCEMENTS_PREF_KEY);
    expect(screen.queryByTestId('feature-announcement')).toBeNull();
  });

  it('persists Got it immediately and never shows that version again', async () => {
    getUserPref.mockResolvedValue(null);
    const { unmount } = render(<FeatureAnnouncementHost userId="user-a" sessionsLoaded hasActiveSession blockedByModal={false} />);

    await waitFor(() => expect(screen.getByTestId('feature-announcement')).toBeTruthy());
    fireEvent.click(screen.getByText('featureAnnouncements.dismiss'));
    await waitFor(() => expect(screen.queryByTestId('feature-announcement')).toBeNull());
    expect(saveUserPref).toHaveBeenCalledTimes(1);
    expect(saveUserPref.mock.calls[0]?.[0]).toBe(FEATURE_ANNOUNCEMENTS_PREF_KEY);
    expect(JSON.parse(saveUserPref.mock.calls[0]?.[1] as string).v).toEqual({ dismissed: ['message-pins@1'] });

    unmount();
    saveUserPref.mockClear();
    const onPendingChange = vi.fn();
    render(
      <FeatureAnnouncementHost
        userId="user-a"
        sessionsLoaded
        hasActiveSession
        blockedByModal={false}
        onPendingChange={onPendingChange}
      />,
    );
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
    expect(getUserPref).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('feature-announcement')).toBeNull();
  });

  it('waits until a chat is usable and modal guides are out of the way', async () => {
    getUserPref.mockResolvedValue(null);
    const view = render(
      <FeatureAnnouncementHost
        userId="user-a"
        sessionsLoaded
        hasActiveSession={false}
        blockedByModal={false}
      />,
    );
    await waitFor(() => expect(getUserPref).toHaveBeenCalled());
    expect(screen.queryByTestId('feature-announcement')).toBeNull();

    view.rerender(
      <FeatureAnnouncementHost
        userId="user-a"
        sessionsLoaded
        hasActiveSession
        blockedByModal
      />,
    );
    expect(screen.queryByTestId('feature-announcement')).toBeNull();

    view.rerender(
      <FeatureAnnouncementHost
        userId="user-a"
        sessionsLoaded
        hasActiveSession
        blockedByModal={false}
      />,
    );
    expect(await screen.findByTestId('feature-announcement')).toBeTruthy();
  });

  it('isolates the local acknowledgement cache by account', async () => {
    getUserPref.mockResolvedValue(null);
    const first = render(<FeatureAnnouncementHost userId="user-a" sessionsLoaded hasActiveSession blockedByModal={false} />);
    await waitFor(() => expect(screen.getByTestId('feature-announcement')).toBeTruthy());
    fireEvent.click(screen.getByText('featureAnnouncements.dismiss'));
    await waitFor(() => expect(screen.queryByTestId('feature-announcement')).toBeNull());
    first.unmount();

    render(<FeatureAnnouncementHost userId="user-b" sessionsLoaded hasActiveSession blockedByModal={false} />);
    await waitFor(() => expect(screen.getByTestId('feature-announcement')).toBeTruthy());
    expect(localStorage.getItem('rcc_sync_user-a:feature_announcements')).not.toBeNull();
    expect(localStorage.getItem('rcc_sync_user-b:feature_announcements')).toBeNull();
  });
});
