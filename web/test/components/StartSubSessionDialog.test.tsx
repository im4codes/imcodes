/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';

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

  it('defaults to claude-code-sdk and keeps sdk options on the left', () => {
    const { container } = render(
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

    const activeBtn = container.querySelector('.subsession-type-btn.active') as HTMLButtonElement | null;
    expect(activeBtn?.textContent).toMatch(/claude_code_sdk/i);

    const typeButtons = Array.from(container.querySelectorAll('.subsession-type-btn')).map((el) => el.textContent ?? '');
    expect(typeButtons.indexOf('⚡ claude_code_sdk')).toBeLessThan(typeButtons.indexOf('⚡ Claude Code'));
    expect(typeButtons.indexOf('📦 codex_sdk')).toBeLessThan(typeButtons.indexOf('📦 Codex'));
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
    fireEvent.input(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, { thinking: 'high' });
  });

  it('does not show CC preset controls for claude-code-sdk sub-sessions', () => {
    const onStart = vi.fn();
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          { name: 'MiniMax', env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' } },
        ],
      });
      return () => {};
    });

    render(
      <StartSubSessionDialog
        ws={ws as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('API Provider')).toBeNull();
  });

  it('shows CC preset controls and passes preset for qwen sub-sessions', async () => {
    const onStart = vi.fn();
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          { name: 'MiniMax', env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' } },
        ],
      });
      return () => {};
    });

    render(
      <StartSubSessionDialog
        ws={ws as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /qwen/i }));
    await waitFor(() => expect(screen.getByText('API Provider')).toBeDefined());
    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    presetSelect!.value = 'MiniMax';
    fireEvent.input(presetSelect!, { target: { value: presetSelect!.value } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('qwen', undefined, '/tmp', undefined, {
      ccPreset: 'MiniMax',
      thinking: 'high',
    });
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
    fireEvent.input(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('qwen', undefined, '/tmp', undefined, { thinking: 'high' });
  });
});
