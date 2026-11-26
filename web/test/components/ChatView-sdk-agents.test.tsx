/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  SDK_SUBAGENT_TASK_TYPES,
  type SdkSubagentDetailMeta,
} from '../../../shared/sdk-subagent-status.js';
import { ChatView } from '../../src/components/ChatView.js';
import {
  SDK_AGENTS_AUTO_CLOSE_GRACE_MS,
  SDK_AGENTS_AUTO_OPEN_DELAY_MS,
} from '../../src/timeline/sdk-agents-panel-stability.js';
import { UI_SCALE_EVENT } from '../../src/ui-scale.js';
import type { TimelineEvent } from '../../src/ws-client.js';

const showToolCallsPref = vi.hoisted(() => ({
  value: false as boolean | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      const translations: Record<string, string> = {
        'chat.sdk_agents_toggle': 'Agents',
        'chat.sdk_agents_toggle_aria': 'Toggle SDK agents status, {{count}} running',
        'chat.sdk_agents_badge_aria': '{{count}} SDK agents running',
        'chat.sdk_agents_panel_title': 'Agents',
        'chat.sdk_agents_close': 'Close Agents panel',
        'chat.sdk_agents_running_count': '{{count}} running',
        'chat.sdk_agents_active_section': 'Active',
        'chat.sdk_agents_recent_section': 'Recent',
        'chat.sdk_agents_diagnostics_section': 'Diagnostics',
        'chat.sdk_agents_provider_claude': 'Claude SDK',
        'chat.sdk_agents_provider_codex': 'Codex SDK',
        'chat.sdk_agents_provider_agy': 'Antigravity',
        'chat.sdk_agents_provider_unknown': 'SDK agent',
        'chat.sdk_agents_task_bash': 'Bash / Shell',
        'chat.sdk_agents_task_agent': 'Agent',
        'chat.sdk_agents_task_background': 'Background task',
        'chat.sdk_agents_status_running': 'Running',
        'chat.sdk_agents_status_complete': 'Complete',
        'chat.sdk_agents_status_interrupted': 'Interrupted',
        'chat.sdk_agents_status_unknown': 'Unknown',
        'chat.sdk_agents_id': 'ID',
        'chat.sdk_agents_model': 'Model',
        'chat.sdk_agents_started_at': 'Started',
        'chat.sdk_agents_duration': 'Duration',
        'chat.sdk_agents_tokens': 'Tokens',
        'chat.sdk_agents_prompt': 'Prompt',
        'chat.sdk_agents_result': 'Result',
        'chat.sdk_agents_running_children': '{{count}} child running',
        'chat.sdk_agents_receiver_count': '{{count}} receivers',
        'chat.sdk_agents_diagnostic_unknown_state': 'Unknown provider state',
        'chat.sync_history': 'Sync chat history',
        'chat.no_events': 'No events yet',
        'chat.loading': 'Loading chat...',
      };
      const values = typeof options === 'object' && options ? options : {};
      return (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));
    },
  }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: showToolCallsPref.value,
    rawValue: showToolCallsPref.value,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async (value: boolean) => {
      showToolCallsPref.value = value;
    },
    set: () => undefined,
    reload: async () => true,
  }),
}));

function makeMeta(overrides: Partial<SdkSubagentDetailMeta> = {}): SdkSubagentDetailMeta {
  return {
    isSdkSubagent: true,
    schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
    provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
    providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
    canonicalKey: 'claude:deck_agents:task-1',
    normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
    active: true,
    terminal: false,
    taskId: 'task-1',
    ...overrides,
  };
}

function makeSdkEvent(
  eventId: string,
  meta: SdkSubagentDetailMeta,
  detailExtra: Record<string, unknown> = {},
): TimelineEvent {
  return {
    eventId,
    sessionId: 'deck_agents',
    ts: Date.now(),
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: meta.terminal ? 'tool.result' : 'tool.call',
    hidden: true,
    payload: {
      tool: 'Agent',
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        meta,
        ...detailExtra,
      },
    },
  };
}

describe('ChatView SDK agents panel', () => {
  beforeEach(() => {
    // Production now defaults the global agents toggle OPEN. Most tests below were
    // written for a closed-by-default toggle (they click to open), so seed an
    // explicit '0' here. The dedicated default-open test clears it.
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '0');
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.style.removeProperty('--imcodes-ui-zoom');
    showToolCallsPref.value = false;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('recomputes the titlebar reserve when the UI scale changes', () => {
    let layoutWidth = 100;
    let zoom = 0.7;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const rect = originalGetBoundingClientRect.call(this);
      if (this.classList.contains('chat-top-actions')) {
        return { ...rect, width: layoutWidth * zoom } as DOMRect;
      }
      return rect;
    });
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '0.7');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    const { container, unmount } = render(
      <ChatView events={[]} loading={false} sessionId="deck_scale" onForceSync={() => undefined} />,
    );
    const titlebar = container.querySelector<HTMLElement>('.chat-titlebar');
    expect(titlebar?.style.getPropertyValue('--chat-top-actions-reserve')).toBe('114px');

    // Zoom changes to 125% -> visual rect grows to 125, unscaled reserve stays 114px
    zoom = 1.25;
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '1.25');
    act(() => window.dispatchEvent(new Event(UI_SCALE_EVENT)));
    expect(titlebar?.style.getPropertyValue('--chat-top-actions-reserve')).toBe('114px');

    // Control cluster grows at 70% zoom -> updates reserve to new unscaled width + 14px
    zoom = 0.7;
    layoutWidth = 120;
    document.documentElement.style.setProperty('--imcodes-ui-zoom', '0.7');
    act(() => window.dispatchEvent(new Event(UI_SCALE_EVENT)));
    expect(titlebar?.style.getPropertyValue('--chat-top-actions-reserve')).toBe('134px');

    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith(UI_SCALE_EVENT, expect.any(Function));
  });

  it('shows Bash and true Agent work together while labeling their backend task kinds', () => {
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const bashEvent = makeSdkEvent('bash-running', makeMeta({
      canonicalKey: 'claude:deck_agents:bash-1',
      taskId: 'bash-1',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      childStatusSummary: 'Indexing files',
    }));
    const agentEvent = makeSdkEvent('agent-running', makeMeta({
      canonicalKey: 'claude:deck_agents:agent-1',
      taskId: 'agent-1',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_AGENT,
      childStatusSummary: 'Reviewing changes',
    }));
    const codexBashEvent = makeSdkEvent('codex-bash-running', makeMeta({
      canonicalKey: 'codex:deck_agents:shell:81234',
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_SHELL,
      taskId: '81234',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      childStatusSummary: 'Running tests',
    }));

    const { container } = render(
      <ChatView events={[bashEvent, agentEvent, codexBashEvent]} loading={false} sessionId="deck_agents" />,
    );

    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 3 running' })).toBeTruthy();
    expect(screen.getByText('Indexing files')).toBeTruthy();
    expect(screen.getByText('Reviewing changes')).toBeTruthy();
    expect(screen.getByText('Running tests')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('.chat-sdk-agent-task-kind')).map((node) => node.textContent))
      .toEqual(['Bash / Shell', 'Agent', 'Bash / Shell']);
  });

  it('reuses the Agents panel in preview for background Bash and Agent work only', () => {
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const backgroundBash = makeSdkEvent('bash-running', makeMeta({
      canonicalKey: 'claude:deck_agents:bash-preview',
      taskId: 'bash-preview',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      childStatusSummary: 'Running focused tests',
    }));
    const backgroundAgent = makeSdkEvent('agent-running', makeMeta({
      canonicalKey: 'claude:deck_agents:agent-preview',
      taskId: 'agent-preview',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_AGENT,
      childStatusSummary: 'Reviewing the result',
    }));
    const ordinaryBash: TimelineEvent = {
      eventId: 'ordinary-bash',
      sessionId: 'deck_agents',
      ts: Date.now(),
      seq: 2,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.call',
      payload: {
        tool: 'Bash',
        input: { command: 'pwd' },
        detail: { kind: 'tool_use', summary: 'ordinary short bash' },
      },
    };

    const { container } = render(
      <ChatView
        events={[ordinaryBash, backgroundBash, backgroundAgent]}
        loading={false}
        sessionId="deck_agents"
        preview
      />,
    );

    const panel = container.querySelector('.chat-sdk-agents-panel');
    expect(panel).toBeTruthy();
    expect(panel?.textContent).toContain('2 running');
    expect(panel?.textContent).toContain('Bash / Shell');
    expect(panel?.textContent).toContain('Agent');
    expect(panel?.textContent).toContain('Running focused tests');
    expect(panel?.textContent).toContain('Reviewing the result');
    expect(panel?.textContent).not.toContain('ordinary short bash');
    expect(container.querySelectorAll('.chat-sdk-agent-row')).toHaveLength(2);
    expect(container.querySelector('.chat-sdk-agents-toggle')).toBeTruthy();
  });

  it('renders the Agents toggle immediately before refresh and shows the running badge', () => {
    const onForceSync = vi.fn();
    const { container } = render(
      <ChatView
        events={[makeSdkEvent('agent-running', makeMeta({ childStatusSummary: 'Exploring tests' }))]}
        loading={false}
        sessionId="deck_agents"
        onForceSync={onForceSync}
      />,
    );

    const actions = container.querySelector('.chat-top-actions');
    expect(actions).toBeTruthy();
    const agentsButton = actions?.querySelector('.chat-sdk-agents-toggle');
    const refreshButton = actions?.querySelector('.chat-sync-btn');
    expect(agentsButton?.querySelector('.chat-sdk-agents-glyph')).toBeTruthy();
    expect(agentsButton?.textContent).not.toContain('Agents');
    expect(agentsButton?.textContent).toContain('1');
    expect(refreshButton?.getAttribute('aria-label')).toBe('Sync chat history');
    expect(Array.from(actions?.children ?? []).indexOf(refreshButton as Element))
      .toBeLessThan(Array.from(actions?.children ?? []).indexOf(agentsButton as Element));
  });

  it('auto-closes when runningCount drops to 0 after grace delay, allows manual recent inspect, and honors manual close', () => {
    vi.useFakeTimers();
    const runningEvent = makeSdkEvent('agent-running', makeMeta({ childStatusSummary: 'Checking files' }));
    const terminalEvent = makeSdkEvent('agent-complete', makeMeta({
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Finished child work',
    }));
    const errorEvent = makeSdkEvent('agent-error', makeMeta({
      canonicalKey: 'claude:deck_agents:task-error',
      normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
      active: false,
      terminal: true,
      childStatusSummary: 'Errored child work',
    }));
    const diagnosticEvent = makeSdkEvent('agent-diagnostic', makeMeta({
      canonicalKey: 'claude:deck_agents:diagnostic',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }));
    // Start from an explicit CLOSED state — the toggle defaults OPEN globally.
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '0');
    const { container, rerender } = render(
      <ChatView events={[]} loading={false} sessionId="deck_agents" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    const openZeroButton = screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' });
    expect(openZeroButton.classList.contains('active')).toBe(true);
    expect(openZeroButton.textContent).toContain('0');

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS);
    });
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(true);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }).classList.contains('active')).toBe(true);
    expect(screen.getByText('Checking files')).toBeTruthy();

    // When all agents finish (runningCount === 0), the panel holds through the grace
    // period and then closes automatically, while preserving desired-open = '1'.
    rerender(<ChatView events={[terminalEvent]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_CLOSE_GRACE_MS);
    });
    expect(screen.queryByRole('region', { name: 'Agents' })).toBeNull();
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(false);
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }).classList.contains('active')).toBe(true);

    // Explicit click on the toolbar button while 0 running opens manual inspection of retained recent/error rows.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('Finished child work')).toBeTruthy();

    // Retained diagnostics/errors also remain inspectable when explicitly opened.
    rerender(<ChatView events={[errorEvent, diagnosticEvent]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('Errored child work')).toBeTruthy();
    expect(screen.getByText('Diagnostics')).toBeTruthy();

    // Closing manual idle inspection leaves desired-open = '1' so future running agents still open.
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents panel' }));
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');

    // A subsequent sustained running agent opens automatically again, and closing while running persists '0'.
    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS);
    });
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents panel' }));
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('0');
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    const closedButton = screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' });
    expect(closedButton.textContent).toContain('1');
    expect(closedButton.classList.contains('active')).toBe(false);
  });

  it('defaults the global SDK agents toggle to OPEN when the user has never set it', () => {
    vi.useFakeTimers();
    // Clear the seeded '0' → never set → the global toggle defaults OPEN.
    localStorage.removeItem('chatSdkAgentsPanelOpen:desktop');
    const runningEvent = makeSdkEvent('agent-running', makeMeta({ childStatusSummary: 'Working' }));
    const { container, rerender } = render(
      <ChatView events={[]} loading={false} sessionId="deck_agents" />,
    );

    // No stored preference, yet the toggle reads as open (active) with 0 agents.
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }).classList.contains('active')).toBe(true);

    // A sustained running agent auto-mounts the panel under the default-open toggle.
    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }).classList.contains('active')).toBe(true);
  });

  it('uses hidden raw events even when tool transcript rows are disabled and avoids raw prompts', () => {
    const event = makeSdkEvent(
      'agent-sensitive',
      makeMeta({ childStatusSummary: '2 receivers active' }),
      {
        input: { prompt: 'SECRET_FULL_CHILD_PROMPT' },
        output: 'OUTPUT_FILE:/tmp/result.txt',
        raw: { payload: 'RAW_PROVIDER_PAYLOAD' },
      },
    );
    render(<ChatView events={[event]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }));

    expect(screen.getByText('2 receivers active')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SECRET_FULL_CHILD_PROMPT');
    expect(document.body.textContent).not.toContain('RAW_PROVIDER_PAYLOAD');
    expect(document.body.textContent).not.toContain('OUTPUT_FILE');
  });

  it('renders Claude SDK subagent token usage when provider meta includes usageTotalTokens', () => {
    const event = makeSdkEvent(
      'claude-agent-token-usage',
      makeMeta({
        canonicalKey: 'claude:deck_agents:task-token-usage',
        taskId: 'task-token-usage',
        usageTotalTokens: 4321,
      }),
      { summary: 'Claude child task' },
    );
    render(<ChatView events={[event]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }));

    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('4,321')).toBeTruthy();
  });

  it('uses provider startedAtMs so active sub-agent duration survives app reopen from latest heartbeat only', () => {
    const start = new Date('2026-05-31T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(start + 600_000);
    const event = makeSdkEvent(
      'agent-running-latest-heartbeat',
      makeMeta({
        canonicalKey: 'codex:deck_agents:runtime:019f1926',
        provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT,
        agentPath: '019f1926-a1f2-7391-90e4-e149c2dd9312',
        startedAtMs: start,
        backgrounded: true,
      }),
      { summary: 'Godel' },
    );
    event.ts = start + 600_000;

    render(<ChatView events={[event]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }));

    expect(screen.getByText('10m 0s')).toBeTruthy();
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('does not keep an old cached backgrounded sub-agent heartbeat running forever when terminal result is missing', () => {
    const start = new Date('2026-05-31T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(start + 20 * 60_000);
    const event = makeSdkEvent(
      'agent-running-stale-heartbeat',
      makeMeta({
        canonicalKey: 'codex:deck_agents:runtime:019f1b60',
        provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT,
        agentPath: '019f1b60-5e57-7943-bc1b-32d1ea8151da',
        startedAtMs: start,
        backgrounded: true,
      }),
      { summary: 'Godel' },
    );
    event.ts = start;

    render(<ChatView events={[event]} loading={false} sessionId="deck_agents" />);

    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' })).toBeTruthy();
    expect(screen.queryByText('Godel')).toBeNull();
    expect(screen.queryByText('20m 0s')).toBeNull();
  });

  it('renders agent id, model, start time, duration, prompt, and terminal result details', () => {
    const start = new Date('2026-05-31T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(start.getTime() + 120_000);
    const running = makeSdkEvent(
      'agent-running-details',
      makeMeta({
        canonicalKey: 'claude:deck_agents:runtime:019e80d8',
        normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
        active: true,
        terminal: false,
        agentPath: '019e80d8-44f2-7412-b703-b4ddde653d7f',
        model: 'haiku',
        usageTotalTokens: 1234,
      }),
      {
        summary: 'Hume',
        input: { action: 'claude-runtime-subagent', description: 'Check sync status and report back' },
      },
    );
    running.ts = start.getTime();
    const terminal = makeSdkEvent(
      'agent-complete-details',
      makeMeta({
        canonicalKey: 'claude:deck_agents:runtime:019e80d8',
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
        agentPath: '019e80d8-44f2-7412-b703-b4ddde653d7f',
        model: 'haiku',
        usageTotalTokens: 5678,
      }),
      {
        summary: 'Hume',
        input: { action: 'claude-runtime-subagent', description: 'Check sync status and report back' },
        output: 'Completed the read-only sync wait.',
      },
    );
    terminal.ts = start.getTime() + 120_000;
    const activePeer = makeSdkEvent(
      'agent-peer-running',
      makeMeta({
        canonicalKey: 'claude:deck_agents:runtime:peer',
        taskId: 'task-peer',
        childStatusSummary: 'Peer still running',
      }),
      { summary: 'Peer' },
    );
    render(<ChatView events={[running, terminal, activePeer]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }));

    expect(screen.getByText('019e80d8-44f2-7412-b703-b4ddde653d7f')).toBeTruthy();
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('haiku')).toBeTruthy();
    expect(screen.getByText('2m 0s')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('5,678')).toBeTruthy();
    expect(screen.getByText('Prompt')).toBeTruthy();
    expect(screen.getByText('Check sync status and report back')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('Completed the read-only sync wait.')).toBeTruthy();
  });

  it('prefers safe provider summaries and hides terminal running-child counts', () => {
    const terminal = makeSdkEvent(
      'agent-terminal',
      makeMeta({
        canonicalKey: 'claude:deck_agents:task-terminal',
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
        runningChildCount: 2,
        childStatusSummary: 'running:2',
      }),
      { summary: 'Safe provider summary' },
    );
    const activePeer = makeSdkEvent(
      'agent-peer-running',
      makeMeta({
        canonicalKey: 'claude:deck_agents:task-running',
        taskId: 'task-running',
        childStatusSummary: 'Peer still running',
      }),
    );
    render(<ChatView events={[terminal, activePeer]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }));

    expect(screen.getByText('Safe provider summary')).toBeTruthy();
    expect(document.body.textContent).not.toContain('2 child running');
  });

  it('shows diagnostics only while active agents keep the panel mounted and does not increment the badge', () => {
    const diagnostic = makeSdkEvent('agent-diagnostic', makeMeta({
      canonicalKey: 'claude:deck_agents:diagnostic',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
      rawStatus: 'mystery',
    }));
    const activePeer = makeSdkEvent(
      'agent-peer-running',
      makeMeta({
        canonicalKey: 'claude:deck_agents:task-running',
        taskId: 'task-running',
        childStatusSummary: 'Peer still running',
      }),
    );
    render(<ChatView events={[diagnostic, activePeer]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }));

    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(screen.getByText('Unknown provider state')).toBeTruthy();
    expect(screen.getAllByText('mystery')).toHaveLength(2);
  });

  it('expires terminal rows on the retention clock without waiting for new events', () => {
    vi.useFakeTimers();
    const now = new Date('2026-05-31T12:00:00.000Z');
    vi.setSystemTime(now);
    const terminalEvent = makeSdkEvent('agent-complete', makeMeta({
      canonicalKey: 'claude:deck_agents:task-complete',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Finished child work',
    }));
    terminalEvent.ts = now.getTime() - 299_000;
    const runningEvent = makeSdkEvent('agent-running', makeMeta({
      canonicalKey: 'claude:deck_agents:task-running',
      taskId: 'task-running',
      childStatusSummary: 'Still running',
    }));
    runningEvent.ts = now.getTime();
    // Toggle defaults OPEN, so the panel is already mounted with 1 running agent.
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const { container } = render(
      <ChatView events={[terminalEvent, runningEvent]} loading={false} sessionId="deck_agents" />,
    );

    expect(screen.getByText('Finished child work')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();
    expect(screen.queryByText('Finished child work')).toBeNull();
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');
  });

  it('closes cleanly after grace delay when active work finishes even if manual recent inspect had been used beforehand', () => {
    vi.useFakeTimers();
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const firstDone = makeSdkEvent('agent-done-1', makeMeta({
      canonicalKey: 'claude:deck_agents:done-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'First finished',
    }));
    const secondRunning = makeSdkEvent('agent-run-2', makeMeta({
      canonicalKey: 'claude:deck_agents:run-2',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      childStatusSummary: 'Second running',
    }));
    const secondDone = makeSdkEvent('agent-done-2', makeMeta({
      canonicalKey: 'claude:deck_agents:run-2',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Second finished',
    }));

    const { rerender } = render(
      <ChatView events={[firstDone]} loading={false} sessionId="deck_agents" />,
    );
    expect(screen.queryByRole('region', { name: 'Agents' })).toBeNull();

    // User manually opens while 0 running.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('First finished')).toBeTruthy();

    // New running agent starts -> panel remains seamlessly open without gap, then finishes and auto-closes after grace delay.
    rerender(<ChatView events={[firstDone, secondRunning]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('Second running')).toBeTruthy();

    rerender(<ChatView events={[firstDone, secondDone]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_CLOSE_GRACE_MS);
    });
    expect(screen.queryByRole('region', { name: 'Agents' })).toBeNull();
  });

  it('refreshes active duration immediately when visible switches from false to true', () => {
    const start = new Date('2026-05-31T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const running = makeSdkEvent('agent-visibility-sync', makeMeta({
      canonicalKey: 'claude:deck_agents:vis-sync',
      startedAtMs: start,
      childStatusSummary: 'Background sync task',
    }));
    running.ts = start;

    const { rerender } = render(
      <ChatView events={[running]} loading={false} sessionId="deck_agents" visible={false} />,
    );

    act(() => {
      vi.setSystemTime(start + 45_000);
    });

    rerender(<ChatView events={[running]} loading={false} sessionId="deck_agents" visible />);
    expect(screen.getByText('45s')).toBeTruthy();
  });

  it('displays AGY_RUNTIME_AGENT local_bash background commands as Bash / Shell alongside native AGY subagents and clears when terminal', () => {
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const agyBashRunning = makeSdkEvent('agy-bash-running', makeMeta({
      canonicalKey: 'agy:deck_agents:bg_task-7',
      provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
      taskId: 'conv-1/task-7',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      backgrounded: true,
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { summary: 'docker compose logs -f' });

    const agyNativeSubagent = makeSdkEvent('agy-subagent-running', makeMeta({
      canonicalKey: 'agy:deck_agents:sub:child-1',
      provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
      agentPath: 'child-1',
      agentName: 'Researcher',
      taskType: SDK_SUBAGENT_TASK_TYPES.AGENT,
      backgrounded: true,
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    }), { summary: 'Antigravity sub-agent Researcher' });

    const { container, rerender } = render(
      <ChatView events={[agyBashRunning, agyNativeSubagent]} loading={false} sessionId="deck_agents" />,
    );

    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 2 running' })).toBeTruthy();
    expect(screen.getByText('docker compose logs -f')).toBeTruthy();
    expect(screen.getByText('Antigravity sub-agent Researcher')).toBeTruthy();
    const providers = [...container.querySelectorAll('.chat-sdk-agent-provider')].map((el) => el.textContent);
    const taskKinds = [...container.querySelectorAll('.chat-sdk-agent-task-kind')].map((el) => el.textContent);
    expect(providers).toEqual(['Antigravity', 'Antigravity']);
    expect(taskKinds).toEqual(['Bash / Shell', 'Agent']);

    const agyBashStopped = makeSdkEvent('agy-bash-stopped', makeMeta({
      canonicalKey: 'agy:deck_agents:bg_task-7',
      provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
      taskId: 'conv-1/task-7',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      backgrounded: true,
      normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED,
      active: false,
      terminal: true,
    }), { summary: 'docker compose logs -f', output: 'Session stopped' });

    const agyNativeDone = makeSdkEvent('agy-subagent-done', makeMeta({
      canonicalKey: 'agy:deck_agents:sub:child-1',
      provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
      agentPath: 'child-1',
      agentName: 'Researcher',
      taskType: SDK_SUBAGENT_TASK_TYPES.AGENT,
      backgrounded: true,
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    }), { summary: 'Antigravity sub-agent Researcher', output: 'done' });

    rerender(<ChatView events={[agyBashRunning, agyNativeSubagent, agyBashStopped, agyNativeDone]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' })).toBeTruthy();
    // Panel renders on initial mount (already running); closing requires waiting or checking after grace timeout if fake timers used.
  });

  it('resets inspectRecentAgentsOpen synchronously when sessionId changes so the panel never flashes before effects run', () => {
    const terminalA = makeSdkEvent('agent-a-done', makeMeta({
      canonicalKey: 'claude:deck_a:done',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Tab A finished work',
    }));
    const terminalB = makeSdkEvent('agent-b-done', makeMeta({
      canonicalKey: 'claude:deck_b:done',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Tab B finished work',
    }));

    const prePaintPanelSeen: Array<{ sessionId: string; open: boolean }> = [];
    function Wrapper({ sessionId, events }: { sessionId: string; events: TimelineEvent[] }) {
      const hostRef = useRef<HTMLDivElement | null>(null);
      useLayoutEffect(() => {
        const hasPanel = Boolean(hostRef.current?.querySelector('.chat-sdk-agents-panel'));
        prePaintPanelSeen.push({ sessionId, open: hasPanel });
      }, [sessionId]);
      return (
        <div ref={hostRef}>
          <ChatView events={events} loading={false} sessionId={sessionId} />
        </div>
      );
    }

    const { container, rerender } = render(<Wrapper sessionId="deck_a" events={[terminalA]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    // Open manual recent-agents inspection on Tab A and verify toggling works within the same session.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();

    // Switch to Tab B (also 0 running + recent rows): pre-paint layout commit must already have panel closed.
    prePaintPanelSeen.length = 0;
    rerender(<Wrapper sessionId="deck_b" events={[terminalB]} />);
    expect(prePaintPanelSeen).toEqual([{ sessionId: 'deck_b', open: false }]);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    // Switching back to Tab A keeps it closed, and toggling within Tab A still works cleanly.
    rerender(<Wrapper sessionId="deck_a" events={[terminalA]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();
  });

  it('suppresses transient 0->1->0 bursts shorter than open delay, keeps panel mounted across <2500ms back-to-back tasks, and closes after grace window', () => {
    vi.useFakeTimers();
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const now = Date.now();
    const idleDone = makeSdkEvent('done-0', makeMeta({
      canonicalKey: 'claude:deck_agents:idle-0',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Previous task',
    }));
    const shortRun = makeSdkEvent('short-run', makeMeta({
      canonicalKey: 'claude:deck_agents:short-1',
      taskId: 'short-1',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      childStatusSummary: 'Quick ls command',
    }));
    const shortDone = makeSdkEvent('short-done', makeMeta({
      canonicalKey: 'claude:deck_agents:short-1',
      taskId: 'short-1',
      taskType: SDK_SUBAGENT_TASK_TYPES.LOCAL_BASH,
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Quick ls command done',
    }));
    const sustainedRun1 = makeSdkEvent('sustained-run-1', makeMeta({
      canonicalKey: 'claude:deck_agents:sus-1',
      taskId: 'sus-1',
      childStatusSummary: 'Task A running',
    }));
    const sustainedDone1 = makeSdkEvent('sustained-done-1', makeMeta({
      canonicalKey: 'claude:deck_agents:sus-1',
      taskId: 'sus-1',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Task A done',
    }));
    const sustainedRun2 = makeSdkEvent('sustained-run-2', makeMeta({
      canonicalKey: 'claude:deck_agents:sus-2',
      taskId: 'sus-2',
      childStatusSummary: 'Task B running',
    }));
    const sustainedDone2 = makeSdkEvent('sustained-done-2', makeMeta({
      canonicalKey: 'claude:deck_agents:sus-2',
      taskId: 'sus-2',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Task B done',
    }));

    const { container, rerender } = render(
      <ChatView events={[idleDone]} loading={false} sessionId="deck_agents" />,
    );
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(false);

    // 1) Transient 0 -> 1 -> 0 burst (< 450ms): badge reflects 1 running, panel NEVER mounts or flips .chat-split.
    rerender(<ChatView events={[idleDone, shortRun]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' })).toBeTruthy();
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS - 100);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    rerender(<ChatView events={[idleDone, shortDone]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS + 500);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(false);

    // 2) Sustained 0 -> 1 task (>= 450ms): mounts panel cleanly even if extra updates arrive at 200ms.
    rerender(<ChatView events={[idleDone, sustainedRun1]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    rerender(<ChatView events={[idleDone, sustainedRun1, shortDone]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS - 200);
    });
    const panelNode = container.querySelector('.chat-sdk-agents-panel');
    expect(panelNode).toBeTruthy();
    expect(screen.getByText('Task A running')).toBeTruthy();

    // 3) Task A completes -> idle for < 2500ms -> Task B starts: same panel DOM node stays mounted with zero flicker.
    rerender(<ChatView events={[idleDone, sustainedDone1]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_CLOSE_GRACE_MS - 500);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBe(panelNode);

    rerender(<ChatView events={[idleDone, sustainedDone1, sustainedRun2]} loading={false} sessionId="deck_agents" />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBe(panelNode);
    expect(screen.getByText('Task B running')).toBeTruthy();

    // 4) Final task finishes and stays idle >= 2500ms -> auto-closes cleanly.
    rerender(<ChatView events={[idleDone, sustainedDone1, sustainedDone2]} loading={false} sessionId="deck_agents" />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBe(panelNode);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_CLOSE_GRACE_MS);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(now).toBeGreaterThan(0);
  });

  it('closes immediately via manual controls inside grace window, when desiredAgentsOpen flips off, or when rows expire, and resets synchronously on sessionId switch', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
    const runningA = makeSdkEvent('run-a', makeMeta({
      canonicalKey: 'claude:deck_a:run-1',
      taskId: 'run-a',
      childStatusSummary: 'Session A running',
    }));
    runningA.ts = now;
    const doneA = makeSdkEvent('done-a', makeMeta({
      canonicalKey: 'claude:deck_a:run-1',
      taskId: 'run-a',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Session A done',
    }));
    doneA.ts = now;
    const doneB = makeSdkEvent('done-b', makeMeta({
      canonicalKey: 'claude:deck_b:done-1',
      taskId: 'done-b',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Session B idle',
    }));
    doneB.ts = now;
    const runningC = makeSdkEvent('run-c', makeMeta({
      canonicalKey: 'claude:deck_c:run-1',
      taskId: 'run-c',
      childStatusSummary: 'Session C active',
    }));
    runningC.ts = now;

    const prePaintSeen: Array<{ sessionId: string; open: boolean }> = [];
    function Wrapper({ sessionId, events }: { sessionId: string; events: TimelineEvent[] }) {
      const hostRef = useRef<HTMLDivElement | null>(null);
      useLayoutEffect(() => {
        prePaintSeen.push({ sessionId, open: Boolean(hostRef.current?.querySelector('.chat-sdk-agents-panel')) });
      }, [sessionId]);
      return (
        <div ref={hostRef}>
          <ChatView events={events} loading={false} sessionId={sessionId} />
        </div>
      );
    }

    const { container, rerender, unmount } = render(<Wrapper sessionId="deck_a" events={[runningA]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();

    // 1) Drop to 0 running -> inside grace window -> clicking close responds immediately without flipping desiredAgentsOpen.
    rerender(<Wrapper sessionId="deck_a" events={[doneA]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents panel' }));
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');

    // 2) Re-enter running (after 450ms open) -> drop to 0 -> toolbar toggle also closes immediately in grace window.
    rerender(<Wrapper sessionId="deck_a" events={[runningA]} />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS);
    });
    rerender(<Wrapper sessionId="deck_a" events={[doneA]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');

    // 3) Pending open timer on session A is cancelled when switching to idle session B (zero render-1 flash),
    //    while switching to already-active session C mounts immediately.
    rerender(<Wrapper sessionId="deck_a" events={[runningA]} />);
    prePaintSeen.length = 0;
    rerender(<Wrapper sessionId="deck_b" events={[doneB]} />);
    expect(prePaintSeen).toEqual([{ sessionId: 'deck_b', open: false }]);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS + 100);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    prePaintSeen.length = 0;
    rerender(<Wrapper sessionId="deck_c" events={[runningC]} />);
    expect(prePaintSeen).toEqual([{ sessionId: 'deck_c', open: true }]);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();

    // 4) If retained rows disappear during grace window (hasAgentsStatusRows -> false), closes immediately.
    rerender(<Wrapper sessionId="deck_c" events={[]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    // 5) Global desiredAgentsOpen flipped off while open or pending cancels timers and closes immediately.
    rerender(<Wrapper sessionId="deck_c" events={[runningC]} />);
    act(() => {
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeTruthy();
    act(() => {
      localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '0');
      window.dispatchEvent(new Event('deck:sdk-agents-panel-open-changed'));
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    rerender(<Wrapper sessionId="deck_c" events={[doneB]} />);
    act(() => {
      localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
      window.dispatchEvent(new Event('deck:sdk-agents-panel-open-changed'));
    });
    rerender(<Wrapper sessionId="deck_c" events={[runningC]} />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    act(() => {
      localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '0');
      window.dispatchEvent(new Event('deck:sdk-agents-panel-open-changed'));
      vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS + 100);
    });
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    // 6) Pending open timer (including preview={true} cards) is cleared cleanly on unmount.
    act(() => {
      localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '1');
      window.dispatchEvent(new Event('deck:sdk-agents-panel-open-changed'));
    });
    unmount();
    const baselineTimers = vi.getTimerCount();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const previewCard = render(<ChatView events={[doneB]} loading={false} sessionId="deck_preview" preview />);
      previewCard.rerender(<ChatView events={[runningC]} loading={false} sessionId="deck_preview" preview />);
      expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers);
      clearTimeoutSpy.mockClear();
      previewCard.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(baselineTimers);
      act(() => {
        vi.advanceTimersByTime(SDK_AGENTS_AUTO_OPEN_DELAY_MS + 100);
      });
      expect(previewCard.container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});
