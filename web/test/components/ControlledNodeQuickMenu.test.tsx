/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import type { MachineListItem } from '../../src/api/machines.js';

const refetch = vi.fn(async (): Promise<MachineListItem[] | null> => null);
let machines: MachineListItem[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({
    machines,
    filtered: machines,
    loaded: true,
    loading: false,
    error: null,
    stale: false,
    refetch,
  }),
}));

import { ControlledNodeQuickMenu } from '../../src/components/ControlledNodeQuickMenu.js';
import { ControlledNodeMachineMenu } from '../../src/components/ControlledNodeMachineMenu.js';
import { MACHINE_GROUP_STORAGE_KEY } from '../../src/machine-grouping.js';

afterEach(() => {
  cleanup();
  machines = [];
  vi.clearAllMocks();
  localStorage.clear();
});

function node(overrides: Partial<MachineListItem>): MachineListItem {
  return {
    serverId: 'node-1',
    refName: 'desktop-one',
    displayName: 'Desktop One',
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner',
    capabilities: [REMOTE_DESKTOP_CAPABILITY],
    ...overrides,
  };
}

function pointerPress(target: EventTarget, pointerType: 'mouse' | 'touch'): void {
  // jsdom has no PointerEvent constructor. Testing Library's pointerDown
  // fallback also omits `composed`, so it never reaches the document capture
  // listener under the component CI config. MouseEvent preserves the browser
  // event path; pointerType supplies the only pointer-specific detail needed.
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
  });
  Object.defineProperty(event, 'pointerType', { configurable: true, value: pointerType });
  fireEvent(target, event);
}

describe('ControlledNodeQuickMenu', () => {
  it('lists every node and resolves eligibility without trusting OS metadata', async () => {
    const online = node({});
    machines = [
      online,
      node({ serverId: 'node-2', refName: 'offline-two', displayName: 'Offline Two', online: false }),
      node({ serverId: 'node-3', refName: 'linux-three', displayName: 'Linux Three', os: 'linux' }),
    ];
    const onOpenRemoteDesktop = vi.fn();
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={onOpenRemoteDesktop} />);

    const trigger = screen.getByRole('button', { name: 'controlled_nodes.machines_title' });
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Desktop One')).toBeTruthy();
    expect(screen.getByText('Offline Two')).toBeTruthy();
    expect(screen.getByText('Linux Three')).toBeTruthy();

    // The whole row is the control: no separate per-row button any more.
    expect(screen.queryByRole('menuitem', { name: /remote_desktop\.open/ })).toBeNull();
    const rows = screen.getAllByRole('menuitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('aria-disabled')).toBeNull();
    expect(rows[1].getAttribute('aria-disabled')).toBe('true');
    expect(rows[1].getAttribute('title')).toBe('controlled_nodes.offline');
    // A reported OS label is descriptive. The legacy capability itself is the
    // understood Windows profile, so contradictory metadata cannot revoke it.
    expect(rows[2].getAttribute('aria-disabled')).toBeNull();

    // A disabled row does nothing and keeps the menu open.
    fireEvent.click(rows[1]);
    expect(onOpenRemoteDesktop).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(rows[0]);
    expect(onOpenRemoteDesktop).toHaveBeenCalledWith(online);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('explains an online node with remote exec disabled', async () => {
    machines = [node({ execEnabled: false })];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    const row = await screen.findByRole('menuitem', { name: /Desktop One/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toBe('controlled_nodes.exec_off');
  });

  it('centers the only wall entry in the title bar before group tabs and preserves click behavior', async () => {
    machines = [node({ teamIds: ['team-1'], teamNames: ['Ops'] })];
    const onWall = vi.fn();
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} onOpenRemoteDesktopWall={onWall} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));

    const menu = await screen.findByRole('menu');
    const wall = screen.getByRole('menuitem', { name: 'remote_desktop.wall_short_title' });
    const titleBar = menu.querySelector('.controlled-node-quick-menu-head')!;
    const tabs = menu.querySelector('.controlled-node-quick-groups')!;
    expect(menu.querySelectorAll('.controlled-node-quick-wall')).toHaveLength(1);
    expect(titleBar.contains(wall)).toBe(true);
    expect(wall.parentElement?.classList.contains('controlled-node-quick-menu-title-action')).toBe(true);
    expect(wall.parentElement?.getAttribute('role')).toBe('none');
    expect(titleBar.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wall.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(wall.textContent).toBe('remote_desktop.wall_short_title');
    expect(menu.textContent).not.toContain('remote_desktop.workspace_wall');

    fireEvent.click(wall);
    expect(onWall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('keeps the wall action permission-gated', async () => {
    machines = [node({})];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'remote_desktop.wall_short_title' })).toBeNull();
  });

  it('exposes a focusable semantic wall button that Enter activates', async () => {
    machines = [node({})];
    const onWall = vi.fn();
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} onOpenRemoteDesktopWall={onWall} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    const wall = await screen.findByRole('menuitem', { name: 'remote_desktop.wall_short_title' }) as HTMLButtonElement;

    expect(wall.type).toBe('button');
    expect(wall.tabIndex).toBe(0);
    wall.focus();
    expect(document.activeElement).toBe(wall);
    // jsdom omits the browser's default Enter-to-click action for buttons.
    // Replaying that uncancelled default proves this remains native keyboard activation.
    const runDefault = fireEvent.keyDown(wall, { key: 'Enter' });
    if (runDefault) fireEvent.click(wall, { detail: 0 });
    fireEvent.keyUp(wall, { key: 'Enter' });

    expect(onWall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('keeps the centered title action usable in a narrow touch viewport', async () => {
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const matchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    machines = [node({ teamIds: ['team-1'], teamNames: ['A very long shared team'] })];
    try {
      render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} onOpenRemoteDesktopWall={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
      const menu = await screen.findByRole('menu');
      const head = menu.querySelector('.controlled-node-quick-menu-head')!;
      const wall = screen.getByRole('menuitem', { name: 'remote_desktop.wall_short_title' });
      const tabs = menu.querySelector('.controlled-node-quick-groups')!;

      expect((menu as HTMLElement).style.width).toBe('304px');
      expect(head.contains(wall)).toBe(true);
      expect(head.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(wall.getAttribute('aria-label')).toBe('remote_desktop.wall_short_title');

      const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      const css = readFileSync(resolve(webRoot, 'src/styles.css'), 'utf8');
      expect(css).toMatch(/\.controlled-node-quick-menu-head\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
      expect(css).toMatch(/@media \(max-width: 420px\)[\s\S]*?\.controlled-node-quick-wall\s*\{[^}]*max-width:/);
      expect(css).toMatch(/\.controlled-node-quick-wall:focus-visible\s*\{/);
      expect(css).toMatch(/\.controlled-node-quick-wall:active\s*\{/);
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.controlled-node-quick-wall\s*\{[^}]*transition:\s*none/);
    } finally {
      if (width) Object.defineProperty(window, 'innerWidth', width);
      if (matchMedia) Object.defineProperty(window, 'matchMedia', matchMedia);
      else delete (window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia;
    }
  });

  it('provides an unbranded semantic short wall title in every locale without changing workspace_wall', () => {
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    for (const locale of ['en', 'es', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW']) {
      const messages = JSON.parse(readFileSync(
        resolve(webRoot, `src/i18n/locales/${locale}.json`),
        'utf8',
      )) as { remote_desktop?: { wall_short_title?: string; workspace_wall?: string } };
      const shortTitle = messages.remote_desktop?.wall_short_title;
      expect(shortTitle).toBeTruthy();
      expect(shortTitle?.toLowerCase()).not.toContain('aidesk.to');
      expect(messages.remote_desktop?.workspace_wall?.toLowerCase()).toContain('aidesk.to');
    }
  });

  it.each(['mouse', 'touch'] as const)('closes on an outside %s pointer press', async (pointerType) => {
    machines = [node({})];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    pointerPress(document.body, pointerType);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it.each(['mouse', 'touch'] as const)('keeps the menu open for inside %s pointer presses', async (pointerType) => {
    machines = [node({})];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    const row = await screen.findByRole('menuitem', { name: /Desktop One/ });

    pointerPress(row, pointerType);

    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('closes in capture phase when an outside control stops bubbling', async () => {
    machines = [node({})];
    const outside = document.createElement('button');
    outside.addEventListener('pointerdown', (event) => event.stopPropagation());
    document.body.appendChild(outside);
    try {
      render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
      expect(await screen.findByRole('menu')).toBeTruthy();

      pointerPress(outside, 'mouse');

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    } finally {
      outside.remove();
    }
  });

  it('removes dismissal listeners while closed and reinstalls them on remount', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const anchorRef = { current: anchor };
    const onClose = vi.fn();
    const props = {
      anchorRef,
      open: true,
      onClose,
      onSelect: () => {},
    };
    const view = render(<ControlledNodeMachineMenu {...props} />);

    expect(await screen.findByRole('menu')).toBeTruthy();
    pointerPress(document.body, 'mouse');
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(<ControlledNodeMachineMenu {...props} open={false} />);
    pointerPress(document.body, 'touch');
    expect(onClose, 'closed menu listener must be removed').toHaveBeenCalledTimes(1);

    view.rerender(<ControlledNodeMachineMenu {...props} />);
    expect(await screen.findByRole('menu')).toBeTruthy();
    pointerPress(document.body, 'touch');
    expect(onClose, 'reopened menu gets exactly one fresh listener').toHaveBeenCalledTimes(2);
    anchor.remove();
  });

  it('rebinds dismissal to the latest onClose callback', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const anchorRef = { current: anchor };
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const view = render(
      <ControlledNodeMachineMenu
        anchorRef={anchorRef}
        open
        onClose={firstClose}
        onSelect={() => {}}
      />,
    );
    expect(await screen.findByRole('menu')).toBeTruthy();

    view.rerender(
      <ControlledNodeMachineMenu
        anchorRef={anchorRef}
        open
        onClose={latestClose}
        onSelect={() => {}}
      />,
    );
    pointerPress(document.body, 'mouse');

    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it('portals into the fullscreen element when it holds the trigger', async () => {
    machines = [node({})];
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => host });
    try {
      render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />, { container: host });
      fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
      const menu = await screen.findByRole('menu');
      expect(host.contains(menu)).toBe(true);
    } finally {
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      host.remove();
    }
  });

  it('closes on Escape and restores focus to the chevron', async () => {
    machines = [node({})];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'controlled_nodes.machines_title' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('ControlledNodeQuickMenu group tabs', () => {
  const open = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
  };

  it('carries the same counted tabs as the machines page', async () => {
    // Same control, same numbers, both built from one place: a count here
    // that disagreed with the one on the machines tab would make people
    // distrust both.
    machines = [
      node({ serverId: 'own', displayName: 'Own', accessRole: 'owner', teamIds: ['team-1'], teamNames: ['Ops'] }),
      node({ serverId: 'their', displayName: 'Theirs', accessRole: 'viewer', teamIds: ['team-1'], teamNames: ['Ops'] }),
      node({ serverId: 'loose', displayName: 'Loose', accessRole: 'owner' }),
    ];
    render(<ControlledNodeQuickMenu />);
    open();

    const countOf = (id: string): string | null | undefined => document
      .querySelector(`[data-testid="controlled-node-quick-group-${id}"] .controlled-nodes-team-chip-count`)
      ?.textContent;
    await waitFor(() => expect(countOf('direct')).toBe('2'));
    expect(countOf('team-1')).toBe('2');
    expect(countOf('all')).toBe('3');

    // Your own grouped machine is right there on the default tab.
    expect(document.body.textContent).toContain('Own');
    expect(document.body.textContent).toContain('Loose');
    expect(document.body.textContent).not.toContain('Theirs');

    fireEvent.click(document.querySelector('[data-testid="controlled-node-quick-group-team-1"]') as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain('Theirs'));
    expect(document.body.textContent).toContain('Own');
    expect(document.body.textContent).not.toContain('Loose');
    // Rows under a group chip are still the click targets.
    expect(screen.getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Own'),
      expect.stringContaining('Theirs'),
    ]);
  });

  it('opens on the group last chosen anywhere, remembered in this browser', async () => {
    localStorage.setItem(MACHINE_GROUP_STORAGE_KEY, JSON.stringify({ version: 1, group: 'team-1' }));
    machines = [
      node({ serverId: 'their', displayName: 'Theirs', accessRole: 'viewer', teamIds: ['team-1'], teamNames: ['Ops'] }),
      node({ serverId: 'loose', displayName: 'Loose', accessRole: 'owner' }),
    ];
    render(<ControlledNodeQuickMenu />);
    open();
    await waitFor(() => expect(document.body.textContent).toContain('Theirs'));
    expect(document.body.textContent).not.toContain('Loose');
    expect(document.querySelector('[data-testid="controlled-node-quick-group-team-1"]')?.classList.contains('is-active')).toBe(true);
  });

  it('offers no group tabs when nothing is grouped', () => {
    machines = [node({ serverId: 'loose', displayName: 'Loose', accessRole: 'owner' })];
    render(<ControlledNodeQuickMenu />);
    open();
    expect(document.querySelector('[data-testid="controlled-node-quick-group-direct"]')).toBeNull();
  });
});
