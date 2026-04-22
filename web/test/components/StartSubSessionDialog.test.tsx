/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'session.agentGroup.transport_sdk') return 'SDK';
      if (key === 'session.agentGroup.cli_process') return 'CLI';
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

  it('defaults to claude-code-sdk and renders transport/process groups separately', () => {
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

    const groupTitles = Array.from(container.querySelectorAll('.subsession-type-group-title')).map((el) => el.textContent?.trim());
    expect(groupTitles).toEqual(['SDK', 'CLI']);

    const groups = Array.from(container.querySelectorAll('.subsession-type-group'));
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toMatch(/claude_code_sdk/i);
    expect(groups[0].textContent).toMatch(/codex_sdk/i);
    expect(groups[0].textContent).toMatch(/copilot_sdk/i);
    expect(groups[0].textContent).toMatch(/cursor_headless/i);
    expect(groups[1].textContent).toMatch(/claude_code_cli/i);
    expect(groups[1].textContent).toMatch(/codex_cli/i);
    expect(screen.getByText('qwen_provider_hint')).toBeDefined();
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

  it('clicking the backdrop does not call onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={onClose}
      />,
    );

    const backdrop = container.querySelector('.dialog-overlay') as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!, { target: backdrop });
    expect(onClose).not.toHaveBeenCalled();
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

    expect(screen.queryByText('api_provider')).toBeNull();
  });

  it('shows the qwen provider-specific hint for qwen sub-sessions', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /qwen/i }));

    await waitFor(() => expect(screen.getByText('qwen_provider_selected_hint')).toBeDefined());
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
    await waitFor(() => expect(screen.getByText('api_provider')).toBeDefined());
    expect(screen.getByText('qwen_provider_selected_hint')).toBeDefined();
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

  it('prefills default qwen preset values instead of leaving placeholders only', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /qwen/i }));
    await waitFor(() => expect(screen.getByText('api_provider')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /api_provider_add_edit/i }));

    expect(screen.getByDisplayValue('https://api.minimax.io/anthropic')).toBeDefined();
    expect(screen.getByDisplayValue('MiniMax-M2.7')).toBeDefined();
    expect(screen.getByDisplayValue('API_TIMEOUT_MS')).toBeDefined();
    expect(screen.getByDisplayValue('3000000')).toBeDefined();
    expect(screen.getByDisplayValue('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBeDefined();
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

  it('passes requestedModel for copilot-sdk sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /copilot_sdk/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'gpt-5.4-mini' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('copilot-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'gpt-5.4-mini',
      thinking: 'high',
    });
  });

  it('passes requestedModel for cursor-headless sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /cursor_headless/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'gpt-5.2' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('cursor-headless', undefined, '/tmp', undefined, {
      requestedModel: 'gpt-5.2',
    });
  });
});
