/**
 * @vitest-environment jsdom
 *
 * Controlled nodes appear in Quick Input only when available. Selecting any
 * node inserts its stable ref marker; offline is an informational state.
 */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineListItem } from '../src/api/machines.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));
vi.mock('../src/hooks/useAliases.js', () => ({
  useAliases: () => ({
    aliases: [], filtered: [], loaded: true, loading: false, error: null,
    refetch: vi.fn(), create: vi.fn(), remove: vi.fn(),
  }),
}));

import { MACHINE_GROUP_ALL, MACHINE_GROUP_DIRECT, MACHINE_GROUP_STORAGE_KEY, loadMachineGroup, saveMachineGroup } from '../src/machine-grouping.js';

import { QuickInputPanel } from '../src/components/QuickInputPanel.js';

const machine = (over: Partial<MachineListItem>): MachineListItem => ({
  serverId: 'machine-1',
  nodeId: '1000000001',
  refName: 'stable-ref',
  displayName: 'Office PC',
  online: true,
  execEnabled: true,
  ...over,
});

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onSend: vi.fn(),
    agentType: 'codex-sdk',
    sessionName: 'deck_app_brain',
    data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
    loaded: true,
    onAddCommand: vi.fn(), onAddPhrase: vi.fn(), onRemoveCommand: vi.fn(), onRemovePhrase: vi.fn(),
    onRemoveHistory: vi.fn(), onRemoveSessionHistory: vi.fn(), onClearHistory: vi.fn(), onClearSessionHistory: vi.fn(),
    ...over,
  } as any;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('QuickInputPanel controlled-node tab', () => {
  it('does not show the tab when the account has no controlled nodes', () => {
    render(<QuickInputPanel {...props({ machines: [] })} />);
    expect(document.body.textContent).not.toContain('quick_input.tab_machines');
  });

  it('inserts stable refs for online and offline nodes while preserving offline status', () => {
    const onInsertMachine = vi.fn();
    const onClose = vi.fn();
    render(<QuickInputPanel {...props({
      onInsertMachine,
      onClose,
      machines: [
        machine({ serverId: 'online', nodeId: '1000000001', refName: 'office-pc', displayName: 'Renamed Office PC' }),
        machine({ serverId: 'offline', nodeId: '1000000002', refName: 'lab-pc', displayName: 'Lab PC', online: false }),
      ],
    })} />);

    const tab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.tab_machines'))!;
    fireEvent.click(tab);
    expect(document.body.textContent).toContain('Renamed Office PC');
    expect(document.body.textContent).toContain('^^(1000000001)');
    expect(document.body.textContent).not.toContain('^^(office-pc)');

    const nodeButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.qp-machine-item'));
    expect(nodeButtons[1].disabled).toBe(false);
    expect(nodeButtons[1].classList.contains('is-offline')).toBe(true);
    fireEvent.click(nodeButtons[1]);
    expect(onInsertMachine).toHaveBeenCalledWith('1000000002', 'Lab PC');
    fireEvent.click(nodeButtons[0]);
    expect(onInsertMachine).toHaveBeenCalledWith('1000000001', 'Renamed Office PC');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});


const groupedMachines = [
  machine({ serverId: 'mine', displayName: 'Mine', accessRole: 'owner' }),
  machine({ serverId: 'ops', nodeId: '1000000002', displayName: 'Ops offline', online: false,
    accessRole: 'viewer', teamIds: ['ops', 'lab'], teamNames: ['Operations', 'Lab'] }),
  machine({ serverId: 'lab', displayName: 'Lab only', teamIds: ['lab'], teamNames: ['Lab'] }),
];
const openMachines = () => fireEvent.click(Array.from(document.querySelectorAll('button'))
  .find((button) => button.textContent?.includes('quick_input.tab_machines'))!);
const pickGroup = (id: string) => fireEvent.click(document.querySelector(`[data-testid="qp-machine-group-${id}"]`)!);
const rows = () => Array.from(document.querySelectorAll('.qp-machine-item strong')).map((el) => el.textContent);

describe('QuickInputPanel reuses remote desktop groups', () => {
  it('filters by every shared group, keeps offline references selectable and exposes All', () => {
    const onInsertMachine = vi.fn();
    render(<QuickInputPanel {...props({ machines: groupedMachines, onInsertMachine })} />);
    openMachines();
    expect(rows()).toEqual(['Mine']);
    pickGroup('ops');
    expect(rows()).toEqual(['Ops offline']);
    fireEvent.click(document.querySelector('.qp-machine-item')!);
    expect(onInsertMachine).toHaveBeenCalledWith('1000000002', 'Ops offline');
    pickGroup('lab');
    expect(rows()).toEqual(['Ops offline', 'Lab only']);
    pickGroup(MACHINE_GROUP_ALL);
    expect(rows()).toEqual(['Mine', 'Ops offline', 'Lab only']);
    expect(loadMachineGroup()).toBe(MACHINE_GROUP_ALL);
  });

  it('reads remote desktop preference on mount and persists the choice across remount', () => {
    saveMachineGroup('ops');
    const view = render(<QuickInputPanel {...props({ machines: groupedMachines })} />);
    openMachines();
    expect(rows()).toEqual(['Ops offline']);
    pickGroup('lab');
    view.unmount();
    render(<QuickInputPanel {...props({ machines: groupedMachines })} />);
    openMachines();
    expect(rows()).toEqual(['Ops offline', 'Lab only']);
    expect(document.querySelector('[data-testid="qp-machine-group-lab"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('reloads the shared preference when reopened or returning from another tab', () => {
    const input = props({ machines: groupedMachines });
    const view = render(<QuickInputPanel {...input} />);
    openMachines();
    view.rerender(<QuickInputPanel {...input} open={false} />);
    saveMachineGroup('ops');
    view.rerender(<QuickInputPanel {...input} open />);
    expect(rows()).toEqual(['Ops offline']);
    fireEvent.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('quick_input.tab_quick'))!);
    saveMachineGroup('lab');
    openMachines();
    expect(rows()).toEqual(['Ops offline', 'Lab only']);
  });

  it('temporarily falls back for a missing group without erasing the remembered group', () => {
    saveMachineGroup('ops');
    const input = props({ machines: [groupedMachines[0], groupedMachines[2]] });
    const view = render(<QuickInputPanel {...input} />);
    openMachines();
    expect(rows()).toEqual(['Mine']);
    expect(loadMachineGroup()).toBe('ops');
    view.rerender(<QuickInputPanel {...input} machines={groupedMachines} />);
    expect(rows()).toEqual(['Ops offline']);
  });

  it('does not hide legacy ungrouped machines or show a useless group bar', () => {
    render(<QuickInputPanel {...props({ machines: [groupedMachines[0]] })} />);
    openMachines();
    expect(document.querySelector('[data-testid="qp-machine-group-all"]')).toBeNull();
    expect(rows()).toEqual(['Mine']);
  });

  it('works without browser storage and keeps the selection in this view', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    try {
      render(<QuickInputPanel {...props({ machines: groupedMachines })} />);
      openMachines();
      pickGroup('lab');
      expect(rows()).toEqual(['Ops offline', 'Lab only']);
    } finally { spy.mockRestore(); }
  });

  it('uses the existing default for malformed storage', () => {
    localStorage.setItem(MACHINE_GROUP_STORAGE_KEY, 'invalid json');
    render(<QuickInputPanel {...props({ machines: groupedMachines })} />);
    openMachines();
    expect(rows()).toEqual(['Mine']);
    expect(document.querySelector(`[data-testid="qp-machine-group-${MACHINE_GROUP_DIRECT}"]`)?.getAttribute('aria-selected')).toBe('true');
  });
});
