/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent } from '@testing-library/preact';

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
});
