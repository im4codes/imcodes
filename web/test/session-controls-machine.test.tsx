/**
 * @vitest-environment jsdom
 *
 * Inline `^` controlled-node autocomplete in SessionControls: verifies group
 * filter tabs, ArrowLeft/ArrowRight group cycling, mousedown preventBlur,
 * highlight reset + search filtering within the active group, and shared
 * browser-local memory reuse (`imcodes.web.machine-group.v1`).
 */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineListItem } from '../src/api/machines.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, writable: true, configurable: true });
}
const execCommandMock = vi.fn((cmd: string, _showUi?: boolean, val?: string) => {
  if (cmd === 'insertText' && typeof val === 'string' && document.activeElement) {
    document.activeElement.textContent = (document.activeElement.textContent ?? '') + val;
    return true;
  }
  return false;
});
if (typeof document !== 'undefined') {
  Object.defineProperty(document, 'execCommand', { value: execCommandMock, writable: true, configurable: true });
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

const ungroupedMachines: MachineListItem[] = [
  { serverId: 'srv-1', nodeId: '1000000001', refName: 'win-box', displayName: 'Win Box', os: 'windows', online: true, execEnabled: true },
  { serverId: 'srv-2', nodeId: '1000000002', refName: 'mac-mini', displayName: 'Mac Mini', os: 'darwin', online: false, execEnabled: true },
];

const groupedMachines: MachineListItem[] = [
  { serverId: 'srv-mine', nodeId: '1000000001', refName: 'mine-box', displayName: 'Mine Box', os: 'darwin', online: true, execEnabled: true, accessRole: 'owner' },
  { serverId: 'srv-ops-1', nodeId: '1000000002', refName: 'ops-alpha', displayName: 'Ops Alpha', os: 'linux', online: true, execEnabled: true, accessRole: 'viewer', teamIds: ['ops'], teamNames: ['Ops Team'] },
  { serverId: 'srv-ops-2', nodeId: '1000000003', refName: 'ops-beta', displayName: 'Ops Beta', os: 'linux', online: false, execEnabled: true, accessRole: 'viewer', teamIds: ['ops'], teamNames: ['Ops Team'] },
  { serverId: 'srv-lab', nodeId: '1000000004', refName: 'lab-box', displayName: 'Lab Box', os: 'linux', online: true, execEnabled: true, accessRole: 'viewer', teamIds: ['lab'], teamNames: ['Lab Team'] },
];

let activeMachines: MachineListItem[] = groupedMachines;

vi.mock('../src/hooks/useMachines.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/hooks/useMachines.js')>();
  return {
    ...orig,
    useMachines: (query?: string) => ({
      machines: activeMachines,
      filtered: orig.filterMachines(activeMachines, query),
      loaded: true,
      loading: false,
      error: null,
      stale: false,
      refetch: vi.fn(),
    }),
  };
});

import { SessionControls } from '../src/components/SessionControls.js';
import { loadMachineGroup, saveMachineGroup } from '../src/machine-grouping.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(), addCommand: vi.fn(), addPhrase: vi.fn(),
  removeCommand: vi.fn(), removePhrase: vi.fn(), removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(), clearHistory: vi.fn(), clearSessionHistory: vi.fn(),
};

function renderControls() {
  const onSend = vi.fn();
  const ws = {
    connected: true,
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  } as any;
  const { container } = render(
    <SessionControls
      ws={ws}
      activeSession={{ name: 'deck_app_brain', project: 'app', role: 'brain', agentType: 'claude-code', state: 'idle', projectDir: '/work/app' } as any}
      quickData={quickData}
      serverId="srv1"
      sessions={[]}
      subSessions={[]}
      onSend={onSend}
    />,
  );
  const editor = container.querySelector('[role="textbox"]') as HTMLElement;
  return { container, editor, onSend };
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  fireEvent.input(editor);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  activeMachines = groupedMachines;
  vi.clearAllMocks();
});

describe('SessionControls — inline ^ machine group tabs, arrow switching & memory', () => {
  it('omits group tabs and does not hijack ArrowLeft/ArrowRight when no team groups exist', async () => {
    activeMachines = ungroupedMachines;
    const { container, editor } = renderControls();
    typeInto(editor, '^');
    const picker = await waitFor(() => container.querySelector('.controls-machine-picker') as HTMLElement);
    expect(picker.querySelector('.controlled-nodes-group-filter')).toBeNull();
    expect(picker.textContent).toContain('Win Box');
    expect(picker.textContent).toContain('Mac Mini');

    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    editor.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });

  it('shows shared group tabs with counts, cycles groups via ArrowLeft/ArrowRight, resets highlight, and inserts from active group', async () => {
    const { container, editor } = renderControls();
    typeInto(editor, '^');
    const picker = await waitFor(() => container.querySelector('.controls-machine-picker') as HTMLElement);
    expect(picker.querySelector('[data-testid="controls-machine-group-direct"]')?.textContent).toContain('1');
    expect(picker.querySelector('[data-testid="controls-machine-group-ops"]')?.textContent).toContain('2');
    expect(picker.querySelector('[data-testid="controls-machine-group-lab"]')?.textContent).toContain('1');
    expect(picker.querySelector('[data-testid="controls-machine-group-all"]')?.textContent).toContain('4');

    // Default direct group only displays Mine Box.
    expect(picker.textContent).toContain('Mine Box');
    expect(picker.textContent).not.toContain('Ops Alpha');

    // Switch to Ops Team with ArrowRight -> Ops Alpha & Ops Beta appear, persisted to storage.
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    await waitFor(() => expect(picker.textContent).toContain('Ops Alpha'));
    expect(picker.textContent).toContain('Ops Beta');
    expect(loadMachineGroup()).toBe('ops');

    // Move highlight down to Ops Beta, then ArrowRight to Lab Team: highlight must reset to 0 (Lab Box).
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    await waitFor(() => {
      const hl = picker.querySelector('[data-hl="true"]');
      expect(hl?.textContent).toContain('Ops Beta');
    });
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    await waitFor(() => {
      const hl = picker.querySelector('[data-hl="true"]');
      expect(hl?.textContent).toContain('Lab Box');
    });

    // ArrowLeft back to Ops Team, ArrowDown to Ops Beta, Enter inserts Ops Beta marker.
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    await waitFor(() => expect(picker.textContent).toContain('Ops Alpha'));
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.textContent).toContain('^^(1000000003)-(Ops Beta)');
  });

  it('prevents blur on chip mousedown, filters within chosen group, and ignores Tab/Enter when empty', async () => {
    const { container, editor } = renderControls();
    editor.focus();
    typeInto(editor, '^');
    const picker = await waitFor(() => container.querySelector('.controls-machine-picker') as HTMLElement);
    const opsChip = picker.querySelector('[data-testid="controls-machine-group-ops"]') as HTMLElement;

    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    opsChip.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);

    fireEvent.click(opsChip);
    await waitFor(() => expect(picker.textContent).toContain('Ops Alpha'));
    expect(container.querySelector('.controls-machine-picker')).not.toBeNull();

    // Query for Lab Box while inside Ops Team -> empty state; Tab inserts nothing.
    typeInto(editor, '^lab');
    await waitFor(() => expect(picker.textContent).toContain('machine.no_results'));
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('^lab');

    // Switch to Lab Team -> Lab Box appears and Tab inserts its canonical reference.
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    await waitFor(() => expect(picker.textContent).toContain('Lab Box'));
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toContain('^^(1000000004)-(Lab Box)');
  });

  it('reuses remembered group on reopen and falls back to direct without overwriting missing stored group', async () => {
    saveMachineGroup('lab');
    const { container, editor } = renderControls();
    typeInto(editor, '^');
    await waitFor(() => expect(container.querySelector('.controls-machine-picker')?.textContent).toContain('Lab Box'));

    // Close picker via Escape, simulate external update from QuickInputPanel/AtPicker, reopen.
    fireEvent.keyDown(editor, { key: 'Escape' });
    saveMachineGroup('ops');
    typeInto(editor, '^');
    await waitFor(() => expect(container.querySelector('.controls-machine-picker')?.textContent).toContain('Ops Alpha'));

    // Close and set a group not present in current list -> fallback to direct while preserving storage.
    fireEvent.keyDown(editor, { key: 'Escape' });
    saveMachineGroup('team-missing');
    typeInto(editor, '^');
    await waitFor(() => {
      const text = container.querySelector('.controls-machine-picker')?.textContent ?? '';
      expect(text).toContain('Mine Box');
      expect(text).not.toContain('Ops Alpha');
    });
    expect(loadMachineGroup()).toBe('team-missing');
  });
});
