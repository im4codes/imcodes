/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickAgentDelegationDialog } from '../src/components/QuickAgentDelegationDialog.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('QuickAgentDelegationDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  const candidates = [
    {
      sessionName: 'deck_sub_hidden-internal-id',
      agentType: 'claude-code-sdk',
      label: null,
      model: 'claude-opus-4-7',
      state: 'idle',
    },
    {
      sessionName: 'deck_sub_reviewer',
      agentType: 'codex-sdk',
      label: 'Reviewer',
      model: 'gpt-5.6',
      state: 'running',
      teamMember: true,
    },
  ];

  it('shows only type, user label, model and state while hiding internal session names', () => {
    render(
      <QuickAgentDelegationDialog
        currentSessionName="deck_project_brain"
        candidates={candidates}
        onClose={vi.fn()}
        onDispatch={vi.fn()}
      />,
    );

    const dialog = screen.getByTestId('quick-agent-delegation-dialog');
    expect(dialog.textContent).toContain('CC');
    expect(dialog.textContent).toContain('Reviewer');
    expect(dialog.textContent).toContain('claude-opus-4-7');
    expect(dialog.textContent).toContain('gpt-5.6');
    expect(dialog.textContent).toContain('session.p2p_tag');
    expect(dialog.outerHTML).not.toContain('deck_');
  });

  it('dispatches immediately when an agent is clicked and supports custom tasks without confirmation', () => {
    const onDispatch = vi.fn();
    render(
      <QuickAgentDelegationDialog
        currentSessionName="deck_project_brain"
        candidates={candidates}
        onClose={vi.fn()}
        onDispatch={onDispatch}
      />,
    );

    fireEvent.click(screen.getByText('peerAuditQuick.mode.custom'));
    fireEvent.input(screen.getByTestId('quick-agent-delegation-custom'), { target: { value: 'Review the retry race only.' } });
    fireEvent.click(screen.getAllByTestId('quick-agent-delegation-candidate')[1]!);

    expect(onDispatch).toHaveBeenCalledWith({
      sessionName: 'deck_sub_reviewer',
      label: 'Reviewer',
      task: 'Review the retry race only.',
    });
    const stored = [...Array(localStorage.length)].map((_, index) => {
      const key = localStorage.key(index) ?? '';
      return `${key}:${localStorage.getItem(key) ?? ''}`;
    }).join('\n');
    expect(stored).not.toContain('deck_');
    expect(screen.queryByTestId('quick-agent-delegation-dispatch')).toBeNull();
  });

  it('uses the audit preset by default on the first candidate click', () => {
    const onDispatch = vi.fn();
    render(
      <QuickAgentDelegationDialog
        currentSessionName="deck_project_brain"
        candidates={candidates}
        onClose={vi.fn()}
        onDispatch={onDispatch}
      />,
    );

    fireEvent.click(screen.getAllByTestId('quick-agent-delegation-candidate')[0]!);

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch.mock.calls[0]?.[0].task).toContain('independently audit this session\'s most recent work');
  });

  it.each([
    ['discussion', 'challenge the approach'],
    ['brainstorm', 'practical alternatives'],
  ] as const)('wires the %s preset into immediate delegation', (preset, expectedText) => {
    const onDispatch = vi.fn();
    render(
      <QuickAgentDelegationDialog
        currentSessionName="deck_project_brain"
        candidates={candidates}
        onClose={vi.fn()}
        onDispatch={onDispatch}
      />,
    );
    fireEvent.click(screen.getByText(`peerAuditQuick.mode.${preset}`));
    fireEvent.click(screen.getAllByTestId('quick-agent-delegation-candidate')[0]!);
    expect(onDispatch.mock.calls[0]?.[0].task).toContain(expectedText);
  });

  it('sanitizes embedded internal ids and disables unavailable sessions', () => {
    const onDispatch = vi.fn();
    render(
      <QuickAgentDelegationDialog
        currentSessionName="deck_project_brain"
        candidates={[
          { sessionName: 'deck_sub_one', agentType: 'codex-sdk', label: 'note deck_sub_secret', model: 'gpt-5.6', state: 'idle' },
          { sessionName: 'deck_sub_two', agentType: 'codex-sdk', label: null, model: 'gpt-5.6', state: 'stopped' },
        ]}
        error="send failed"
        onClose={vi.fn()}
        onDispatch={onDispatch}
      />,
    );
    const dialog = screen.getByTestId('quick-agent-delegation-dialog');
    expect(dialog.outerHTML).not.toContain('deck_');
    expect(screen.getByRole('alert').textContent).toBe('send failed');
    const rows = screen.getAllByTestId('quick-agent-delegation-candidate') as HTMLButtonElement[];
    expect(rows[0]!.textContent).toContain('Cx 1');
    expect(rows[1]!.textContent).toContain('Cx 2');
    expect(rows[1]!.disabled).toBe(true);
    fireEvent.click(rows[1]!);
    expect(onDispatch).not.toHaveBeenCalled();
  });
});
