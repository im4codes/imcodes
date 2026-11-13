/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import type { MachineListItem } from '../../src/api/machines.js';

let mockState: {
  machines: MachineListItem[];
  loaded: boolean;
  loading: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
};

vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({
    ...mockState,
    filtered: mockState.machines,
    stale: false,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts.defaultValue === 'string') {
        return opts.name ? opts.defaultValue.replace('{{name}}', String(opts.name)) : opts.defaultValue;
      }
      return key;
    },
  }),
}));

import { MobileRemoteDesktopMenuList } from '../../src/components/MobileRemoteDesktopMenuList.js';

function makeMachine(overrides: Partial<MachineListItem> = {}): MachineListItem {
  return {
    serverId: 'node-win-1',
    nodeId: '1000000001',
    refName: 'win-box',
    displayName: 'Studio PC',
    os: 'windows',
    online: true,
    execEnabled: true,
    accessRole: 'owner',
    capabilities: [REMOTE_DESKTOP_CAPABILITY],
    ...overrides,
  };
}

describe('MobileRemoteDesktopMenuList', () => {
  beforeEach(() => {
    localStorage.clear();
    mockState = {
      machines: [],
      loaded: true,
      loading: false,
      error: null,
      refetch: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('refetches once on mount and renders loading / empty / error states', () => {
    mockState.loaded = false;
    const { rerender } = render(<MobileRemoteDesktopMenuList onSelect={vi.fn()} />);
    expect(mockState.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading…')).toBeTruthy();

    mockState.loaded = true;
    rerender(<MobileRemoteDesktopMenuList onSelect={vi.fn()} />);
    expect(screen.getByText('No controlled nodes yet.')).toBeTruthy();

    mockState.error = new Error('network failed');
    rerender(<MobileRemoteDesktopMenuList onSelect={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not refresh node status');
  });

  it('renders eligible nodes as direct connect buttons and blocks offline / exec-disabled nodes', () => {
    const onSelect = vi.fn();
    const onlineWin = makeMachine({ serverId: 'm1', displayName: 'Workstation Win' });
    const offlineMac = makeMachine({ serverId: 'm2', displayName: 'Sleepy Mac', online: false });
    const execOff = makeMachine({ serverId: 'm3', displayName: 'Locked Box', execEnabled: false });
    const noProfile = makeMachine({ serverId: 'm4', displayName: 'Shell Only', capabilities: [] });
    mockState.machines = [onlineWin, offlineMac, execOff, noProfile];

    render(<MobileRemoteDesktopMenuList onSelect={onSelect} />);

    const m1Btn = screen.getByTestId('mobile-remote-node-m1');
    expect(m1Btn.getAttribute('aria-disabled')).toBeNull();
    expect(m1Btn.classList.contains('is-selectable')).toBe(true);
    expect(m1Btn.textContent).toContain('Workstation Win');
    expect(m1Btn.textContent).toContain('→');

    const m2Btn = screen.getByTestId('mobile-remote-node-m2');
    expect(m2Btn.getAttribute('aria-disabled')).toBe('true');
    expect(m2Btn.classList.contains('is-disabled')).toBe(true);
    expect(m2Btn.getAttribute('title')).toBe('Offline');

    const m3Btn = screen.getByTestId('mobile-remote-node-m3');
    expect(m3Btn.getAttribute('aria-disabled')).toBe('true');
    expect(m3Btn.getAttribute('title')).toBe('Exec disabled');

    const m4Btn = screen.getByTestId('mobile-remote-node-m4');
    expect(m4Btn.getAttribute('aria-disabled')).toBe('true');
    expect(m4Btn.getAttribute('title')).toBe('Remote desktop unavailable');

    fireEvent.click(m2Btn);
    fireEvent.click(m3Btn);
    fireEvent.click(m4Btn);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(m1Btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(onlineWin);
  });

  it('renders machine group chips when team groups exist and switches groups cleanly', () => {
    const own = makeMachine({ serverId: 'own', displayName: 'Own PC', accessRole: 'owner', teamIds: ['t1'], teamNames: ['Ops'] });
    const shared = makeMachine({ serverId: 'shared', displayName: 'Ops PC', accessRole: 'participant', teamIds: ['t1'], teamNames: ['Ops'] });
    mockState.machines = [own, shared];

    render(<MobileRemoteDesktopMenuList onSelect={vi.fn()} />);

    expect(screen.getByTestId('mobile-remote-menu-group-direct')).toBeTruthy();
    expect(screen.getByTestId('mobile-remote-menu-group-t1')).toBeTruthy();
    expect(screen.queryByTestId('mobile-remote-node-shared')).toBeNull();

    fireEvent.click(screen.getByTestId('mobile-remote-menu-group-t1'));
    expect(screen.getByTestId('mobile-remote-node-shared')).toBeTruthy();
    expect(screen.getByTestId('mobile-remote-node-own')).toBeTruthy();
  });
});
