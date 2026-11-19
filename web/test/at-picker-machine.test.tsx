/**
 * @vitest-environment jsdom
 *
 * AtPicker "machine" category (tasks 8.4 + 10.13). Verifies the machine category
 * appears in the chooser, entering it lists the account's controllable machines
 * with online/offline state. Connectivity is informational: either row inserts
 * its annotated `^^(nodeId)-(displayName)` reference.
 */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineListItem } from '../src/api/machines.js';

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, writable: true, configurable: true });
}
if (typeof document !== 'undefined' && typeof (document as { execCommand?: unknown }).execCommand !== 'function') {
  Object.defineProperty(document, 'execCommand', { value: () => false, writable: true, configurable: true });
}

// t() returns the key so assertions stay language-agnostic.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

const ungroupedMachineList: MachineListItem[] = [
  { serverId: 'srv-on', nodeId: '1000000001', refName: 'winbox-a1', displayName: 'Win Box', os: 'windows', online: true, execEnabled: true },
  { serverId: 'srv-off', nodeId: '1000000002', refName: 'macmini-b2', displayName: 'Mac Mini', os: 'darwin', online: false, execEnabled: true },
];

let activeMachineList: MachineListItem[] = ungroupedMachineList;

vi.mock('../src/hooks/useMachines.js', async (importOriginal) => {
  // Use the REAL shared `filterMachines` so keystroke filtering is exercised for real.
  const orig = await importOriginal<typeof import('../src/hooks/useMachines.js')>();
  return {
    ...orig,
    useMachines: (query?: string) => ({
      machines: activeMachineList,
      filtered: orig.filterMachines(activeMachineList, query),
      loaded: true,
      loading: false,
      error: null,
      stale: false,
      refetch: vi.fn(),
    }),
  };
});

vi.mock('../src/components/p2p-combos.js', () => ({
  useP2pCustomCombos: () => ({ allCombos: { custom: [] } }),
}));

import { AtPicker } from '../src/components/AtPicker.js';
import { MACHINE_GROUP_ALL, MACHINE_GROUP_DIRECT, loadMachineGroup, saveMachineGroup } from '../src/machine-grouping.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  activeMachineList = ungroupedMachineList;
  vi.clearAllMocks();
});

function baseProps(over: Record<string, unknown> = {}) {
  return {
    query: '',
    sessions: [],
    rootSession: 'deck_app_brain',
    wsClient: { connected: true, send: vi.fn(), onMessage: vi.fn(() => () => {}) },
    projectDir: '/work/app',
    onSelectFile: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectDelegateAgent: vi.fn(),
    onSelectAlias: vi.fn(),
    onSelectMachine: vi.fn(),
    onClose: vi.fn(),
    visible: true,
    ...over,
  } as any;
}

function findRow(container: HTMLElement, text: string): HTMLElement | undefined {
  const matches = Array.from(container.querySelectorAll('div')).filter((d) => d.textContent?.includes(text)) as HTMLElement[];
  return matches.find((d) => !matches.some((other) => other !== d && d.contains(other)));
}

function openMachineCategory(container: HTMLElement): void {
  const row = findRow(container, 'machine.category_desc');
  if (!row) throw new Error('machine category row not found');
  fireEvent.click(row);
}

function nameSpan(container: HTMLElement, name: string): HTMLElement {
  const span = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === name);
  if (!span) throw new Error(`machine name span not found: ${name}`);
  return span as HTMLElement;
}

describe('AtPicker — machine category (10.13)', () => {
  it('shows a machine category and lists both online and offline machines when entered', async () => {
    const { container } = render(<AtPicker {...baseProps()} />);
    expect(container.textContent).toContain('machine.category');
    openMachineCategory(container);
    await waitFor(() => {
      expect(container.textContent).toContain('Win Box');
      expect(container.textContent).toContain('Mac Mini');
    });
    // Offline machine carries the offline hint.
    expect(container.textContent).toContain('machine.offline_hint');
  });

  it('passes the stable ref and display note when an ONLINE machine is clicked', async () => {
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    const span = await waitFor(() => nameSpan(container, 'Win Box'));
    fireEvent.click(span.parentElement as HTMLElement);
    expect(onSelectMachine).toHaveBeenCalledWith('1000000001', 'Win Box');
  });

  it('passes the stable ref and display note when an ONLINE machine is chosen by keyboard', async () => {
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    await waitFor(() => expect(container.textContent).toContain('Win Box'));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectMachine).toHaveBeenCalledWith('1000000001', 'Win Box');
  });

  it('selects an OFFLINE machine on click while preserving its offline status', async () => {
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    const span = await waitFor(() => nameSpan(container, 'Mac Mini'));
    fireEvent.click(span.parentElement as HTMLElement);
    expect(onSelectMachine).toHaveBeenCalledWith('1000000002', 'Mac Mini');
  });

  it('includes OFFLINE machines in keyboard navigation', async () => {
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    await waitFor(() => expect(container.textContent).toContain('Mac Mini'));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectMachine).toHaveBeenCalledWith('1000000002', 'Mac Mini');
  });

  it('omits group tabs and leaves ArrowLeft/ArrowRight uncaptured when there are no team groups', async () => {
    const { container } = render(<AtPicker {...baseProps()} />);
    openMachineCategory(container);
    await waitFor(() => expect(container.textContent).toContain('Win Box'));
    expect(container.querySelector('.controlled-nodes-group-filter')).toBeNull();
    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    document.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });
});

const groupedMachines: MachineListItem[] = [
  { serverId: 'srv-mine', nodeId: '1000000001', refName: 'mine-box', displayName: 'Mine Box', os: 'darwin', online: true, execEnabled: true, accessRole: 'owner' },
  { serverId: 'srv-ops', nodeId: '1000000002', refName: 'ops-box', displayName: 'Ops Box', os: 'linux', online: true, execEnabled: true, accessRole: 'viewer', teamIds: ['ops'], teamNames: ['Ops Team'] },
  { serverId: 'srv-lab', nodeId: '1000000003', refName: 'lab-box', displayName: 'Lab Box', os: 'linux', online: false, execEnabled: true, accessRole: 'viewer', teamIds: ['lab'], teamNames: ['Lab Team'] },
];

describe('AtPicker — machine group tabs, arrow switching & remembered group', () => {
  it('renders group tabs, switches groups with ArrowLeft/ArrowRight, and inserts from the visible group', async () => {
    activeMachineList = groupedMachines;
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    await waitFor(() => expect(container.querySelector('[data-testid="at-machine-group-direct"]')).not.toBeNull());

    // Default direct group shows only Mine Box.
    expect(container.textContent).toContain('Mine Box');
    expect(container.textContent).not.toContain('Ops Box');

    // ArrowRight moves to Ops Team and persists the choice.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await waitFor(() => expect(container.textContent).toContain('Ops Box'));
    expect(container.textContent).not.toContain('Mine Box');
    expect(loadMachineGroup()).toBe('ops');

    // ArrowRight again -> Lab Team; ArrowLeft -> back to Ops Team; ArrowLeft twice -> wraps to All.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await waitFor(() => expect(container.textContent).toContain('Lab Box'));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitFor(() => expect(container.textContent).toContain('Ops Box'));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitFor(() => expect(container.textContent).toContain('Mine Box'));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(container.textContent).toContain('Mine Box');
      expect(container.textContent).toContain('Ops Box');
      expect(container.textContent).toContain('Lab Box');
    });
    expect(loadMachineGroup()).toBe(MACHINE_GROUP_ALL);

    // Selecting by ArrowDown + Enter selects from the active visible group (Ops Box).
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectMachine).toHaveBeenCalledWith('1000000002', 'Ops Box');
  });

  it('prevents blur on chip mousedown, switches on click, filters within group, and handles empty results safely', async () => {
    activeMachineList = groupedMachines;
    const onSelectMachine = vi.fn();
    const { container, rerender } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    const opsChip = await waitFor(() => container.querySelector('[data-testid="at-machine-group-ops"]') as HTMLElement);

    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    opsChip.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);

    fireEvent.click(opsChip);
    await waitFor(() => expect(container.textContent).toContain('Ops Box'));

    // Query that matches Lab Box only yields empty state under Ops Team, and Enter does not insert.
    rerender(<AtPicker {...baseProps({ onSelectMachine, query: 'lab' })} />);
    await waitFor(() => expect(container.textContent).toContain('machine.no_results'));
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(onSelectMachine).not.toHaveBeenCalled();

    // Switching to Lab Team restores the matching row and allows Enter selection.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await waitFor(() => expect(container.textContent).toContain('Lab Box'));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectMachine).toHaveBeenCalledWith('1000000003', 'Lab Box');
  });

  it('reuses remembered group across reopen and falls back to direct without overwriting unknown remembered group', async () => {
    activeMachineList = groupedMachines;
    saveMachineGroup('lab');
    const { container, unmount } = render(<AtPicker {...baseProps()} />);
    openMachineCategory(container);
    await waitFor(() => expect(container.textContent).toContain('Lab Box'));
    expect(container.textContent).not.toContain('Ops Box');
    unmount();

    // Stale/missing group falls back to direct while keeping localStorage intact.
    saveMachineGroup('team-missing');
    const second = render(<AtPicker {...baseProps()} />);
    openMachineCategory(second.container);
    await waitFor(() => expect(second.container.textContent).toContain('Mine Box'));
    expect(second.container.textContent).not.toContain('Lab Box');
    expect(loadMachineGroup()).toBe('team-missing');
    expect(MACHINE_GROUP_DIRECT).toBe('direct');
  });
});
