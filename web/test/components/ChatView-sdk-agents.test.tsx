/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(agentsButton?.textContent).toContain('Agents');
    expect(agentsButton?.textContent).toContain('1');
    expect(refreshButton?.getAttribute('aria-label')).toBe('Sync chat history');
    expect(Array.from(actions?.children ?? []).indexOf(agentsButton as Element))
      .toBeLessThan(Array.from(actions?.children ?? []).indexOf(refreshButton as Element));
  });

  it('remembers desired-open state, auto-hides empty data, and manual close suppresses auto-show', () => {
    const runningEvent = makeSdkEvent('agent-running', makeMeta({ childStatusSummary: 'Checking files' }));
    const { container, rerender } = render(
      <ChatView events={[]} loading={false} sessionId="deck_agents" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:deck_agents')).toBe('1');
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    expect(container.querySelector('.chat-view-wrap')?.classList.contains('chat-split')).toBe(true);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('Checking files')).toBeTruthy();

    rerender(<ChatView events={[]} loading={false} sessionId="deck_agents" />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:deck_agents')).toBe('1');

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents panel' }));
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:deck_agents')).toBe('0');
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();

    rerender(<ChatView events={[runningEvent]} loading={false} sessionId="deck_agents" />);
    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle SDK agents status, 1 running' }).textContent).toContain('1');
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
    render(<ChatView events={[terminal]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));

    expect(screen.getByText('Safe provider summary')).toBeTruthy();
    expect(document.body.textContent).not.toContain('2 child running');
  });

  it('renders diagnostics without incrementing the badge', () => {
    const diagnostic = makeSdkEvent('agent-diagnostic', makeMeta({
      canonicalKey: 'claude:deck_agents:diagnostic',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
      rawStatus: 'mystery',
    }));
    render(<ChatView events={[diagnostic]} loading={false} sessionId="deck_agents" />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));

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
    const { container } = render(
      <ChatView events={[terminalEvent]} loading={false} sessionId="deck_agents" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle SDK agents status, 0 running' }));
    expect(screen.getByText('Finished child work')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(container.querySelector('.chat-sdk-agents-panel')).toBeNull();
    expect(localStorage.getItem('chatSdkAgentsPanelOpen:deck_agents')).toBe('1');
  });
});
