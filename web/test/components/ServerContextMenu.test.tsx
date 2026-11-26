/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ServerContextMenu } from '../../src/components/ServerContextMenu.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ServerContextMenu', () => {
  it('renders Mute notifications when unmuted and Unmute notifications when muted', () => {
    const onTogglePushMute = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <ServerContextMenu
        x={20}
        y={20}
        pinned={false}
        pushMuted={false}
        onTogglePin={vi.fn()}
        onTogglePushMute={onTogglePushMute}
        onRename={vi.fn()}
        onUpgrade={vi.fn()}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    );

    const muteBtn = screen.getByTestId('server-ctx-toggle-push-mute');
    expect(muteBtn.textContent).toBe('server.mute_notifications');
    fireEvent.click(muteBtn);
    expect(onTogglePushMute).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <ServerContextMenu
        x={20}
        y={20}
        pinned={false}
        pushMuted={true}
        onTogglePin={vi.fn()}
        onTogglePushMute={onTogglePushMute}
        onRename={vi.fn()}
        onUpgrade={vi.fn()}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('server-ctx-toggle-push-mute').textContent).toBe('server.unmute_notifications');
  });

  it('clamps menu position inside the viewport when triggered near the bottom-right corner', () => {
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 300);

    const { container } = render(
      <ServerContextMenu
        x={380}
        y={285}
        pinned={false}
        pushMuted={false}
        onTogglePin={vi.fn()}
        onTogglePushMute={vi.fn()}
        onRename={vi.fn()}
        onUpgrade={vi.fn()}
        onUpgradeAll={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const menu = container.querySelector('.server-ctx-menu') as HTMLElement;
    const left = parseInt(menu.style.left, 10);
    const top = parseInt(menu.style.top, 10);
    expect(left).toBeLessThan(380);
    expect(left).toBeGreaterThanOrEqual(4);
    expect(top).toBeLessThanOrEqual(80);
    expect(top).toBeGreaterThanOrEqual(4);
  });

  it('renders only Pin/Unpin when owner-only actions are omitted for shared-in servers', () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    const { container, rerender } = render(
      <ServerContextMenu
        x={24}
        y={32}
        pinned={false}
        onTogglePin={onTogglePin}
        onClose={onClose}
      />,
    );

    const items = container.querySelectorAll('.server-ctx-item');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe('server.pin');
    expect(container.querySelector('.menu-divider')).toBeNull();
    expect(container.querySelector('.server-ctx-item-danger')).toBeNull();
    fireEvent.click(items[0]!);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <ServerContextMenu
        x={24}
        y={32}
        pinned
        onTogglePin={onTogglePin}
        onClose={onClose}
      />,
    );
    expect(container.querySelectorAll('.server-ctx-item')).toHaveLength(1);
    expect(container.querySelector('.server-ctx-item')?.textContent).toBe('server.unpin');
  });
});
