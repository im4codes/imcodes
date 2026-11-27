/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { GIT_REMOTE_CLONE_CAPABILITY_V1 } from '../../../shared/git-remote-url.js';
import { CODEX_MODEL_IDS, selectLatestCodexSolModel } from '../../../src/shared/models/options.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '../../../shared/agy-agent.js';
import { __clearTransportModelCacheForTests } from '../../src/hooks/useTransportModels.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../../shared/hermes-agent.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE } from '../../../shared/agent-types.js';
import { AGENT_AVAILABILITY_MSG } from '../../../shared/agent-availability.js';
import { sanitizeProjectName } from '../../../shared/sanitize-project-name.js';
import { buildReadableProjectDir } from '../../src/util/project-dir-slug.js';

const {
  fetchSessionIdentityProfileMock,
  saveSessionIdentityProfileMock,
  clearSessionIdentityProfileMock,
} = vi.hoisted(() => ({
  fetchSessionIdentityProfileMock: vi.fn(async () => null),
  saveSessionIdentityProfileMock: vi.fn(),
  clearSessionIdentityProfileMock: vi.fn(),
}));

vi.mock('../../src/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/api.js')>(),
  fetchSessionIdentityProfile: (...args: unknown[]) => fetchSessionIdentityProfileMock(...args),
  saveSessionIdentityProfile: (...args: unknown[]) => saveSessionIdentityProfileMock(...args),
  clearSessionIdentityProfile: (...args: unknown[]) => clearSessionIdentityProfileMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, _opts?: Record<string, unknown>) => {
      if (key === 'session.agentGroup.transport_sdk') return 'SDK';
      if (key === 'session.agentGroup.cli_process') return 'CLI';
      // Return last segment of key as simple translation
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: (props: {
    mode?: string;
    onConfirm?: (paths: string[], preview?: unknown) => void;
    onDirectoryCreated?: (path: string) => void;
  }) => (
    <div data-testid="mock-file-browser">
      <button onClick={() => props.onConfirm?.(['/home/user/selected'])}>mock-select-dir</button>
      {props.mode === 'file-single' && <button onClick={() => props.onConfirm?.(
        ['/home/user/agent-identity.md'],
        { status: 'ok', path: '/home/user/agent-identity.md', content: 'Identity loaded from a selected file.' },
      )}>mock-select-identity-file</button>}
      <button onClick={() => props.onDirectoryCreated?.('/home/user/new-project')}>mock-create-folder</button>
    </div>
  ),
}));

import { NewSessionDialog, PROJECT_DIR_LIST_TIMEOUT_MS } from '../../src/components/NewSessionDialog.js';

const makeWs = () => {
  const handlers = new Set<(msg: unknown) => void>();
  return {
    sendSessionCommand: vi.fn(),
    send: vi.fn(),
    requestSessionList: vi.fn(),
    connected: true,
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    emit: (msg: unknown) => {
      handlers.forEach((handler) => handler(msg));
    },
    subSessionDetectShells: vi.fn(),
    detectAgents: vi.fn(),
    getDaemonCapabilitySnapshot: vi.fn(() => ({
      daemonId: 'daemon-test',
      capabilities: [GIT_REMOTE_CLONE_CAPABILITY_V1],
      helloEpoch: 1,
      sentAt: Date.now(),
      observedAt: Date.now(),
    })),
    isDaemonCapabilityStale: vi.fn(() => false),
  };
};

function getAgentButton(agentType: string): HTMLButtonElement {
  const button = document.querySelector(`[data-agent-type="${agentType}"]`) as HTMLButtonElement | null;
  if (!button) throw new Error(`missing agent card: ${agentType}`);
  return button;
}

function selectAgent(agentType: string): void {
  fireEvent.click(getAgentButton(agentType));
}

describe('NewSessionDialog', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    __clearTransportModelCacheForTests();
  });

  it('renders project name input', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(screen.getByPlaceholderText('my-project')).toBeDefined();
  });

  it('renders working directory input', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(screen.getByPlaceholderText('~/.imcodes/projects/my-project')).toBeDefined();
  });

  it('renders one user/project/pair/session identity editor while creating a session', async () => {
    render(<NewSessionDialog serverId="srv-1" ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(await screen.findAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'identityScope_user' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'identityScope_project' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'identityScope_pair' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'identityScope_session' })).toBeDefined();
    expect(screen.getAllByLabelText('session-identity-content')).toHaveLength(1);
  });

  it('sends selected identity file content in session.start so the first SDK system prompt has it', async () => {
    const ws = makeWs();
    render(<NewSessionDialog serverId="srv-1" ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'identity-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '/tmp/identity-app' } });
    const identity = await screen.findByLabelText('session-identity-content') as HTMLTextAreaElement;
    await waitFor(() => expect(identity.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'identityChooseFile' }));
    fireEvent.click(screen.getByText('mock-select-identity-file'));
    expect(identity.value).toBe('Identity loaded from a selected file.');

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: 'identity-app',
      identityPrompt: 'Identity loaded from a selected file.',
    }));
  });

  it('uses a newly created folder from the directory picker as the working directory', async () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.click(screen.getByTitle('browse'));
    fireEvent.click(screen.getByText('mock-create-folder'));

    await waitFor(() => {
      expect((screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement).value).toBe('/home/user/new-project');
    });
    expect(screen.queryByTestId('mock-file-browser')).toBeNull();
  });

  it('renders the expanded agent card selector', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(document.querySelector('.session-agent-groups')).toBeDefined();
    expect(getAgentButton('claude-code-sdk')).toBeDefined();
    expect(getAgentButton(CLAUDE_CODE_CLI_SDK_AGENT_TYPE)).toBeDefined();
    expect(getAgentButton('pi')).toBeDefined();
  });

  it('agent cards separate transport/sdk and cli/process groups', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const groups = Array.from(document.querySelectorAll('.session-agent-group'));
    expect(groups.map((group) => group.querySelector('.session-agent-group-title')?.textContent)).toEqual(['SDK', 'CLI']);
    const options = groups.flatMap((group) => Array.from(group.querySelectorAll<HTMLButtonElement>('[data-agent-type]')).map((button) => button.dataset.agentType));
    expect(options.slice(0, 18)).toEqual([
      AGY_SDK_PROVIDER_ID,
      'codex-sdk',
      'claude-code-sdk',
      CLAUDE_CODE_CLI_SDK_AGENT_TYPE,
      'qoder-sdk',
      'copilot-sdk',
      'cursor-headless',
      'opencode-sdk',
      'grok-sdk',
      'kimi-sdk',
      'muse-code-sdk',
      HERMES_AGENT_PROVIDER_ID,
      'deepseek-harness',
      'pi',
      'codebuddy-cn',
      'codebuddy-international',
      'qwen',
      'openclaw',
    ]);
    expect(options.slice(18)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
  });

  it('defaults agent type to Antigravity (agy-sdk) with Codex second', () => {
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true');
    const sdkButtons = Array.from(document.querySelectorAll('.session-agent-group:first-child [data-agent-type]'))
      .map((el) => el.getAttribute('data-agent-type'));
    expect(sdkButtons.slice(0, 2)).toEqual([AGY_SDK_PROVIDER_ID, 'codex-sdk']);
    expect(screen.getByText('agent_flavor_sdk')).toBeDefined();
    expect(screen.getByText('qwen_provider_hint')).toBeDefined();
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
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), {
      target: { value: '~/projects/my-app' },
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', {
      project: 'my-app',
      dir: '~/projects/my-app',
      agentType: AGY_SDK_PROVIDER_ID,
      requestedModel: AGY_DEFAULT_MODEL_ID,
    });
  });

  it('hides and disables CC CLI SDK while preserving both usable Claude choices', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    expect(screen.queryByRole('button', { name: /cc_cli_sdk/i })).toBeNull();
    const hidden = getAgentButton(CLAUDE_CODE_CLI_SDK_AGENT_TYPE);
    expect(hidden.style.display).toBe('none');
    expect(hidden.disabled).toBe(true);
    fireEvent.click(hidden);
    expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /claude_code_sdk/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /claude_code_cli/i }));
    expect(getAgentButton('claude-code').getAttribute('aria-pressed')).toBe('true');
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'claude-cli-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/claude-cli-app' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({ agentType: 'claude-code' }));
  });

  it('includes optional git remote URL for main-session starts', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'my-app' },
    });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), {
      target: { value: '/work/my-app' },
    });
    fireEvent.input(screen.getByPlaceholderText('git_remote_url_placeholder'), {
      target: { value: 'https://github.com/acme/my-app.git' },
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: 'my-app',
      dir: '/work/my-app',
      gitRemoteUrl: 'https://github.com/acme/my-app.git',
    }));
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

    selectAgent('codex');
    await waitFor(() => expect(getAgentButton('codex').getAttribute('aria-pressed')).toBe('true'));

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test-proj' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex',
    }));
  });

  it('pressing Escape does not call onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const dialog = container.querySelector('[role="dialog"]')!;
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking the backdrop does not call onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewSessionDialog ws={makeWs() as any} onClose={onClose} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const backdrop = container.querySelector('[role="dialog"]')!;
    fireEvent.click(backdrop, { target: backdrop });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('matches started events for non-ASCII project names deterministically', () => {
    const ws = makeWs();
    const onClose = vi.fn();
    const onSessionStarted = vi.fn();
    render(<NewSessionDialog ws={ws as any} onClose={onClose} onSessionStarted={onSessionStarted} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: '测试' },
    });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), {
      target: { value: '~/projects/test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '测试',
      agentType: AGY_SDK_PROVIDER_ID,
    }));

    act(() => ws.emit({
      type: 'session.event',
      event: 'started',
      session: 'deck_u6d4b_u8bd5_brain',
      state: 'idle',
    }));

    expect(onSessionStarted).toHaveBeenCalledWith('deck_u6d4b_u8bd5_brain');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('accepts session_list as authoritative startup success after the local wait probe', () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      const onClose = vi.fn();
      const onSessionStarted = vi.fn();
      render(<NewSessionDialog ws={ws as any} onClose={onClose} onSessionStarted={onSessionStarted} isProviderConnected={() => false} />);

      fireEvent.input(screen.getByPlaceholderText('my-project'), {
        target: { value: 'my-app' },
      });
      fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), {
        target: { value: '~/projects/my-app' },
      });
      fireEvent.click(screen.getByRole('button', { name: /start/i }));

      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      expect(ws.requestSessionList).toHaveBeenCalledOnce();
      expect(screen.queryByText('timeout')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      act(() => ws.emit({
        type: 'session_list',
        sessions: [
          {
            name: 'deck_my_app_brain',
            project: 'my-app',
            role: 'brain',
            agentType: 'claude-code-sdk',
            state: 'idle',
          },
        ],
      }));

      expect(onSessionStarted).toHaveBeenCalledWith('deck_my_app_brain');
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores session.error for other projects while a start is pending', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), {
      target: { value: 'my-app' },
    });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), {
      target: { value: '~/projects/my-app' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    act(() => ws.emit({
      type: 'session.error',
      project: 'other-project',
      message: 'Other failed',
    }));
    expect(screen.queryByText('Other failed')).toBeNull();
    expect(screen.getAllByText('starting').length).toBeGreaterThan(0);

    act(() => ws.emit({
      type: 'session.error',
      project: 'my-app',
      message: 'Start failed',
    }));
    expect(screen.getByText('Start failed')).toBeDefined();
  });

  it('shows cli/sdk difference hint when switching agent type', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    expect(screen.getByText('agent_flavor_sdk')).toBeDefined();

    selectAgent('claude-code');

    await waitFor(() => expect(screen.getByText('agent_flavor_cli')).toBeDefined());
  });

  it('selects qoder-sdk without showing proof-gated model or thinking controls', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'qoder-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/qoder-app' } });
    selectAgent('qoder-sdk');

    await waitFor(() => expect(screen.getByText('agent_flavor_sdk')).toBeDefined());
    expect(screen.queryByText('thinking')).toBeNull();
    expect(screen.queryByText('model')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.not.objectContaining({
      thinking: expect.anything(),
      requestedModel: expect.anything(),
    }));
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'qoder-sdk',
    }));
  });

  it('shows the qwen provider-specific hint when qwen is selected', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('qwen');

    await waitFor(() => expect(screen.getByText('qwen_provider_selected_hint')).toBeDefined());
  });

  it('includes thinking level when starting codex-sdk', async () => {
    const ws = makeWs();
    const expectedFallback = selectLatestCodexSolModel(CODEX_MODEL_IDS)!;
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('codex-sdk');
    await waitFor(() => {
      const modelSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
      expect(modelSelect.value).toBe(expectedFallback);
    });
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex-sdk',
      requestedModel: expectedFallback,
      thinking: 'high',
    }));
  });

  it('selects a CC SDK model from one compatible-provider preset', async () => {
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          {
            name: 'MiniMax',
            env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
            availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3' }],
          },
        ],
      });
      return () => {};
    });

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('claude-code-sdk');
    expect(screen.getByText('api_provider')).toBeDefined();

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });

    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options ?? []).some((option) => option.value === 'MiniMax'));
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
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'claude-code-sdk',
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M3',
    }));
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.list_models',
      agentType: 'claude-code-sdk',
      ccPreset: 'MiniMax',
    }));
  });

  it('shows CC preset controls and submits preset for qwen', async () => {
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

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('qwen');
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());
    expect(screen.getByText('qwen_provider_selected_hint')).toBeDefined();
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });

    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    presetSelect!.value = 'MiniMax';
    fireEvent.input(presetSelect!, { target: { value: presetSelect!.value } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'qwen',
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M2.7',
      thinking: 'high',
    }));
  });

  it('custom provider SDK allows selecting dsh from the SDK-compatible types and uses a preset', async () => {
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

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.click(screen.getByLabelText(/custom_provider_sdk/i));

    await waitFor(() => expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true'));
    expect(getAgentButton('claude-code-sdk').disabled).toBe(false);
    expect(screen.getByText('custom_provider_preset')).toBeDefined();

    // DSH and Pi are selectable compatibility layers; unsupported transports
    // DSH, Pi, and Codex are selectable compatibility layers; unsupported transports
    // (such as gemini-sdk) are removed from the expanded card selector.
    expect(getAgentButton('deepseek-harness')).toBeDefined();
    expect(getAgentButton('pi')).toBeDefined();
    expect(getAgentButton('codex-sdk')).toBeDefined();
    expect(document.querySelector('[data-agent-type="gemini-sdk"]')).toBeNull();

    selectAgent('deepseek-harness');
    // Confirm the agent-type state actually changed to dsh by checking the
    // resulting side effect (a transport.list_models request for dsh), not the
    // controlled <select>'s DOM value, which can revert to the React state.
    await waitFor(() => {
      expect(ws.send.mock.calls.some((call) => (
        call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'deepseek-harness'
      ))).toBe(true);
    });

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'deepseek-harness',
      ccPreset: 'MiniMax',
    }));
  });

  it('keeps the third-party SDK switch available from every agent selection', async () => {
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [{
          name: 'MiniMax',
          env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
          defaultModel: 'MiniMax-M2.7',
        }],
      });
      return () => {};
    });

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent('openclaw');
    expect(getAgentButton('openclaw').getAttribute('aria-pressed')).toBe('true');

    const toggle = screen.getByLabelText(/custom_provider_sdk/i) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText('custom_provider_preset')).toBeDefined();
      expect((screen.getByLabelText(/custom_provider_sdk/i) as HTMLInputElement).checked).toBe(true);
    });
  });

  it('restores Antigravity and clears stale AGY model when switching agents or toggling custom provider mode', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true');

    // Switching from default agy-sdk to claude-code-sdk clears stale AGY requestedModel
    selectAgent('claude-code-sdk');
    await waitFor(() => expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true'));
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'cc-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/cc-app' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    const ccPayload = ws.sendSessionCommand.mock.calls[0]?.[1];
    expect(ccPayload?.agentType).toBe('claude-code-sdk');
    expect(ccPayload?.requestedModel).toBe('opus[1M]');

    // Switch back to agy-sdk, then toggle custom provider mode on & off: restores agy-sdk
    selectAgent(AGY_SDK_PROVIDER_ID);
    await waitFor(() => expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true'));

    const toggle = screen.getByLabelText(/custom_provider_sdk/i) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true'));

    fireEvent.click(toggle);
    await waitFor(() => expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true'));
  });

  it('resets the model when switching third-party provider presets even if catalogs overlap', async () => {
    const ws = makeWs();
    ws.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [
          {
            name: 'Provider A',
            env: { ANTHROPIC_MODEL: 'a-default' },
            defaultModel: 'a-default',
            availableModels: [{ id: 'a-default' }, { id: 'shared-model' }],
          },
          {
            name: 'Provider B',
            env: { ANTHROPIC_MODEL: 'b-default' },
            defaultModel: 'b-default',
            availableModels: [{ id: 'b-default' }, { id: 'shared-model' }],
          },
        ],
      });
      return () => {};
    });

    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.click(screen.getByLabelText(/custom_provider_sdk/i));
    selectAgent('pi');

    const presetSelect = await waitFor(() => {
      const select = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((candidate) => Array.from(candidate.options).some((option) => option.value === 'Provider B'));
      expect(select).toBeDefined();
      return select!;
    });
    const modelSelect = await waitFor(() => {
      const select = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((candidate) => Array.from(candidate.options).some((option) => option.value === 'shared-model'));
      expect(select).toBeDefined();
      return select!;
    });

    fireEvent.input(modelSelect, { target: { value: 'shared-model' } });
    expect(modelSelect.value).toBe('shared-model');
    fireEvent.input(presetSelect, { target: { value: 'Provider B' } });

    await waitFor(() => {
      const switchedModel = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((candidate) => Array.from(candidate.options).some((option) => option.value === 'b-default'));
      expect(switchedModel?.value).toBe('b-default');
    });
  });

  it('shows a toast when qwen preset JSON is copied to the clipboard', async () => {
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
      <NewSessionDialog
        ws={ws as any}
        onClose={vi.fn()}
        onSessionStarted={vi.fn()}
        isProviderConnected={() => false}
        onToast={onToast}
      />,
    );

    selectAgent('qwen');
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());

    fireEvent.click(screen.getByText('api_provider_add_edit'));
    fireEvent.click(screen.getByRole('button', { name: 'api_provider_export_json' }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledOnce();
    });
    expect(JSON.parse(clipboardWriteText.mock.calls[0][0])).toMatchObject({ name: 'MiniMax' });
    expect(onToast).toHaveBeenCalledWith('api_provider_export_success');
  });

  it('saves qwen presets with the new default env template', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('qwen');
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());

    fireEvent.click(screen.getByText('api_provider_add_edit'));
    fireEvent.input(screen.getByPlaceholderText('e.g. MiniMax'), { target: { value: 'MiniMax' } });
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cc.presets.save',
      requestId: expect.any(String),
      presets: [
        expect.objectContaining({
          name: 'MiniMax',
          transportMode: 'qwen-compatible-api',
          authType: 'anthropic',
          defaultModel: 'MiniMax-M2.7',
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
            ANTHROPIC_MODEL: 'MiniMax-M2.7',
            API_TIMEOUT_MS: '3000000',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
          }),
        }),
      ],
    }));
  });

  it('saves OpenAI compatible preset when selected in preset editor', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('qwen');
    await waitFor(() => expect(screen.getByText('compatible_api_via_qwen')).toBeDefined());

    fireEvent.click(screen.getByText('api_provider_add_edit'));
    const openaiRadio = screen.getByLabelText(/OpenAI Compatible/i);
    fireEvent.click(openaiRadio);

    expect((screen.getByDisplayValue('https://api.minimax.chat/v1') as HTMLInputElement)).toBeDefined();
    expect((screen.getByDisplayValue('MiniMax-Text-01') as HTMLInputElement)).toBeDefined();

    fireEvent.input(screen.getByPlaceholderText('e.g. MiniMax'), { target: { value: 'MiniMax-OpenAI' } });
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cc.presets.save',
      requestId: expect.any(String),
      presets: [
        expect.objectContaining({
          name: 'MiniMax-OpenAI',
          transportMode: 'qwen-compatible-api',
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

  it('keeps the preset env model authoritative for qwen after discovery', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('qwen');
    fireEvent.click(screen.getByText('api_provider_add_edit'));
    fireEvent.input(screen.getByPlaceholderText('e.g. MiniMax'), { target: { value: 'MiniMax' } });
    fireEvent.input(screen.getByPlaceholderText('your-api-key'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /discover models/i }));
    act(() => ws.emit({
      type: 'cc.presets.discover_models_response',
      ok: true,
      presetName: 'MiniMax',
      preset: {
        name: 'MiniMax',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'secret',
          ANTHROPIC_MODEL: 'MiniMax-M2.7',
        },
        defaultModel: 'MiniMax-Text-01',
        availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-Text-01' }],
      },
    }));

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    await waitFor(() => {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        agentType: 'qwen',
        ccPreset: 'MiniMax',
        requestedModel: 'MiniMax-M2.7',
      }));
    });
  });

  it('includes thinking level when starting qwen', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('qwen');
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'qwen',
      thinking: 'high',
    }));
  });

  it('passes requestedModel when starting copilot-sdk', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('copilot-sdk');
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(2));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[1], { target: { value: 'gpt-5.4-mini' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'copilot-sdk',
      requestedModel: 'gpt-5.4-mini',
      thinking: 'high',
    }));
  });

  it('passes requestedModel when starting cursor-headless', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('cursor-headless');
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1));
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'gpt-5.2' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'cursor-headless',
      requestedModel: 'gpt-5.2',
    }));
  });

  it('omits deprecated Gemini SDK and Gemini CLI from SDK and CLI selectors while keeping Antigravity default', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    expect(screen.queryByRole('button', { name: /gemini_sdk/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gemini cli/i })).toBeNull();
    expect(document.querySelector('[data-agent-type="gemini-sdk"]')).toBeNull();
    expect(document.querySelector('[data-agent-type="gemini"]')).toBeNull();
    expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true');
  });

  it('uses dynamically discovered kimi-sdk models when starting a session', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('kimi-sdk');

    await waitFor(() => {
      expect(ws.send.mock.calls.some((call) => (
        call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'kimi-sdk'
      ))).toBe(true);
    });
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'kimi-sdk'
    ))?.[0];
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'kimi-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'moonshot-v1-auto', name: 'Moonshot Auto' },
        { id: 'moonshot-v1-auto,thinking', name: 'Moonshot Auto Thinking' },
      ],
    }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'moonshot-v1-auto,thinking' })).toBeDefined());
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'moonshot-v1-auto,thinking' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'kimi-sdk',
      requestedModel: 'moonshot-v1-auto,thinking',
    }));
  });

  it('actively discovers Hermes models and starts with the selected model', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent(HERMES_AGENT_PROVIDER_ID);

    await waitFor(() => {
      expect(ws.send.mock.calls.some((call) => (
        call[0]?.type === 'transport.list_models'
        && call[0]?.agentType === HERMES_AGENT_PROVIDER_ID
        && call[0]?.force === true
      ))).toBe(true);
    });
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === HERMES_AGENT_PROVIDER_ID
    ))?.[0];
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: HERMES_AGENT_PROVIDER_ID,
      requestId: request?.requestId,
      models: [
        { id: 'nous-free', name: 'Nous Free' },
        { id: 'minimax-oauth', name: 'MiniMax OAuth' },
      ],
      defaultModel: 'nous-free',
      isAuthenticated: true,
    }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'minimax-oauth' })).toBeDefined());
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'minimax-oauth' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: HERMES_AGENT_PROVIDER_ID,
      requestedModel: 'minimax-oauth',
    }));
  });

  it('starts the China CodeBuddy provider with its Hy3 model independently from International', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('codebuddy-cn');

    await waitFor(() => {
      expect(ws.send.mock.calls.some((call) => (
        call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codebuddy-cn'
      ))).toBe(true);
    });
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codebuddy-cn'
    ))?.[0];
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'codebuddy-cn',
      requestId: request?.requestId,
      models: [{ id: 'hy3', name: 'Hy3' }],
      defaultModel: 'hy3',
    }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'hy3' })).toBeDefined());
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'hy3' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codebuddy-cn',
      requestedModel: 'hy3',
    }));
    expect(getAgentButton('codebuddy-international')).toBeDefined();
  });

  it('offers a free-text model input for deepseek-harness and starts with the typed model', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('deepseek-harness');

    await waitFor(() => {
      expect(ws.send.mock.calls.some((call) => (
        call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'deepseek-harness'
      ))).toBe(true);
    });
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'deepseek-harness'
    ))?.[0];
    // `dsh` resolves provider routes from its own ~/.dsh config, so the daemon
    // catalog is always empty — the first load must not burn a forced probe.
    expect(request).not.toHaveProperty('force');
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'deepseek-harness',
      requestId: request?.requestId,
      models: [],
    }));

    // Empty catalogue ⇒ free text, exactly like Kimi/Grok with no models.
    const modelInput = await screen.findByPlaceholderText('selectModel');
    expect(modelInput.tagName).toBe('INPUT');
    // An empty catalogue remains a free-text input: no model dropdown appears.
    expect(document.querySelectorAll('select')).toHaveLength(0);
    fireEvent.input(modelInput, { target: { value: 'deepseek-reasoner' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'deepseek-harness',
      requestedModel: 'deepseek-reasoner',
    }));
  });

  it('uses a provider-qualified OpenCode SDK model when starting a session', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('opencode-sdk');

    await waitFor(() => expect(ws.send.mock.calls.some((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'opencode-sdk'
    ))).toBe(true));
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'opencode-sdk'
    ))?.[0];
    expect(request).toMatchObject({
      type: 'transport.list_models',
      agentType: 'opencode-sdk',
      force: true,
    });
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'opencode-sdk',
      requestId: request?.requestId,
      models: [{ id: 'anthropic/claude-sonnet-4-5', name: 'Anthropic · Claude Sonnet 4.5' }],
      defaultModel: 'anthropic/claude-sonnet-4-5',
      isAuthenticated: true,
    }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'anthropic/claude-sonnet-4-5' })).toBeDefined());
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'anthropic/claude-sonnet-4-5' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'opencode-sdk',
      requestedModel: 'anthropic/claude-sonnet-4-5',
    }));
  });

  it('uses dynamically discovered grok-sdk models when starting a session', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent('grok-sdk');

    await waitFor(() => expect(ws.send.mock.calls.some((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'grok-sdk'
    ))).toBe(true));
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'grok-sdk'
    ))?.[0];
    expect(request).toMatchObject({ force: true });
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'grok-sdk',
      requestId: request?.requestId,
      models: [{ id: 'grok-build', name: 'Grok Build' }],
      defaultModel: 'grok-build',
      isAuthenticated: true,
    }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'grok-build' })).toBeDefined());
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'grok-build' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'grok-sdk',
      requestedModel: 'grok-build',
    }));
  });

  it('shows an actionable Grok prerequisite error returned by the daemon', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent('grok-sdk');
    await waitFor(() => expect(ws.send.mock.calls.some((call) => call[0]?.agentType === 'grok-sdk')).toBe(true));
    const request = ws.send.mock.calls.find((call) => call[0]?.agentType === 'grok-sdk')?.[0];
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'grok-sdk',
      requestId: request?.requestId,
      models: [],
      isAuthenticated: false,
      error: 'Grok authentication is required. Run `grok login`.',
    }));
    expect((await screen.findByRole('alert')).textContent).toContain('grok_prerequisite_error');
  });

  it('keeps Antigravity options and Hydrogen High default available offline', async () => {
    const ws = Object.assign(makeWs(), { connected: false });
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent(AGY_SDK_PROVIDER_ID);
    expect(await screen.findByRole('option', { name: 'gemini-4-hydrogen-high' })).toBeDefined();
    const option = screen.getByRole('option', { name: 'gemini-4-hydrogen-high' });
    expect((option.parentElement as HTMLSelectElement).value).toBe('gemini-4-hydrogen-high');
  });

  it('uses dynamically discovered agy-sdk models when starting a session', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'my-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/my-app' } });
    selectAgent(AGY_SDK_PROVIDER_ID);

    await waitFor(() => expect(ws.send.mock.calls.some((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === AGY_SDK_PROVIDER_ID
    ))).toBe(true));
    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === AGY_SDK_PROVIDER_ID
    ))?.[0];
    expect(request).toMatchObject({ force: true });
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: AGY_SDK_PROVIDER_ID,
      requestId: request?.requestId,
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
      defaultModel: 'gemini-2.5-pro',
      isAuthenticated: true,
    }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'gemini-2.5-pro' })).toBeDefined());
    expect(screen.queryByRole('option', { name: 'gemini-4-argon-medium' })).toBeNull();
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.input(selects[0], { target: { value: 'gemini-2.5-pro' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: AGY_SDK_PROVIDER_ID,
      requestedModel: 'gemini-2.5-pro',
    }));
    expect(localStorage.getItem('imcodes-agy-model')).toBe('gemini-2.5-pro');
  });

  it('defaults agy-sdk to gemini-4-hydrogen-high over upstream carbon-medium when no preference exists, then remembers user-selected AGY models on reopen', async () => {
    const ws1 = makeWs();
    const first = render(<NewSessionDialog ws={ws1 as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'agy-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/agy-app' } });
    selectAgent(AGY_SDK_PROVIDER_ID);

    const req1 = ws1.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models' && call[0]?.agentType === AGY_SDK_PROVIDER_ID
    ))?.[0];
    act(() => ws1.emit({
      type: 'transport.models_response',
      agentType: AGY_SDK_PROVIDER_ID,
      requestId: req1?.requestId,
      models: [
        { id: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
        { id: AGY_DEFAULT_MODEL_ID, name: 'Gemini 4 Hydrogen (High)' },
        { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
      ],
      defaultModel: 'gemini-4-carbon-medium',
      isAuthenticated: true,
    }));

    const select1 = (await screen.findByRole('option', { name: 'gemini-4-argon-high' })).parentElement as HTMLSelectElement;
    expect(select1.value).toBe(AGY_DEFAULT_MODEL_ID);

    // User selects gemini-4-argon-high and starts the session:
    fireEvent.input(select1, { target: { value: 'gemini-4-argon-high' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws1.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: AGY_SDK_PROVIDER_ID,
      requestedModel: 'gemini-4-argon-high',
    }));
    expect(localStorage.getItem('imcodes-agy-model')).toBe('gemini-4-argon-high');

    first.unmount();

    // Reopening NewSessionDialog pre-fills the remembered gemini-4-argon-high model:
    const ws2 = makeWs();
    render(<NewSessionDialog ws={ws2 as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent(AGY_SDK_PROVIDER_ID);
    const select2 = (await screen.findByRole('option', { name: 'gemini-4-argon-high' })).parentElement as HTMLSelectElement;
    expect(select2.value).toBe('gemini-4-argon-high');
  });

  it('defaults dir to ~/.imcodes/projects/ and auto-fills ~/.imcodes/projects/<readable-slug> while typing project name', () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    expect(dirInput.value).toBe('~/.imcodes/projects/');

    fireEvent.input(projectInput, { target: { value: 'My App!' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/my_app');

    fireEvent.input(projectInput, { target: { value: '无论' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    fireEvent.input(projectInput, { target: { value: '我的项目' } });
    expect(dirInput.value).toBe(buildReadableProjectDir('我的项目'));
    expect(dirInput.value).toBe('~/.imcodes/projects/wo_de_xiang_mu');

    fireEvent.input(projectInput, { target: { value: 'my-project' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/my_project');

    fireEvent.input(projectInput, { target: { value: '../../etc/passwd' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/etc_passwd');

    fireEvent.input(projectInput, { target: { value: '   ' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/');
  });

  it('queries ~/.imcodes/projects once on mount, appends _1/_2/_3 only when colliding, and does not override manual dir edits', async () => {
    const ws = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'ls-req-1'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const rendered = render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    expect(ws.fsListDir).toHaveBeenCalledTimes(1);
    expect(ws.fsListDir).toHaveBeenCalledWith('~/.imcodes/projects', true, false, { includeSymlinkNames: true });

    // Before fs.ls_response arrives, default dir has no random suffix
    fireEvent.input(projectInput, { target: { value: '无论' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');
    expect(ws.fsListDir).toHaveBeenCalledTimes(1);

    // Unmatched requestId is ignored
    act(() => ws.emit({
      type: 'fs.ls_response',
      requestId: 'other-req',
      status: 'ok',
      entries: [{ name: 'wu_lun', isDir: true }],
    }));
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    // Matching response with existing wu_lun (including symlink name entry with isDir: false) and wu_lun_1 increments dir to wu_lun_2
    act(() => ws.emit({
      type: 'fs.ls_response',
      requestId: 'ls-req-1',
      status: 'ok',
      entries: [
        { name: 'wu_lun', isDir: false },
        { name: 'wu_lun_1', isDir: true },
      ],
    }));
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun_2');

    // Manual edit locks dir against late fs.ls_response updates
    rendered.unmount();
    const ws2 = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'ls-req-2'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const second = render(<NewSessionDialog ws={ws2 as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const projectInput2 = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput2 = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;
    fireEvent.input(projectInput2, { target: { value: '无论' } });
    fireEvent.input(dirInput2, { target: { value: '/custom/wu_lun' } });

    act(() => ws2.emit({
      type: 'fs.ls_response',
      requestId: 'ls-req-2',
      status: 'ok',
      entries: [{ name: 'wu_lun', isDir: true }],
    }));
    expect(dirInput2.value).toBe('/custom/wu_lun');

    // Unmounting before response arrives cleans up owned data request
    second.unmount();
    const ws3 = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'ls-req-3'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const third = render(<NewSessionDialog ws={ws3 as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    third.unmount();
    expect(ws3.forgetOwnedDataRequest).toHaveBeenCalledWith('ls-req-3');
  });

  it('defers Enter/Click start on auto-dir while ~/.imcodes/projects query is pending, resolves collision/error/timeout cleanly, and does not delay manual dir', async () => {
    // 1. Pressing Enter while listing is pending waits, then launches with deduplicated wu_lun_1
    const wsEnter = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-enter'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const rEnter = render(<NewSessionDialog ws={wsEnter as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: '无论' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(wsEnter.sendSessionCommand).not.toHaveBeenCalled();

    act(() => wsEnter.emit({
      type: 'fs.ls_response',
      requestId: 'req-enter',
      status: 'ok',
      entries: [{ name: 'wu_lun', isDir: false }],
    }));
    expect(wsEnter.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(wsEnter.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '无论',
      dir: '~/.imcodes/projects/wu_lun_1',
    }));
    rEnter.unmount();

    // 2. Clicking Start while listing is pending waits; error response falls back to empty set (wu_lun)
    const wsClickErr = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-err'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const rErr = render(<NewSessionDialog ws={wsClickErr as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: '无论' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(wsClickErr.sendSessionCommand).not.toHaveBeenCalled();

    act(() => wsClickErr.emit({
      type: 'fs.ls_response',
      requestId: 'req-err',
      status: 'error',
      error: 'forbidden_path',
    }));
    expect(wsClickErr.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(wsClickErr.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '无论',
      dir: '~/.imcodes/projects/wu_lun',
    }));
    rErr.unmount();

    // 3. Bounded timeout releases ownedDataRequest and starts with base dir
    vi.useFakeTimers();
    try {
      const wsTimeout = {
        ...makeWs(),
        fsListDir: vi.fn(() => 'req-timeout'),
        forgetOwnedDataRequest: vi.fn(),
      };
      const rTimeout = render(<NewSessionDialog ws={wsTimeout as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
      fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: '无论' } });
      fireEvent.click(screen.getByRole('button', { name: /start/i }));
      expect(wsTimeout.sendSessionCommand).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(PROJECT_DIR_LIST_TIMEOUT_MS);
      });
      expect(wsTimeout.forgetOwnedDataRequest).toHaveBeenCalledWith('req-timeout');
      expect(wsTimeout.sendSessionCommand).toHaveBeenCalledTimes(1);
      expect(wsTimeout.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        dir: '~/.imcodes/projects/wu_lun',
      }));
      rTimeout.unmount();
    } finally {
      vi.useRealTimers();
    }

    // 4. Manual dir starts immediately even while fsListDir query is still pending
    const wsManual = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-manual'),
      forgetOwnedDataRequest: vi.fn(),
    };
    render(<NewSessionDialog ws={wsManual as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: '无论' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '/manual/path' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(wsManual.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(wsManual.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      dir: '/manual/path',
    }));
  });

  it('invalidates previous node directory listing and auto-dir on ws switch, falls back on B error, ignores late A responses, and preserves manual dir', async () => {
    const wsA = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-a'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const wsB = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-b'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const onClose = vi.fn();
    const onSessionStarted = vi.fn();
    const rendered = render(
      <NewSessionDialog serverId="srv-a" ws={wsA as any} onClose={onClose} onSessionStarted={onSessionStarted} isProviderConnected={() => false} />,
    );
    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    fireEvent.input(projectInput, { target: { value: '无论' } });
    act(() => wsA.emit({
      type: 'fs.ls_response',
      requestId: 'req-a',
      status: 'ok',
      entries: [{ name: 'wu_lun', isDir: true }],
    }));
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun_1');

    // Switch ws from A to B while dialog stays mounted
    rendered.rerender(
      <NewSessionDialog serverId="srv-b" ws={wsB as any} onClose={onClose} onSessionStarted={onSessionStarted} isProviderConnected={() => false} />,
    );
    // Stale A suffix is invalidated immediately while B query is in flight
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    // Late message on A is completely ignored
    act(() => wsA.emit({
      type: 'fs.ls_response',
      requestId: 'req-a',
      status: 'ok',
      entries: [{ name: 'wu_lun', isDir: true }, { name: 'wu_lun_1', isDir: true }],
    }));
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    // B returns error -> empty set fallback, subsequent typing does NOT use A entries
    act(() => wsB.emit({
      type: 'fs.ls_response',
      requestId: 'req-b',
      status: 'error',
      error: 'failed',
    }));
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');
    fireEvent.input(projectInput, { target: { value: '其他' } });
    fireEvent.input(projectInput, { target: { value: '无论' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    // Manual edit stays locked across node switch
    const wsC = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-c'),
      forgetOwnedDataRequest: vi.fn(),
    };
    fireEvent.input(dirInput, { target: { value: '/custom/locked/path' } });
    rendered.rerender(
      <NewSessionDialog serverId="srv-c" ws={wsC as any} onClose={onClose} onSessionStarted={onSessionStarted} isProviderConnected={() => false} />,
    );
    expect(dirInput.value).toBe('/custom/locked/path');
  });

  it('never routes a stale pending Enter start from node A into node B when A resolves during B commit before A cleanup', async () => {
    const wsA = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-a-interleave'),
      forgetOwnedDataRequest: vi.fn(),
    };
    const wsB = {
      ...makeWs(),
      fsListDir: vi.fn(() => 'req-b-interleave'),
      forgetOwnedDataRequest: vi.fn(),
    };

    function InterleaveHarness({ target }: { target: 'a' | 'b' }) {
      const activeWs = target === 'a' ? wsA : wsB;
      const activeServerId = target === 'a' ? 'srv-a' : 'srv-b';
      useLayoutEffect(() => {
        if (target === 'b') {
          // Fires after B render commits and BEFORE A's useEffect cleanup runs
          wsA.emit({
            type: 'fs.ls_response',
            requestId: 'req-a-interleave',
            status: 'ok',
            entries: [{ name: 'wu_lun', isDir: true }],
          });
        }
      }, [target]);
      return (
        <NewSessionDialog
          serverId={activeServerId}
          ws={activeWs as any}
          onClose={vi.fn()}
          onSessionStarted={vi.fn()}
          isProviderConnected={() => false}
        />
      );
    }

    const rendered = render(<InterleaveHarness target="a" />);
    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    fireEvent.input(projectInput, { target: { value: '无论' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(wsA.sendSessionCommand).not.toHaveBeenCalled();

    // Switch to B; useLayoutEffect delivers A's fs.ls_response while B is committed
    rendered.rerender(<InterleaveHarness target="b" />);

    expect(wsA.sendSessionCommand).not.toHaveBeenCalled();
    expect(wsB.sendSessionCommand).not.toHaveBeenCalled();
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    // Session on B starts ONLY when user explicitly submits on B (and resolves with B's listing)
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(wsB.sendSessionCommand).not.toHaveBeenCalled();

    act(() => wsB.emit({
      type: 'fs.ls_response',
      requestId: 'req-b-interleave',
      status: 'ok',
      entries: [
        { name: 'wu_lun', isDir: true },
        { name: 'wu_lun_1', isDir: true },
      ],
    }));
    expect(wsA.sendSessionCommand).not.toHaveBeenCalled();
    expect(wsB.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(wsB.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '无论',
      dir: '~/.imcodes/projects/wu_lun_2',
    }));
  });

  it('mounts safely without throwing when ws mock lacks onMessage and still auto-populates default dir', async () => {
    const partialWs = {
      connected: true,
      sendSessionCommand: vi.fn(),
    };
    render(<NewSessionDialog serverId="srv-partial" ws={partialWs as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    fireEvent.input(projectInput, { target: { value: '无论' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/wu_lun');

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(partialWs.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '无论',
      dir: '~/.imcodes/projects/wu_lun',
    }));
  });

  it('stops auto-updating dir once the user manually edits the dir input or picks via FileBrowser', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    fireEvent.input(projectInput, { target: { value: 'alpha' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/alpha');

    // Manual edit locks dir against future project name changes (even if cleared or edited):
    fireEvent.input(dirInput, { target: { value: '/custom/work' } });
    fireEvent.input(projectInput, { target: { value: 'beta' } });
    expect(dirInput.value).toBe('/custom/work');

    // Also test FileBrowser directory selection locks dir:
    cleanup();
    render(<NewSessionDialog ws={makeWs() as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.click(screen.getByTitle('browse'));
    fireEvent.click(screen.getByText('mock-select-dir'));
    const dirAfterBrowse = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;
    expect(dirAfterBrowse.value).toBe('/home/user/selected');
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'gamma' } });
    expect(dirAfterBrowse.value).toBe('/home/user/selected');
  });

  it('probes agent availability on mount, disables/greys uninstalled agents, falls back from unavailable default, and supports manual refresh', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    // Mount triggers initial non-forced detection:
    expect(ws.detectAgents).toHaveBeenCalledWith(false);
    const refreshBtn = screen.getByRole('button', { name: 'refresh_agents' }) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);

    // Emit availability where default agy-sdk is NOT installed, while codex-sdk IS installed:
    act(() => ws.emit({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: Date.now(),
      agents: {
        [AGY_SDK_PROVIDER_ID]: { installed: false, reason: 'agy CLI not found' },
        'codex-sdk': { installed: true },
        'claude-code-sdk': { installed: false, reason: 'claude not found' },
        'qoder-sdk': { installed: true },
      },
    }));

    await waitFor(() => {
      expect(getAgentButton('codex-sdk').getAttribute('aria-pressed')).toBe('true');
    });

    const agyBtn = getAgentButton(AGY_SDK_PROVIDER_ID);
    expect(agyBtn.disabled).toBe(true);
    expect(agyBtn.classList.contains('is-unavailable')).toBe(true);
    expect(agyBtn.title).toBe('agent_not_installed_hint');

    // Clicking disabled/unavailable agent does not change active agent:
    fireEvent.click(agyBtn);
    expect(getAgentButton('codex-sdk').getAttribute('aria-pressed')).toBe('true');

    // Refresh button is re-enabled and triggers forceRefresh: true when clicked:
    expect(refreshBtn.disabled).toBe(false);
    fireEvent.click(refreshBtn);
    expect(ws.detectAgents).toHaveBeenCalledWith(true);
    expect(refreshBtn.disabled).toBe(true);

    // Second availability response restores agy-sdk:
    act(() => ws.emit({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: Date.now(),
      agents: {
        [AGY_SDK_PROVIDER_ID]: { installed: true },
        'codex-sdk': { installed: true },
      },
    }));
    expect(refreshBtn.disabled).toBe(false);
    expect(getAgentButton(AGY_SDK_PROVIDER_ID).disabled).toBe(false);
    expect(getAgentButton(AGY_SDK_PROVIDER_ID).classList.contains('is-unavailable')).toBe(false);
  });

  it('stays fail-open on older daemons that do not respond to session.detect_agents', () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

      expect(getAgentButton(AGY_SDK_PROVIDER_ID).disabled).toBe(false);
      expect(getAgentButton('codex-sdk').disabled).toBe(false);
      expect(getAgentButton('claude-code-sdk').disabled).toBe(false);

      // Even after refresh timeout expires without daemon response, refresh button recovers and cards remain enabled:
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      const refreshBtn = screen.getByRole('button', { name: 'refresh_agents' }) as HTMLButtonElement;
      expect(refreshBtn.disabled).toBe(false);
      expect(getAgentButton(AGY_SDK_PROVIDER_ID).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-fallback picks only explicitly installed=true choices (skipping omitted entries) while keeping omitted entries clickable fail-open', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    act(() => ws.emit({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: 2_000,
      agents: {
        // agy-sdk is unavailable, codex-sdk is omitted from the partial map, claude-code-sdk is explicitly true:
        [AGY_SDK_PROVIDER_ID]: { installed: false },
        'claude-code-sdk': { installed: true },
      },
    }));

    // Auto-fallback must select explicitly verified claude-code-sdk, NOT omitted codex-sdk:
    await waitFor(() => {
      expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true');
    });
    // Omitted entry remains clickable (fail-open):
    expect(getAgentButton('codex-sdk').disabled).toBe(false);

    // Older out-of-order checkedAt response must be ignored:
    act(() => ws.emit({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: 1_000,
      agents: {
        [AGY_SDK_PROVIDER_ID]: { installed: true },
        'claude-code-sdk': { installed: false },
      },
    }));
    expect(getAgentButton('claude-code-sdk').disabled).toBe(false);
  });

  it('never falls back to an incognito-incompatible agent when incognito mode is enabled', async () => {
    const ws = makeWs();
    (ws.getDaemonCapabilitySnapshot as any).mockReturnValue({
      daemonId: 'daemon-test',
      capabilities: ['git-remote-clone:v1', 'session.incognito:v1'],
      helloEpoch: 1,
      sentAt: Date.now(),
      observedAt: Date.now(),
    });
    const view = render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    // Enable incognito while agy-sdk is active:
    const incognitoCheckbox = view.container.querySelector('.incognito-create-option input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(incognitoCheckbox);
    expect(incognitoCheckbox.checked).toBe(true);

    // All incognito-compatible agents are unavailable, while CLI 'codex' (incognito-incompatible) is installed:
    act(() => ws.emit({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: 3_000,
      agents: {
        [AGY_SDK_PROVIDER_ID]: { installed: false },
        'codex-sdk': { installed: false },
        'claude-code-sdk': { installed: false },
        'qoder-sdk': { installed: false },
        'copilot-sdk': { installed: false },
        'cursor-headless': { installed: false },
        'opencode-sdk': { installed: false },
        'grok-sdk': { installed: false },
        'kimi-sdk': { installed: false },
        'muse-code-sdk': { installed: false },
        [HERMES_AGENT_PROVIDER_ID]: { installed: false },
        'deepseek-harness': { installed: false },
        pi: { installed: false },
        'codebuddy-cn': { installed: false },
        'codebuddy-international': { installed: false },
        openclaw: { installed: false },
        'claude-code': { installed: false },
        codex: { installed: true },
        opencode: { installed: false },
      },
    }));

    // Must NOT fall back to disabled incognito-incompatible 'codex':
    await waitFor(() => {
      expect(getAgentButton('codex').getAttribute('aria-pressed')).toBe('false');
      expect(getAgentButton('codex').disabled).toBe(true);
    });
    const startBtn = view.container.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
  });

  it('disables Start and blocks handleStart when Custom provider SDK is enabled with an existing preset and all compatible SDKs are unavailable while agy-sdk is installed', async () => {
    const ws = makeWs();
    const view = render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    // Pre-populate a preset and select it:
    act(() => ws.emit({
      type: 'cc.presets_list',
      presets: [
        { name: 'custom-test-preset', authType: 'anthropic', baseUrl: 'https://example.invalid', token: 'sk-test', model: 'm1', contextWindow: 128000, customEnv: [] },
      ],
    }));

    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    fireEvent.input(projectInput, { target: { value: 'blocked-custom' } });

    // Availability map: agy-sdk is installed, while every CUSTOM_PROVIDER_SDK_AGENT_TYPES entry is false:
    act(() => ws.emit({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: 4_000,
      agents: {
        [AGY_SDK_PROVIDER_ID]: { installed: true },
        'claude-code-sdk': { installed: false },
        [CLAUDE_CODE_CLI_SDK_AGENT_TYPE]: { installed: false },
        'codex-sdk': { installed: false },
        'opencode-sdk': { installed: false },
        'deepseek-harness': { installed: false },
        pi: { installed: false },
        qwen: { installed: false },
      },
    }));

    await waitFor(() => {
      expect(getAgentButton(AGY_SDK_PROVIDER_ID).getAttribute('aria-pressed')).toBe('true');
    });

    // Enable Custom provider SDK mode:
    const customCheckbox = screen.getByText('custom_provider_sdk').closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(customCheckbox);

    // Custom mode stays checked (not cleared), agy-sdk is hidden, Start button MUST be disabled:
    expect(customCheckbox.checked).toBe(true);
    expect(view.container.querySelector(`[data-agent-type="${AGY_SDK_PROVIDER_ID}"]`)).toBeNull();
    const startBtn = view.container.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);

    // Even triggering Enter -> handleStart() must block submission without emitting session.start:
    fireEvent.keyDown(projectInput, { key: 'Enter' });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Toggling Custom provider SDK off restores agy-sdk and re-enables Start:
    fireEvent.click(customCheckbox);
    expect(customCheckbox.checked).toBe(false);
    expect(startBtn.disabled).toBe(false);
  });

  it.each([
    {
      name: 'prefers latest numeric Sol over older Sol and non-Sol default',
      models: [{ id: 'gpt-6-sol' }, { id: 'gpt-6.10-sol' }, { id: 'gpt-6.9-sol' }, { id: 'gpt-7-luna' }],
      defaultModel: 'gpt-6-sol',
      expected: 'gpt-6.10-sol',
      forbiddenOption: undefined as string | undefined,
    },
    {
      name: 'uses published older Sol without leaking static higher Sol',
      models: [{ id: 'gpt-6-sol' }, { id: 'gpt-5.6-sol' }],
      defaultModel: 'gpt-6-sol',
      expected: 'gpt-6-sol',
      forbiddenOption: 'gpt-6.2-sol',
    },
    {
      name: 'falls back to provider defaultModel when live catalog has no Sol',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6' }],
      defaultModel: 'gpt-5.6',
      expected: 'gpt-5.6',
      forbiddenOption: 'gpt-6.2-sol',
    },
    {
      name: 'omits requestedModel when live catalog has no Sol and defaultModel is absent',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6' }],
      defaultModel: undefined,
      expected: '',
      forbiddenOption: 'gpt-6.2-sol',
    },
    {
      name: 'omits requestedModel when live catalog has no Sol and defaultModel is not in catalog',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-5.6' }],
      defaultModel: 'nonexistent-default',
      expected: '',
      forbiddenOption: 'gpt-6.2-sol',
    },
  ])('codex-sdk adaptive default: $name', async ({ models, defaultModel, expected, forbiddenOption }) => {
    localStorage.setItem('imcodes-codex-model', 'gpt-6-sol');
    const ws = makeWs();
    render(<NewSessionDialog serverId="srv-adapt" ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'codex-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/codex-app' } });
    selectAgent('codex-sdk');

    await waitFor(() => expect(ws.send.mock.calls.some((call) => call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codex-sdk')).toBe(true));
    const req = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codex-sdk')?.[0];
    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: req?.requestId,
      models,
      ...(defaultModel ? { defaultModel } : {}),
    }));

    await waitFor(() => {
      const modelSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
      expect(modelSelect.value).toBe(expected);
    });
    if (forbiddenOption) {
      expect(screen.queryByRole('option', { name: forbiddenOption })).toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    if (expected) {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        agentType: 'codex-sdk',
        requestedModel: expected,
      }));
    } else {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
        agentType: 'codex-sdk',
      }));
      expect(ws.sendSessionCommand.mock.calls[0]?.[1]).not.toHaveProperty('requestedModel');
    }
  });

  it('codex-sdk preserves manual selection and third-party preset over late live catalog arrival and isolates nodes', async () => {
    // 1) Manual selection stays intact when a higher live Sol arrives later.
    const wsManual = makeWs();
    const first = render(<NewSessionDialog serverId="srv-manual" ws={wsManual as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'manual-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/manual-app' } });
    selectAgent('codex-sdk');
    await waitFor(() => expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('gpt-6.2-sol'));
    fireEvent.input(screen.getAllByRole('combobox')[1], { target: { value: 'gpt-6-sol' } });

    const manualReq = wsManual.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codex-sdk')?.[0];
    act(() => wsManual.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: manualReq?.requestId,
      models: [{ id: 'gpt-6.4-sol' }, { id: 'gpt-6.2-sol' }, { id: 'gpt-6-sol' }],
    }));
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('gpt-6-sol');
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(wsManual.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex-sdk',
      requestedModel: 'gpt-6-sol',
    }));
    first.unmount();

    // 2) Third-party preset keeps its preset model when live catalog arrives; node B does not inherit node A catalog.
    const wsA = { ...makeWs(), getDaemonCapabilitySnapshot: vi.fn(() => ({ daemonId: 'daemon-a', capabilities: [], helloEpoch: 1, sentAt: 1, observedAt: 1 })) };
    const viewA = render(<NewSessionDialog serverId="srv-a" ws={wsA as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent('codex-sdk');
    const reqA = wsA.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codex-sdk')?.[0];
    act(() => wsA.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: reqA?.requestId,
      models: [{ id: 'gpt-6.8-sol' }, { id: 'gpt-6-sol' }],
    }));
    await waitFor(() => expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('gpt-6.8-sol'));
    viewA.unmount();

    const wsB = { ...makeWs(), connected: false, getDaemonCapabilitySnapshot: vi.fn(() => ({ daemonId: 'daemon-b', capabilities: [], helloEpoch: 1, sentAt: 1, observedAt: 1 })) };
    const viewB = render(<NewSessionDialog serverId="srv-b" ws={wsB as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent('codex-sdk');
    await waitFor(() => expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('gpt-6.2-sol'));
    expect(screen.queryByRole('option', { name: 'gpt-6.8-sol' })).toBeNull();
    viewB.unmount();

    // 3) Third-party preset on codex-sdk keeps preset model even when live catalog arrives; codex CLI sends no requestedModel.
    const wsPreset = makeWs();
    wsPreset.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [{
          name: 'MiniMax',
          env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
          availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3' }],
        }],
      });
      return () => {};
    });
    render(<NewSessionDialog serverId="srv-preset" ws={wsPreset as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'preset-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/preset-app' } });
    selectAgent('codex-sdk');
    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options ?? []).some((option) => option.value === 'MiniMax'));
    expect(presetSelect).toBeDefined();
    fireEvent.input(presetSelect!, { target: { value: 'MiniMax' } });
    await waitFor(() => {
      const modelSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
        .find((select) => Array.from(select.options).some((option) => option.value === 'MiniMax-M2.7'));
      expect(modelSelect?.value).toBe('MiniMax-M2.7');
    });
    const presetReq = wsPreset.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models' && call[0]?.agentType === 'codex-sdk' && call[0]?.ccPreset === 'MiniMax')?.[0];
    act(() => wsPreset.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      ccPreset: 'MiniMax',
      requestId: presetReq?.requestId,
      models: [{ id: 'gpt-6.4-sol' }],
    }));
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(wsPreset.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'codex-sdk',
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M2.7',
    }));
  });

  it('does not let a cached vendor-only preset on the same node pollute a delayed non-preset codex-sdk dialog', async () => {
    // 1) Cache a vendor-only preset catalog on srv-same.
    const ws1 = makeWs();
    ws1.onMessage.mockImplementation((handler: (msg: unknown) => void) => {
      handler({
        type: 'cc.presets.list_response',
        presets: [{
          name: 'MiniMax',
          env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
          availableModels: [{ id: 'MiniMax-M2.7' }],
        }],
      });
      return () => {};
    });
    const first = render(<NewSessionDialog serverId="srv-same" ws={ws1 as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    selectAgent('codex-sdk');
    const presetSelect = (screen.getAllByRole('combobox') as HTMLSelectElement[])
      .find((select) => Array.from(select.options ?? []).some((option) => option.value === 'MiniMax'));
    fireEvent.input(presetSelect!, { target: { value: 'MiniMax' } });
    await waitFor(() => expect(ws1.send.mock.calls.some((c) => c[0]?.type === 'transport.list_models' && c[0]?.ccPreset === 'MiniMax')).toBe(true));
    const req1 = ws1.send.mock.calls.find((c) => c[0]?.type === 'transport.list_models' && c[0]?.ccPreset === 'MiniMax')?.[0];
    act(() => ws1.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      ccPreset: 'MiniMax',
      requestId: req1?.requestId,
      models: [{ id: 'MiniMax-M2.7' }],
      defaultModel: 'MiniMax-M2.7',
    }));
    first.unmount();

    // 2) Mount non-preset codex-sdk on the same node with delayed first-party reply: must use static gpt-6.2-sol, then upgrade on live reply.
    const ws2 = makeWs();
    render(<NewSessionDialog serverId="srv-same" ws={ws2 as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'first-party-app' } });
    fireEvent.input(screen.getByPlaceholderText('~/.imcodes/projects/my-project'), { target: { value: '~/projects/first-party-app' } });
    selectAgent('codex-sdk');
    await waitFor(() => expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('gpt-6.2-sol'));
    expect(screen.queryByRole('option', { name: 'MiniMax-M2.7' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws2.sendSessionCommand).toHaveBeenLastCalledWith('start', expect.objectContaining({
      agentType: 'codex-sdk',
      requestedModel: 'gpt-6.2-sol',
    }));

    const req2 = ws2.send.mock.calls.find((c) => c[0]?.type === 'transport.list_models' && c[0]?.agentType === 'codex-sdk' && !c[0]?.ccPreset)?.[0];
    act(() => ws2.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: req2?.requestId,
      models: [{ id: 'gpt-6.5-sol' }, { id: 'gpt-6-sol' }],
    }));
    await waitFor(() => expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('gpt-6.5-sol'));
  });

  it('auto-populates readable underscore-only ASCII working directory without random suffixes and increments _1/_2 only on existing dirs while preserving sanitizeProjectName and manual dir lock', async () => {
    const ws = makeWs();
    render(<NewSessionDialog serverId="srv-cjk" ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    const projectInput = screen.getByPlaceholderText('my-project') as HTMLInputElement;
    const dirInput = screen.getByPlaceholderText('~/.imcodes/projects/my-project') as HTMLInputElement;

    fireEvent.input(projectInput, { target: { value: '我的项目' } });
    const zhDir = dirInput.value;
    expect(zhDir).toBe('~/.imcodes/projects/wo_de_xiang_mu');

    fireEvent.input(projectInput, { target: { value: 'my-app' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/my_app');

    fireEvent.input(projectInput, { target: { value: '日本語テスト' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/ri_ben_yu_tesuto');

    // Empty/whitespace resets back to base projects dir.
    fireEvent.input(projectInput, { target: { value: '   ' } });
    expect(dirInput.value).toBe('~/.imcodes/projects/');

    // Submitting keeps raw project name; internal sanitizeProjectName stays untouched (uXXXX).
    fireEvent.input(projectInput, { target: { value: '我的项目' } });
    expect(dirInput.value).toBe(zhDir);
    expect(sanitizeProjectName('我的项目')).toBe('u6211_u7684_u9879_u76ee');
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      project: '我的项目',
      dir: zhDir,
    }));

    // Once directory is manually edited, further project name changes do not overwrite dir.
    fireEvent.input(dirInput, { target: { value: '/custom/work/path' } });
    fireEvent.input(projectInput, { target: { value: '另一个项目' } });
    expect(dirInput.value).toBe('/custom/work/path');
  });

  it('defaults to opus[1M] for claude-code-sdk without preset', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('claude-code-sdk');
    await waitFor(() => expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true'));
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'test-cc' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'claude-code-sdk',
      requestedModel: 'opus[1M]',
    }));
  });

  it('defaults to opencode/big-pickle for opencode-sdk without preset', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    selectAgent('opencode-sdk');
    await waitFor(() => expect(getAgentButton('opencode-sdk').getAttribute('aria-pressed')).toBe('true'));
    fireEvent.input(screen.getByPlaceholderText('my-project'), { target: { value: 'test-oc' } });
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('start', expect.objectContaining({
      agentType: 'opencode-sdk',
      requestedModel: 'opencode/big-pickle',
    }));
  });

  it('switching between claude-code-sdk and opencode-sdk updates defaults without residue, and preserves manual edits', async () => {
    const ws = makeWs();
    render(<NewSessionDialog ws={ws as any} onClose={vi.fn()} onSessionStarted={vi.fn()} isProviderConnected={() => false} />);

    const getModelSelect = () => {
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      return selects.find((s) => Array.from(s.options).some((o) => o.value === 'opus[1M]'));
    };

    // 1. Select claude-code-sdk -> opus[1M]
    selectAgent('claude-code-sdk');
    await waitFor(() => expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(getModelSelect()?.value).toBe('opus[1M]'));

    // 2. Switch to opencode-sdk -> opencode/big-pickle
    selectAgent('opencode-sdk');
    await waitFor(() => expect(getAgentButton('opencode-sdk').getAttribute('aria-pressed')).toBe('true'));
    const ocInput = screen.getByPlaceholderText('selectModel') as HTMLInputElement;
    expect(ocInput.value).toBe('opencode/big-pickle');

    // 3. Switch back to claude-code-sdk -> opus[1M]
    selectAgent('claude-code-sdk');
    await waitFor(() => expect(getAgentButton('claude-code-sdk').getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(getModelSelect()?.value).toBe('opus[1M]'));

    // 4. Manually edit to sonnet -> preserved across catalog messages
    const ccSelect2 = getModelSelect()!;
    fireEvent.input(ccSelect2, { target: { value: 'sonnet' } });
    expect(ccSelect2.value).toBe('sonnet');
    const onMessageHandler = ws.onMessage.mock.calls[0]?.[0];
    if (onMessageHandler) {
      act(() => {
        onMessageHandler({
          type: 'transport.list_models',
          agentType: 'claude-code-sdk',
          models: [{ id: 'fable' }, { id: 'opus[1M]' }, { id: 'sonnet' }, { id: 'haiku' }],
          defaultModel: 'opus[1M]',
        });
      });
    }
    expect(ccSelect2.value).toBe('sonnet');
  });
});
