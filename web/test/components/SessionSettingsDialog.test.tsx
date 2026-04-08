/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';

const patchSessionMock = vi.fn();
const patchSubSessionMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/api.js', () => ({
  patchSession: (...args: unknown[]) => patchSessionMock(...args),
  patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
}));

import { SessionSettingsDialog } from '../../src/components/SessionSettingsDialog.js';

describe('SessionSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('submits main-session type changes via patchSession', async () => {
    const onSaved = vi.fn();
    render(
      <SessionSettingsDialog
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="claude-code"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'claude-code-sdk' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', {
        agentType: 'claude-code-sdk',
      });
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-code-sdk' }));
  });

  it('submits sub-session type changes via patchSubSession', async () => {
    const onSaved = vi.fn();
    render(
      <SessionSettingsDialog
        serverId="srv-1"
        sessionName="deck_sub_abcd1234"
        subSessionId="abcd1234"
        label="Worker"
        description=""
        cwd="/proj"
        type="codex"
        parentSession="deck_proj_brain"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'codex-sdk' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSubSessionMock).toHaveBeenCalledWith('srv-1', 'abcd1234', {
        type: 'codex-sdk',
      });
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex-sdk' }));
  });
});
