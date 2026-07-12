/**
 * @vitest-environment jsdom
 *
 * AtPicker "machine" category (tasks 8.4 + 10.13). Verifies the machine category
 * appears in the chooser, entering it lists the account's controllable machines
 * with online/offline state, selecting an ONLINE machine asks the host to insert
 * its `^^(refName)` marker, and an OFFLINE machine is shown but NOT selectable.
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

const machineList: MachineListItem[] = [
  { serverId: 'srv-on', refName: 'winbox-a1', displayName: 'Win Box', os: 'windows', online: true, execEnabled: true },
  { serverId: 'srv-off', refName: 'macmini-b2', displayName: 'Mac Mini', os: 'darwin', online: false, execEnabled: true },
];

vi.mock('../src/hooks/useMachines.js', async (importOriginal) => {
  // Use the REAL shared `filterMachines` so keystroke filtering is exercised for real.
  const orig = await importOriginal<typeof import('../src/hooks/useMachines.js')>();
  return {
    ...orig,
    useMachines: (query?: string) => ({
      machines: machineList,
      filtered: orig.filterMachines(machineList, query),
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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

  it('inserts the marker (calls onSelectMachine with refName) when an ONLINE machine is clicked', async () => {
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    const span = await waitFor(() => nameSpan(container, 'Win Box'));
    fireEvent.click(span.parentElement as HTMLElement);
    expect(onSelectMachine).toHaveBeenCalledWith('winbox-a1');
  });

  it('does NOT select an OFFLINE machine on click (offline shown but not selectable)', async () => {
    const onSelectMachine = vi.fn();
    const { container } = render(<AtPicker {...baseProps({ onSelectMachine })} />);
    openMachineCategory(container);
    const span = await waitFor(() => nameSpan(container, 'Mac Mini'));
    fireEvent.click(span.parentElement as HTMLElement);
    expect(onSelectMachine).not.toHaveBeenCalled();
  });
});
