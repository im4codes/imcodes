/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/preact';
import { CODEX_MODEL_IDS, selectLatestCodexSolModel } from '../../../src/shared/models/options.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '../../../shared/agy-agent.js';
import { __clearTransportModelCacheForTests } from '../../src/hooks/useTransportModels.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../../shared/hermes-agent.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE } from '../../../shared/agent-types.js';

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

import { StartSubSessionDialog, resolveDefaultSubSessionType } from '../../src/components/StartSubSessionDialog.js';

const makeWs = () => ({
  onMessage: vi.fn().mockReturnValue(() => {}),
  subSessionDetectShells: vi.fn(),
  send: vi.fn(),
});

describe('StartSubSessionDialog', () => {
  afterEach(() => {
    localStorage.clear();
    __clearTransportModelCacheForTests();
    cleanup();
  });

  it('shows Claude, Codex, Qoder, OpenCode, Grok, Hermes, DeepSeek Harness, and Pi options', () => {
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
    expect(screen.getByRole('button', { name: /qoder_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /opencode_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /grok_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /agy_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /hermes_agent/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /deepseek_harness/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^pi$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /cc_cli_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini cli/i })).toBeNull();
  });

  it.each([
    { allowedAgentTypes: undefined },
    { allowedAgentTypes: [CLAUDE_CODE_CLI_SDK_AGENT_TYPE, 'gemini-sdk', 'gemini', 'claude-code-sdk', 'claude-code'] },
  ])('never restores unavailable CC CLI SDK, Gemini SDK, or Gemini CLI via an allow-list (%j)', async ({ allowedAgentTypes }) => {
    const onStart = vi.fn();
    const { container } = render(
      <StartSubSessionDialog ws={makeWs() as any} defaultCwd="/tmp" allowedAgentTypes={allowedAgentTypes}
        isProviderConnected={() => false} getRemoteSessions={() => []} refreshSessions={vi.fn()}
        onStart={onStart} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /cc_cli_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini cli/i })).toBeNull();
    for (const hiddenType of [CLAUDE_CODE_CLI_SDK_AGENT_TYPE, 'gemini-sdk', 'gemini']) {
      const unavailable = container.querySelector<HTMLButtonElement>(`[data-agent-type="${hiddenType}"]`);
      if (unavailable) {
        expect(unavailable.style.display).toBe('none');
        expect(unavailable.disabled).toBe(true);
        fireEvent.click(unavailable);
      }
    }
    fireEvent.click(screen.getByRole('button', { name: /claude_code_sdk/i }));
    await waitFor(() => expect(container.querySelector('.session-agent-card.active')?.getAttribute('data-agent-type')).toBe('claude-code-sdk'));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onStart).toHaveBeenLastCalledWith('claude-code-sdk', undefined, '/tmp', undefined, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: /claude_code_cli/i }));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onStart).toHaveBeenLastCalledWith('claude-code', undefined, '/tmp', undefined, undefined);
  });

  it.each([
    [CLAUDE_CODE_CLI_SDK_AGENT_TYPE],
    ['gemini-sdk'],
    ['gemini'],
    ['gemini-sdk', 'gemini'],
  ])('cannot launch when the only allowed types are unavailable (%j)', (...allowedAgentTypes) => {
    const onStart = vi.fn();
    render(<StartSubSessionDialog ws={makeWs() as any} defaultCwd="/tmp"
      allowedAgentTypes={allowedAgentTypes} isProviderConnected={() => false}
      getRemoteSessions={() => []} refreshSessions={vi.fn()} onStart={onStart} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /cc_cli_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini cli/i })).toBeNull();
    const launch = screen.getByRole('button', { name: /launch/i }) as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
    fireEvent.click(launch);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('defaults to agy-sdk and renders transport/process groups separately', () => {
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

    const activeBtn = container.querySelector('.session-agent-card.active') as HTMLButtonElement | null;
    expect(activeBtn?.getAttribute('data-agent-type')).toBe(AGY_SDK_PROVIDER_ID);
    expect(activeBtn?.textContent).toMatch(/agy_sdk/i);

    const groupTitles = Array.from(container.querySelectorAll('.session-agent-group-title')).map((el) => el.textContent?.trim());
    expect(groupTitles).toEqual(['SDK', 'CLI']);

    const groups = Array.from(container.querySelectorAll('.session-agent-group'));
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toMatch(/claude_code_sdk/i);
    expect(groups[0].textContent).toMatch(/codex_sdk/i);
    expect(groups[0].textContent).toMatch(/qoder_sdk/i);
    expect(groups[0].textContent).toMatch(/copilot_sdk/i);
    expect(groups[0].textContent).toMatch(/cursor_headless/i);
    expect(groups[1].textContent).toMatch(/claude_code_cli/i);
    expect(groups[1].textContent).toMatch(/codex_cli/i);
    expect(screen.getByText('qwen_provider_hint')).toBeDefined();
  });

  it('can reuse the launcher for a supervision pool without exposing unsupported session types', () => {
    const { container } = render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        allowedAgentTypes={['claude-code-sdk', 'codex-sdk', 'qwen', 'openclaw']}
        overlayClassName="session-settings-child-overlay"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(container.querySelector('.session-settings-child-overlay')).toBeTruthy();
    expect(screen.getByRole('button', { name: /claude_code_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /codex_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^qwen$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^openclaw$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /qoder_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /codex_cli/i })).toBeNull();
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
    const expectedFallback = selectLatestCodexSolModel(CODEX_MODEL_IDS)!;
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

    expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, {
      requestedModel: expectedFallback,
      thinking: 'high',
    });
  });

  it('locks sub-session cwd to the current directory', () => {
    render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp/current"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const cwdInput = screen.getByPlaceholderText('subsessionWorkingDirectoryPlaceholder') as HTMLInputElement;
    expect(cwdInput.value).toBe('/tmp/current');
    expect(cwdInput.disabled).toBe(true);
    expect(screen.queryByTitle('Browse')).toBeNull();
    expect(screen.queryByPlaceholderText('git_remote_url_placeholder')).toBeNull();
  });

  it('passes requestedModel for codex-sdk sub-sessions', () => {
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
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'gpt-5.5' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'gpt-5.5',
      thinking: 'high',
    });
  });

  it('replaces the Claude default with the latest Codex Sol default when switching to codex-sdk', async () => {
    const onStart = vi.fn();
    const expectedFallback = selectLatestCodexSolModel(CODEX_MODEL_IDS)!;
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
    const modelInput = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    await waitFor(() => expect(modelInput.value).toBe(expectedFallback));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, {
      requestedModel: expectedFallback,
      thinking: 'high',
    });
  });

  it('starts qoder-sdk sub-sessions without proof-gated model or thinking extras', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /qoder_sdk/i }));
    expect(screen.queryByText('thinking')).toBeNull();
    expect(screen.queryByText('model')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('qoder-sdk', undefined, '/tmp', undefined, undefined);
  });

  it('passes a provider-qualified model for OpenCode SDK sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /opencode_sdk/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'anthropic/claude-sonnet-4-5' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('opencode-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'anthropic/claude-sonnet-4-5',
    });
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

  it('selects a CC SDK model from one preset for a sub-session', async () => {
    const onStart = vi.fn();
    const handlers = new Set<(msg: unknown) => void>();
    const ws = {
      ...makeWs(),
      connected: true,
      onMessage: vi.fn((handler: (msg: unknown) => void) => {
        handlers.add(handler);
        handler({
          type: 'cc.presets.list_response',
          presets: [{
            name: 'MiniMax',
            env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
            availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3' }],
          }],
        });
        return () => handlers.delete(handler);
      }),
    };

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

    fireEvent.click(screen.getByRole('button', { name: /claude_code_sdk/i }));
    // Third-party CC presets run via the CC SDK transport.
    expect(screen.getByText('api_provider')).toBeDefined();

    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    presetSelect!.value = 'MiniMax';
    fireEvent.input(presetSelect!, { target: { value: presetSelect!.value } });
    const modelSelect = await waitFor(() => {
      const found = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax-M3'));
      expect(found).toBeDefined();
      return found!;
    });
    fireEvent.input(modelSelect, { target: { value: 'MiniMax-M3' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith(
      'claude-code-sdk', undefined, '/tmp', undefined,
      expect.objectContaining({ ccPreset: 'MiniMax', requestedModel: 'MiniMax-M3' }),
    );
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.list_models',
      agentType: 'claude-code-sdk',
      ccPreset: 'MiniMax',
    }));
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

    // qwen's card is intentionally hidden (display: none) from the default
    // picker now -- still a real, clickable DOM node. getByRole's `name`
    // match can't find it even with `hidden: true`: accessible-name
    // computation excludes text from display:none descendants regardless of
    // that option, which only bypasses the "is this role excluded" gate, not
    // name computation. A plain attribute query sidesteps that entirely,
    // without changing what the test actually verifies.
    fireEvent.click(document.querySelector('[data-agent-type="qwen"]') as HTMLButtonElement);

    await waitFor(() => expect(screen.getByText('qwen_provider_selected_hint')).toBeDefined());
  });

  it('shows CC preset controls and passes preset for qwen sub-sessions', async () => {
    const onStart = vi.fn();
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          {
            name: 'MiniMax',
            env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
            defaultModel: 'MiniMax-M2.7',
            availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-Text-01' }],
          },
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

    // qwen's card is intentionally hidden (display: none) from the default
    // picker now -- still a real, clickable DOM node. getByRole's `name`
    // match can't find it even with `hidden: true`: accessible-name
    // computation excludes text from display:none descendants regardless of
    // that option, which only bypasses the "is this role excluded" gate, not
    // name computation. A plain attribute query sidesteps that entirely,
    // without changing what the test actually verifies.
    fireEvent.click(document.querySelector('[data-agent-type="qwen"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());
    expect(screen.getByText('qwen_provider_selected_hint')).toBeDefined();
    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    presetSelect!.value = 'MiniMax';
    fireEvent.input(presetSelect!, { target: { value: presetSelect!.value } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('qwen', undefined, '/tmp', undefined, {
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M2.7',
      thinking: 'high',
    });
  });

  it('custom provider SDK allows selecting dsh from the SDK-compatible types and passes the selected preset', async () => {
    const onStart = vi.fn();
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          {
            name: 'MiniMax',
            env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
            defaultModel: 'MiniMax-M2.7',
            availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-Text-01' }],
          },
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

    fireEvent.click(screen.getByLabelText(/custom_provider_sdk/i));

    await waitFor(() => expect(screen.getByRole('button', { name: /claude_code_sdk/i }).className).toContain('active'));
    // Non-supported types (e.g., gemini-sdk) are filtered out and no longer rendered.
    expect(screen.queryByRole('button', { name: /gemini_sdk/i })).toBeNull();
    expect(screen.getByRole('button', { name: /codex_sdk/i })).toBeDefined();
    // dsh (deepseek-harness) is now a visible, selectable button when custom provider SDK is on.
    const dshBtn = screen.getByRole('button', { name: /deepseek_harness/i }) as HTMLButtonElement;
    expect(dshBtn.disabled).toBe(false);
    expect(screen.getByText('custom_provider_preset')).toBeDefined();

    // Select dsh and launch the sub-session; the preset should still be passed through.
    fireEvent.click(dshBtn);
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('deepseek-harness', undefined, '/tmp', undefined, expect.objectContaining({
      ccPreset: 'MiniMax',
    }));
  });

  it('opens third-party API selection from an incompatible sub-session agent and keeps the switch mounted', async () => {
    const onStart = vi.fn();
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          { name: 'Provider A', env: { ANTHROPIC_MODEL: 'a-model' }, defaultModel: 'a-model' },
          { name: 'Provider B', env: { ANTHROPIC_MODEL: 'b-model' }, defaultModel: 'b-model' },
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

    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const toggle = screen.getByLabelText(/custom_provider_sdk/i) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);

    const presetSelect = await waitFor(() => {
      const candidate = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((select) => Array.from(select.options).some((option) => option.value === 'Provider B'));
      expect(candidate).toBeDefined();
      expect((screen.getByLabelText(/custom_provider_sdk/i) as HTMLInputElement).checked).toBe(true);
      return candidate!;
    });
    fireEvent.input(presetSelect, { target: { value: 'Provider B' } });
    fireEvent.click(screen.getByRole('button', { name: /^pi$/i }));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('pi', undefined, '/tmp', undefined, expect.objectContaining({
      ccPreset: 'Provider B',
      requestedModel: 'b-model',
    }));
  });

  it('shows a toast when qwen sub-session preset JSON is copied to the clipboard', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const onToast = vi.fn();
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          {
            name: 'MiniMax',
            env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
            defaultModel: 'MiniMax-M2.7',
          },
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
        onStart={vi.fn()}
        onClose={vi.fn()}
        onToast={onToast}
      />,
    );

    // qwen's card is intentionally hidden (display: none) from the default
    // picker now -- still a real, clickable DOM node. getByRole's `name`
    // match can't find it even with `hidden: true`: accessible-name
    // computation excludes text from display:none descendants regardless of
    // that option, which only bypasses the "is this role excluded" gate, not
    // name computation. A plain attribute query sidesteps that entirely,
    // without changing what the test actually verifies.
    fireEvent.click(document.querySelector('[data-agent-type="qwen"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /api_provider_add_edit/i }));
    fireEvent.click(screen.getByRole('button', { name: 'api_provider_export_json' }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledOnce();
    });
    expect(JSON.parse(clipboardWriteText.mock.calls[0][0])).toMatchObject({ name: 'MiniMax' });
    expect(onToast).toHaveBeenCalledWith('api_provider_export_success');
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

    // qwen's card is intentionally hidden (display: none) from the default
    // picker now -- still a real, clickable DOM node. getByRole's `name`
    // match can't find it even with `hidden: true`: accessible-name
    // computation excludes text from display:none descendants regardless of
    // that option, which only bypasses the "is this role excluded" gate, not
    // name computation. A plain attribute query sidesteps that entirely,
    // without changing what the test actually verifies.
    fireEvent.click(document.querySelector('[data-agent-type="qwen"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /api_provider_add_edit/i }));

    expect(screen.getByDisplayValue('https://api.minimax.io/anthropic')).toBeDefined();
    expect(screen.getByDisplayValue('MiniMax-M2.7')).toBeDefined();
    expect(screen.getByDisplayValue('API_TIMEOUT_MS')).toBeDefined();
    expect(screen.getByDisplayValue('3000000')).toBeDefined();
    expect(screen.getByDisplayValue('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBeDefined();
  });

  it('saves OpenAI compatible preset when selected in subsession preset editor', async () => {
    const ws = makeWs();
    render(
      <StartSubSessionDialog
        ws={ws as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(document.querySelector('[data-agent-type="qwen"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /api_provider_add_edit/i }));

    const openaiRadio = screen.getByLabelText(/OpenAI Compatible/i);
    fireEvent.click(openaiRadio);

    expect((screen.getByDisplayValue('https://api.minimax.chat/v1') as HTMLInputElement)).toBeDefined();
    expect((screen.getByDisplayValue('MiniMax-Text-01') as HTMLInputElement)).toBeDefined();

    fireEvent.input(screen.getByPlaceholderText('e.g. MiniMax'), { target: { value: 'OpenAI-Sub' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cc.presets.save',
      requestId: expect.any(String),
      presets: [
        expect.objectContaining({
          name: 'OpenAI-Sub',
          authType: 'openai',
          defaultModel: 'MiniMax-Text-01',
          env: expect.objectContaining({
            OPENAI_BASE_URL: 'https://api.minimax.chat/v1',
            OPENAI_MODEL: 'MiniMax-Text-01',
          }),
        }),
      ],
    }));
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

    // qwen's card is intentionally hidden (display: none) from the default
    // picker now -- still a real, clickable DOM node. getByRole's `name`
    // match can't find it even with `hidden: true`: accessible-name
    // computation excludes text from display:none descendants regardless of
    // that option, which only bypasses the "is this role excluded" gate, not
    // name computation. A plain attribute query sidesteps that entirely,
    // without changing what the test actually verifies.
    fireEvent.click(document.querySelector('[data-agent-type="qwen"]') as HTMLButtonElement);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('qwen', undefined, '/tmp', undefined, { thinking: 'high' });
  });

  it('omits launchCount for the default quantity of one, keeping a single launch unchanged', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(AGY_SDK_PROVIDER_ID, undefined, '/tmp', undefined, {
      requestedModel: AGY_DEFAULT_MODEL_ID,
    });
    const extra = onStart.mock.calls[0]?.[4] as Record<string, unknown> | undefined;
    expect(extra).not.toHaveProperty('launchCount');
  });

  it('passes launchCount when a quantity greater than one is requested', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /claude_code_sdk/i }));
    fireEvent.input(screen.getByLabelText('launch_count'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith('claude-code-sdk', undefined, '/tmp', undefined,
      expect.objectContaining({ launchCount: 3 }));
  });

  it('clamps an out-of-range quantity into [1, MAX] instead of trusting raw input', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /claude_code_sdk/i }));
    fireEvent.input(screen.getByLabelText('launch_count'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('claude-code-sdk', undefined, '/tmp', undefined,
      expect.objectContaining({ launchCount: 20 }));
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

  it('passes requestedModel for kimi-sdk sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /kimi_sdk/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'moonshot-v1-auto,thinking' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('kimi-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'moonshot-v1-auto,thinking',
    });
  });

  it('passes requestedModel for Hermes ACP sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /hermes_agent/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'nous-free' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith(HERMES_AGENT_PROVIDER_ID, undefined, '/tmp', undefined, {
      requestedModel: 'nous-free',
    });
  });

  it('passes requestedModel for deepseek-harness sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /deepseek_harness/i }));
    // The daemon catalogue for `dsh` is always empty, so the picker is free text.
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'deepseek-reasoner' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('deepseek-harness', undefined, '/tmp', undefined, {
      requestedModel: 'deepseek-reasoner',
    });
  });

  it('passes a dynamically selected model for grok-sdk sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /grok_sdk/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'grok-build' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith('grok-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'grok-build',
    });
  });

  it('shows Antigravity sub-session options while disconnected', async () => {
    render(<StartSubSessionDialog ws={Object.assign(makeWs(), { connected: false }) as any} defaultCwd="/tmp" isProviderConnected={() => false} getRemoteSessions={() => []} refreshSessions={vi.fn()} onStart={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /agy_sdk/i }));
    const input = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    act(() => input.focus());
    await waitFor(() => expect(screen.getByRole('option', { name: 'gemini-4-hydrogen-high' })).toBeDefined());
    expect(input.value).toBe('gemini-4-hydrogen-high');
  });

  it('replaces Antigravity sub-session fallback options with the refreshed catalog', async () => {
    const handlers = new Set<(message: unknown) => void>();
    const ws = { ...makeWs(), connected: true, onMessage: (cb: (message: unknown) => void) => { handlers.add(cb); return () => handlers.delete(cb); } };
    render(<StartSubSessionDialog ws={ws as any} defaultCwd="/tmp" isProviderConnected={() => false} getRemoteSessions={() => []} refreshSessions={vi.fn()} onStart={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /agy_sdk/i }));
    const request = ws.send.mock.calls.find(([msg]) => msg.type === 'transport.list_models' && msg.agentType === AGY_SDK_PROVIDER_ID)?.[0];
    expect(request).toBeDefined();
    act(() => handlers.forEach(cb => cb({ type: 'transport.models_response', agentType: AGY_SDK_PROVIDER_ID, requestId: request.requestId, models: [{ id: 'gemini-3.8-flash-high' }, { id: 'new-live-model' }], defaultModel: 'gemini-3.8-flash-high' })));
    act(() => (screen.getByPlaceholderText('selectModel') as HTMLInputElement).focus());
    await waitFor(() => expect(screen.getByRole('option', { name: 'new-live-model' })).toBeDefined());
    expect(screen.queryByRole('option', { name: 'gemini-4-argon-medium' })).toBeNull();
  });

  it('passes a dynamically selected model for agy-sdk sub-sessions', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /agy_sdk/i }));
    fireEvent.input(screen.getByPlaceholderText('selectModel'), { target: { value: 'gemini-2.5-pro' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    expect(onStart).toHaveBeenCalledWith(AGY_SDK_PROVIDER_ID, undefined, '/tmp', undefined, {
      requestedModel: 'gemini-2.5-pro',
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

  it('defaults agy-sdk sub-sessions to gemini-4-hydrogen-high over upstream carbon-medium and remembers user-selected AGY models on reopen', async () => {
    const handlers = new Set<(message: unknown) => void>();
    const ws1 = {
      ...makeWs(),
      connected: true,
      onMessage: (cb: (message: unknown) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
    };
    const onStart1 = vi.fn();
    const first = render(
      <StartSubSessionDialog
        ws={ws1 as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart1}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /agy_sdk/i }));
    const req1 = ws1.send.mock.calls.find(([msg]) => msg.type === 'transport.list_models' && msg.agentType === AGY_SDK_PROVIDER_ID)?.[0];
    act(() => handlers.forEach((cb) => cb({
      type: 'transport.models_response',
      agentType: AGY_SDK_PROVIDER_ID,
      requestId: req1?.requestId,
      models: [
        { id: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
        { id: AGY_DEFAULT_MODEL_ID, name: 'Gemini 4 Hydrogen (High)' },
        { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      ],
      defaultModel: 'gemini-4-carbon-medium',
      isAuthenticated: true,
    })));

    const input1 = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    await waitFor(() => expect(input1.value).toBe(AGY_DEFAULT_MODEL_ID));

    fireEvent.input(input1, { target: { value: 'claude-opus-5-5-high' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onStart1).toHaveBeenCalledWith(AGY_SDK_PROVIDER_ID, undefined, '/tmp', undefined, {
      requestedModel: 'claude-opus-5-5-high',
    });
    expect(localStorage.getItem('imcodes-agy-model')).toBe('claude-opus-5-5-high');

    first.unmount();

    // Reopening StartSubSessionDialog pre-fills the remembered claude-opus-5-5-high model:
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
    fireEvent.click(screen.getByRole('button', { name: /agy_sdk/i }));
    const input2 = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    await waitFor(() => expect(input2.value).toBe('claude-opus-5-5-high'));
  });

  it('defaults to agy-sdk and launches immediately with the default AGY model', () => {
    const onStart = vi.fn();
    const { container } = render(
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

    const activeBtn = container.querySelector('.session-agent-card.active') as HTMLButtonElement | null;
    expect(activeBtn?.getAttribute('data-agent-type')).toBe(AGY_SDK_PROVIDER_ID);

    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onStart).toHaveBeenCalledWith(AGY_SDK_PROVIDER_ID, undefined, '/tmp', undefined, {
      requestedModel: AGY_DEFAULT_MODEL_ID,
    });
  });

  it('falls back to the first selectable allowed agent type when allowedAgentTypes excludes agy-sdk', () => {
    const onStart = vi.fn();
    const { container } = render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        allowedAgentTypes={['codex-sdk', 'claude-code-sdk']}
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

    const activeBtn = container.querySelector('.session-agent-card.active') as HTMLButtonElement | null;
    expect(activeBtn?.getAttribute('data-agent-type')).toBe('codex-sdk');
  });

  it('toggles customProviderSdk on (switches to claude-code-sdk) and off (restores agy-sdk)', () => {
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

    const activeBtn1 = container.querySelector('.session-agent-card.active') as HTMLButtonElement | null;
    expect(activeBtn1?.getAttribute('data-agent-type')).toBe(AGY_SDK_PROVIDER_ID);

    const toggle = screen.getByLabelText(/custom_provider_sdk/i) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    const activeBtn2 = container.querySelector('.session-agent-card.active') as HTMLButtonElement | null;
    expect(activeBtn2?.getAttribute('data-agent-type')).toBe('claude-code-sdk');

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    const activeBtn3 = container.querySelector('.session-agent-card.active') as HTMLButtonElement | null;
    expect(activeBtn3?.getAttribute('data-agent-type')).toBe(AGY_SDK_PROVIDER_ID);
  });

  it.each([
    {
      name: 'upgrades fallback to latest numeric Sol on late live catalog arrival',
      models: [{ id: 'gpt-6-sol' }, { id: 'gpt-6.10-sol' }, { id: 'gpt-6.9-sol' }, { id: 'gpt-7-luna' }],
      defaultModel: 'gpt-6-sol',
      expected: 'gpt-6.10-sol',
    },
    {
      name: 'uses older published Sol without leaking static higher Sol',
      models: [{ id: 'gpt-6-sol' }, { id: 'gpt-5.6-sol' }],
      defaultModel: 'gpt-6-sol',
      expected: 'gpt-6-sol',
    },
    {
      name: 'falls back to provider defaultModel when no Sol exists in live catalog',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6' }],
      defaultModel: 'gpt-5.6',
      expected: 'gpt-5.6',
    },
    {
      name: 'omits requestedModel when no Sol exists and defaultModel is absent',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6' }],
      defaultModel: undefined,
      expected: '',
    },
    {
      name: 'omits requestedModel when no Sol exists and defaultModel is not in catalog',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6' }],
      defaultModel: 'nonexistent-default',
      expected: '',
    },
  ])('codex-sdk sub-session adaptive default: $name', async ({ models, defaultModel, expected }) => {
    localStorage.setItem('imcodes-codex-model', 'gpt-6-sol');
    const handlers = new Set<(message: unknown) => void>();
    const ws = {
      ...makeWs(),
      connected: true,
      onMessage: (cb: (message: unknown) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
    };
    const onStart = vi.fn();
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

    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const modelInput = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    await waitFor(() => expect(modelInput.value).toBe('gpt-6.2-sol'));

    const req = ws.send.mock.calls.find(([msg]) => msg.type === 'transport.list_models' && msg.agentType === 'codex-sdk')?.[0];
    act(() => handlers.forEach((cb) => cb({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: req?.requestId,
      models,
      ...(defaultModel ? { defaultModel } : {}),
    })));

    await waitFor(() => expect(modelInput.value).toBe(expected));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    if (expected) {
      expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, {
        requestedModel: expected,
        thinking: 'high',
      });
    } else {
      expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, {
        thinking: 'high',
      });
    }
  });

  it('codex-sdk sub-session keeps manual model selection and third-party preset when late live catalog arrives', async () => {
    const handlers = new Set<(message: unknown) => void>();
    const ws = {
      ...makeWs(),
      connected: true,
      onMessage: (cb: (message: unknown) => void) => {
        handlers.add(cb);
        if (!cb.toString().includes('transport.models_response')) {
          cb({
            type: 'cc.presets.list_response',
            presets: [{
              name: 'MiniMax',
              env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
              availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3' }],
            }],
          });
        }
        return () => handlers.delete(cb);
      },
    };
    const onStart = vi.fn();
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

    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const modelInput = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    await waitFor(() => expect(modelInput.value).toBe('gpt-6.2-sol'));

    fireEvent.input(modelInput, { target: { value: 'gpt-5.6' } });
    const req = ws.send.mock.calls.find(([msg]) => msg.type === 'transport.list_models' && msg.agentType === 'codex-sdk')?.[0];
    act(() => handlers.forEach((cb) => cb({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: req?.requestId,
      models: [{ id: 'gpt-6.4-sol' }, { id: 'gpt-6-sol' }],
    })));

    expect(modelInput.value).toBe('gpt-5.6');
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onStart).toHaveBeenCalledWith('codex-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'gpt-5.6',
      thinking: 'high',
    });

    // Switching to a third-party preset keeps the preset model rather than overriding with Sol.
    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    fireEvent.input(presetSelect!, { target: { value: 'MiniMax' } });
    await waitFor(() => {
      const presetModelSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax-M2.7'));
      expect(presetModelSelect?.value).toBe('MiniMax-M2.7');
    });
  });

  it('does not let a cached vendor-only preset on the same node pollute a delayed non-preset codex-sdk sub-session dialog', async () => {
    const handlers1 = new Set<(message: unknown) => void>();
    const ws1 = {
      ...makeWs(),
      connected: true,
      onMessage: (cb: (message: unknown) => void) => {
        handlers1.add(cb);
        cb({
          type: 'cc.presets.list_response',
          presets: [{
            name: 'MiniMax',
            env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
            availableModels: [{ id: 'MiniMax-M2.7' }],
          }],
        });
        return () => handlers1.delete(cb);
      },
    };
    const first = render(
      <StartSubSessionDialog
        ws={ws1 as any}
        serverId="srv-sub-same"
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    fireEvent.input(presetSelect!, { target: { value: 'MiniMax' } });
    await waitFor(() => expect(ws1.send.mock.calls.some(([msg]) => msg.type === 'transport.list_models' && msg.ccPreset === 'MiniMax')).toBe(true));
    const req1 = ws1.send.mock.calls.find(([msg]) => msg.type === 'transport.list_models' && msg.ccPreset === 'MiniMax')?.[0];
    act(() => handlers1.forEach((cb) => cb({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      ccPreset: 'MiniMax',
      requestId: req1?.requestId,
      models: [{ id: 'MiniMax-M2.7' }],
      defaultModel: 'MiniMax-M2.7',
    })));
    first.unmount();

    const handlers2 = new Set<(message: unknown) => void>();
    const ws2 = {
      ...makeWs(),
      connected: true,
      onMessage: (cb: (message: unknown) => void) => {
        handlers2.add(cb);
        return () => handlers2.delete(cb);
      },
    };
    const onStart2 = vi.fn();
    render(
      <StartSubSessionDialog
        ws={ws2 as any}
        serverId="srv-sub-same"
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart2}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /codex_sdk/i }));
    const modelInput = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    await waitFor(() => expect(modelInput.value).toBe('gpt-6.2-sol'));

    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onStart2).toHaveBeenLastCalledWith('codex-sdk', undefined, '/tmp', undefined, {
      requestedModel: 'gpt-6.2-sol',
      thinking: 'high',
    });

    const req2 = ws2.send.mock.calls.find(([msg]) => msg.type === 'transport.list_models' && msg.agentType === 'codex-sdk' && !msg.ccPreset)?.[0];
    act(() => handlers2.forEach((cb) => cb({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: req2?.requestId,
      models: [{ id: 'gpt-6.5-sol' }, { id: 'gpt-6-sol' }],
    })));
    await waitFor(() => expect(modelInput.value).toBe('gpt-6.5-sol'));
  });
});

describe('resolveDefaultSubSessionType', () => {
  it('returns agy-sdk when allowedAgentTypes is undefined or empty', () => {
    expect(resolveDefaultSubSessionType(undefined)).toBe(AGY_SDK_PROVIDER_ID);
    expect(resolveDefaultSubSessionType([])).toBe(AGY_SDK_PROVIDER_ID);
  });

  it('returns agy-sdk when allowedAgentTypes includes agy-sdk', () => {
    expect(resolveDefaultSubSessionType(['claude-code-sdk', AGY_SDK_PROVIDER_ID, 'codex-sdk'])).toBe(AGY_SDK_PROVIDER_ID);
  });

  it('returns first selectable allowed agent type when agy-sdk is not included', () => {
    expect(resolveDefaultSubSessionType(['claude-code-sdk', 'codex-sdk'])).toBe('claude-code-sdk');
    expect(resolveDefaultSubSessionType(['gemini', 'gemini-sdk', 'codex-sdk'])).toBe('codex-sdk');
  });

  it('returns agy-sdk when all allowed types are unselectable', () => {
    expect(resolveDefaultSubSessionType(['gemini', 'gemini-sdk'])).toBe(AGY_SDK_PROVIDER_ID);
  });
});
