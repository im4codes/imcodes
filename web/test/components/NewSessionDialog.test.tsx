/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, _opts?: Record<string, unknown>) => {
      // Return last segment of key as simple translation
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

import { NewSessionDialog } from '../../src/components/NewSessionDialog.js';

const makeWs = () => ({
  sendSessionCommand: vi.fn(),
  connected: true,
  onMessage: vi.fn().mockReturnValue(() => {}),
  subSessionDetectShells: vi.fn(),
});

describe('NewSessionDialog', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders project name input', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(screen.getByPlaceholderText('my-project')).toBeDefined();
  });

  it('renders working directory input', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(screen.getByPlaceholderText('~/projects/my-project')).toBeDefined();
  });

  it('renders agent type selector', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(select).toBeDefined();
  });

  it('agent type selector orders sdk agents before cli agents', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options.slice(0, 4)).toEqual([
      'claude-code-sdk',
      'claude-code',
      'codex-sdk',
      'codex',
    ]);
  });

  it('defaults agent type to claude-code-sdk', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(select.value).toBe('claude-code-sdk');
    expect(screen.getByText('agent_flavor_sdk')).toBeDefined();
  });

  it('cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submit with valid inputs calls ws.sendSessionCommand with correct payload', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'my-app' },
    });
    fireEvent.input(screen.getByPlaceholderText('~/projects/my-project'), {
      target: { value: '~/projects/my-app' },
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', {
      project: 'my-app',
      dir: '~/projects/my-app',
      agentType: 'claude-code-sdk',
      thinking: 'high',
    });
  });

  it('shows error when submitting with empty project name', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    // Clear the project field (it's empty by default)
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    // t('new_session.project_required') → 'project_required' via mock
    expect(screen.getByText('project_required')).toBeDefined();
  });

  it('shows error when not connected', () => {
    const ws = { sendSessionCommand: vi.fn(), connected: false, onMessage: vi.fn().mockReturnValue(() => {}) };
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'my-app' },
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    // t('new_session.daemon_offline') → 'daemon_offline' via mock
    expect(screen.getByText('daemon_offline')).toBeDefined();
  });

  it('agent type changes when selector is updated', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    select.value = 'codex';
    fireEvent.input(select, { target: { value: select.value } });
    await waitFor(() => expect(select.value).toBe('codex'));

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test-proj' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex',
    }));
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const dialog = container.querySelector('[role="dialog"]')!;
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking the backdrop calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const backdrop = container.querySelector('[role="dialog"]')!;
    // Simulate clicking the backdrop element itself (currentTarget === target)
    fireEvent.click(backdrop, { target: backdrop });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('matches started events for non-ASCII project names deterministically', () => {
    const ws = makeWs();
    const onClose = vi.fn();
    const onSessionStarted = vi.fn();
    render(<NewSessionDialog ws={ws as any} onClose={onClose} onSessionStarted={onSessionStarted} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: '测试' },
    });
    fireEvent.input(screen.getByPlaceholderText('~/projects/my-project'), {
      target: { value: '~/projects/test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '测试',
      agentType: 'claude-code-sdk',
    }));

    const handler = ws.onMessage.mock.calls.at(-1)?.[0];
    expect(typeof handler).toBe('function');
    handler?.({
      type: 'session.event',
      event: 'started',
      session: 'deck_u6d4b_u8bd5_brain',
      state: 'idle',
    });

    expect(onSessionStarted).toHaveBeenCalledWith('deck_u6d4b_u8bd5_brain');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows cli/sdk difference hint when switching agent type', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    expect(screen.getByText('agent_flavor_sdk')).toBeDefined();

    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    select.value = 'claude-code';
    fireEvent.input(select, { target: { value: select.value } });

    await waitFor(() => expect(screen.getByText('agent_flavor_cli')).toBeDefined());
  });

  it('includes thinking level when starting codex-sdk', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/projects/my-project'), { target: { value: '~/projects/my-app' } });
    const agentTypeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    agentTypeSelect.value = 'codex-sdk';
    fireEvent.input(agentTypeSelect, { target: { value: agentTypeSelect.value } });
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[1], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex-sdk',
      thinking: 'high',
    }));
  });

  it('does not show CC preset controls for claude-code-sdk', () => {
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

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    expect(screen.queryByText('API Provider')).toBeNull();
  });

  it('shows CC preset controls and submits preset for qwen', async () => {
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

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    const agentTypeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    agentTypeSelect.value = 'qwen';
    fireEvent.input(agentTypeSelect, { target: { value: agentTypeSelect.value } });
    await waitFor(() => expect(screen.getByText('API Provider')).toBeDefined());
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/projects/my-project'), { target: { value: '~/projects/my-app' } });

    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    presetSelect!.value = 'MiniMax';
    fireEvent.input(presetSelect!, { target: { value: presetSelect!.value } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'qwen',
      ccPreset: 'MiniMax',
      thinking: 'high',
    }));
  });

  it('includes thinking level when starting qwen', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/projects/my-project'), { target: { value: '~/projects/my-app' } });
    const agentTypeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    agentTypeSelect.value = 'qwen';
    fireEvent.input(agentTypeSelect, { target: { value: agentTypeSelect.value } });
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[1], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'qwen',
      thinking: 'high',
    }));
  });
});
