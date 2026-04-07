/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

import { StartSubSessionDialog } from '../../src/components/StartSubSessionDialog.js';

const makeWs = () => ({
  onMessage: vi.fn().mockReturnValue(() => {}),
  subSessionDetectShells: vi.fn(),
  send: vi.fn(),
});

describe('StartSubSessionDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows claude-code-sdk and codex-sdk options', () => {
    render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /claude_code_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /codex_sdk/i })).toBeDefined();
  });

  it('defaults level to high for supported transports', () => {
    render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[0].value).toBe('high');
  });

  it('passes thinking level for codex-sdk sub-sessions', () => {
    const onStart = vi.fn();
    render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, { thinking: 'high' });
  });

  it('passes thinking level for qwen sub-sessions', () => {
    const onStart = vi.fn();
    render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /qwen/i }));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('qwen', undefined, '/tmp', undefined, { thinking: 'high' });
  });
});
