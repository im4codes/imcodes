/**
 * @vitest-environment jsdom
 *
 * Controlled nodes appear in Quick Input only when available. Selecting an
 * online node inserts its stable ref marker; offline nodes are not selectable.
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

import { QuickInputPanel } from '../src/components/QuickInputPanel.js';

const machine = (over: Partial<MachineListItem>): MachineListItem => ({
  serverId: 'machine-1',
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

afterEach(() => cleanup());

describe('QuickInputPanel controlled-node tab', () => {
  it('does not show the tab when the account has no controlled nodes', () => {
    render(<QuickInputPanel {...props({ machines: [] })} />);
    expect(document.body.textContent).not.toContain('quick_input.tab_machines');
  });

  it('inserts the stable ref of an online node and disables offline nodes', () => {
    const onInsertMachine = vi.fn();
    const onClose = vi.fn();
    render(<QuickInputPanel {...props({
      onInsertMachine,
      onClose,
      machines: [
        machine({ serverId: 'online', refName: 'office-pc', displayName: 'Renamed Office PC' }),
        machine({ serverId: 'offline', refName: 'lab-pc', displayName: 'Lab PC', online: false }),
      ],
    })} />);

    const tab = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('quick_input.tab_machines'))!;
    fireEvent.click(tab);
    expect(document.body.textContent).toContain('Renamed Office PC');
    expect(document.body.textContent).toContain('^^(office-pc)');

    const nodeButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.qp-machine-item'));
    expect(nodeButtons[1].disabled).toBe(true);
    fireEvent.click(nodeButtons[0]);
    expect(onInsertMachine).toHaveBeenCalledWith('office-pc');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
