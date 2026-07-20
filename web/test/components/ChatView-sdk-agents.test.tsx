/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  type SdkSubagentDetailMeta,
} from '../../../shared/sdk-subagent-status.js';
import { ChatView } from '../../src/components/ChatView.js';
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
        'chat.sdk_agents_provider_unknown': 'SDK agent',
        'chat.sdk_agents_status_running': 'Running',
        'chat.sdk_agents_status_complete': 'Complete',
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
    showToolCallsPref.value = false;
    vi.useRealTimers();
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

  it('remembers desired-open state, keeps all retained agent statuses visible, and honors manual close', () => {
    const runningEvent = makeSdkEvent('agent-running', makeMeta({ childStatusSummary: 'Checking files' }));
    const terminalEvent = makeSdkEvent('agent-complete', makeMeta({
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      childStatusSummary: 'Finished child work',
    }));
    const diagnosticEvent = makeSdkEvent('agent-diagnostic', makeMeta({
      canonicalKey: 'claude:deck_agents:diagnostic',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    }));
    // Start from an explicit CLOSED state — the toggle now defaults OPEN globally.
    localStorage.setItem('chatSdkAgentsPanelOpen:desktop', '0');
    const { container, rerender } = render(
      <ChatView events={[]} loading={false} sessionId="deck_agents" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    // `.active` now reflects the OPEN/closed toggle state, not whether agents are
    // running: toggled open with 0 agents is still active, and the badge shows 0.
    const openZeroButton = screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' });
    expect(openZeroButton.classList.contains('active')).toBe(true);
    expect(openZeroButton.textContent).toContain('0');

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(true);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }).classList.contains('active')).toBe(true);
    expect(screen.getByText('Checking files')).toBeTruthy();

    rerender(<ChatView events={[terminalEvent]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('Finished child work')).toBeTruthy();
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(true);
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');
    // Finished agents remain visible while retained; the badge still reports
    // only active children.
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }).classList.contains('active')).toBe(true);

    rerender(<ChatView events={[diagnosticEvent]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(true);
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('1');

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents panel' }));
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBe('0');
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    const closedButton = screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' });
    expect(closedButton.textContent).toContain('1');
    expect(closedButton.classList.contains('active')).toBe(false);
  });

  it('defaults the global SDK agents toggle to OPEN when the user has never set it', () => {
    // Clear the seeded '0' → never set → the global toggle defaults OPEN.
    localStorage.removeItem('chatSdkAgentsPanelOpen:desktop');
    const runningEvent = makeSdkEvent('agent-running', makeMeta({ childStatusSummary: 'Working' }));
    const { container, rerender } = render(
      <ChatView events={[]} loading={false} sessionId="deck_agents" />,
    );

    // No stored preference, yet the toggle reads as open (active) with 0 agents.
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:desktop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }).classList.contains('active')).toBe(true);

    // A running agent auto-mounts the panel under the default-open toggle.
    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
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
});
