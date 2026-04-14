/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'quick_input.tab_quick': 'Quick',
        'quick_input.add_command': 'Add command',
        'quick_input.add_phrase': 'Add phrase',
        'quick_input.clear_history': 'Clear history',
        'quick_input.loading': 'Loading',
        'quick_input.commands': 'Commands',
        'quick_input.phrases': 'Phrases',
        'quick_input.history': 'History',
        'quick_input.this_session': 'This session',
        'quick_input.all': 'All',
        'quick_input.no_history_session': 'No session history',
        'quick_input.no_history': 'No history',
        'quick_input.newer': 'Newer',
        'quick_input.older': 'Older',
        'quick_input.confirm_delete': 'Delete?',
        'quick_input.label_command': 'Command',
        'quick_input.label_phrase': 'Phrase',
        'quick_input.placeholder_phrase': 'phrase',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));

import { QuickInputPanel, type QuickData } from '../../src/components/QuickInputPanel.js';

describe('QuickInputPanel history scope', () => {
  const defaultWidth = window.innerWidth;
  const defaultHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: defaultWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: defaultHeight });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: defaultWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: defaultHeight });
  });

  it('opens below the trigger when the quick-input trigger is high in the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({
      x: 248, y: 0, top: 92, left: 248, right: 328, bottom: 120, width: 80, height: 28,
      toJSON() { return {}; },
    } as DOMRect);

    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
        anchorRef={{ current: anchor }}
      />,
    );

    const panel = container.querySelector('.qp') as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).toBe('126px');
    expect(panel.style.bottom).toBe('');
    expect(panel.style.left).toBe('248px');
    expect(panel.style.width).toBe('960px');
    expect(panel.style.maxHeight).toBe('712px');
  });

  it('opens above the trigger when the quick-input trigger is low in the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({
      x: 248, y: 0, top: 700, left: 248, right: 328, bottom: 728, width: 80, height: 28,
      toJSON() { return {}; },
    } as DOMRect);

    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
        anchorRef={{ current: anchor }}
      />,
    );

    const panel = container.querySelector('.qp') as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).toBe('');
    expect(panel.style.bottom).toBe('150px');
    expect(panel.style.left).toBe('248px');
    expect(panel.style.width).toBe('960px');
    expect(panel.style.maxHeight).toBe('688px');
  });

  it('shows account-wide history when All is selected, including entries from other sessions', () => {
    const data: QuickData = {
      history: ['global shared'],
      sessionHistory: {
        'session-a': ['session a newest'],
        'session-b': ['session b newest', 'session b older'],
      },
      commands: [],
      phrases: [],
    };

    render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={data}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('session a newest')).toBeDefined();
    expect(screen.queryByText('session b newest')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.getByText('global shared')).toBeDefined();
    expect(screen.getByText('session a newest')).toBeDefined();
    expect(screen.getByText('session b newest')).toBeDefined();
    expect(screen.getByText('session b older')).toBeDefined();
  });

  it('removes a custom phrase when its delete action is confirmed', () => {
    const removePhrase = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: ['custom phrase'] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={removePhrase}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const deleteButton = container.querySelector('.qp-pill-custom .qp-pill-del') as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(confirmSpy).toHaveBeenCalledWith('Delete?');
    expect(removePhrase).toHaveBeenCalledWith('custom phrase');
    confirmSpy.mockRestore();
  });

  it('removes a custom command when its delete action is confirmed', () => {
    const removeCommand = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: ['/custom'], phrases: [] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={vi.fn()}
        onRemoveCommand={removeCommand}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const deleteButton = container.querySelector('.qp-pill-custom .qp-pill-del') as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(confirmSpy).toHaveBeenCalledWith('Delete?');
    expect(removeCommand).toHaveBeenCalledWith('/custom');
    confirmSpy.mockRestore();
  });

  it('replaces a custom phrase when edited and committed', () => {
    const addPhrase = vi.fn();
    const removePhrase = vi.fn();
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: [], phrases: ['custom phrase'] }}
        loaded
        onAddCommand={vi.fn()}
        onAddPhrase={addPhrase}
        onRemoveCommand={vi.fn()}
        onRemovePhrase={removePhrase}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const editButton = container.querySelector('.qp-pill-custom .qp-pill-edit') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    fireEvent.click(editButton!);

    const input = container.querySelector('.qp-edit-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.input(input!, { target: { value: 'updated phrase' } });
    fireEvent.keyDown(input!, { key: 'Enter' });

    expect(removePhrase).toHaveBeenCalledWith('custom phrase');
    expect(addPhrase).toHaveBeenCalledWith('updated phrase');
  });

  it('replaces a custom command when edited and committed', () => {
    const addCommand = vi.fn();
    const removeCommand = vi.fn();
    const { container } = render(
      <QuickInputPanel
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSend={vi.fn()}
        agentType="claude-code"
        sessionName="session-a"
        data={{ history: [], sessionHistory: {}, commands: ['/custom'], phrases: [] }}
        loaded
        onAddCommand={addCommand}
        onAddPhrase={vi.fn()}
        onRemoveCommand={removeCommand}
        onRemovePhrase={vi.fn()}
        onRemoveHistory={vi.fn()}
        onRemoveSessionHistory={vi.fn()}
        onClearHistory={vi.fn()}
        onClearSessionHistory={vi.fn()}
      />,
    );

    const editButton = container.querySelector('.qp-pill-custom .qp-pill-edit') as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    fireEvent.click(editButton!);

    const input = container.querySelector('.qp-edit-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.input(input!, { target: { value: '/updated' } });
    fireEvent.keyDown(input!, { key: 'Enter' });

    expect(removeCommand).toHaveBeenCalledWith('/custom');
    expect(addCommand).toHaveBeenCalledWith('/updated');
  });
});
