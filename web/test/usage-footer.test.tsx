/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { h } from 'preact';

const toolPref = vi.hoisted(() => ({
  value: true as boolean | null,
  save: vi.fn(async (_value: boolean) => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'session.state_idle': 'Agent idle — waiting for input',
        'session.state_running': 'Agent working...',
        'session.state_running_detail': 'Agent working: {{detail}}',
        'session.state_error': 'Session error',
        'session.state_error_detail': 'Error: {{error}}',
        'session.state_stop_requested': 'Stop requested',
      };
      if (translations[key]) {
        return translations[key].replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''));
      }
      if (key === 'session.provider_plan_title') return `Plan: ${String(opts?.value ?? '')}`;
      if (key === 'session.provider_quota_title') return `Quota: ${String(opts?.value ?? '')}`;
      if (key === 'session.provider_quota_usage_title') return `Quota usage: ${String(opts?.value ?? '')}`;
      if (key === 'session.provider_plan_free') return 'Free';
      if (key === 'session.provider_plan_paid') return 'Paid';
      if (key === 'session.provider_plan_byo') return 'BYO';
      if (key === 'chat.thinking_running') return `thinking ${String(opts?.sec ?? '')}`;
      return key;
    },
  }),
}));

vi.mock('../src/cost-tracker.js', () => ({
  getSessionCost: () => 0,
  getWeeklyCost: () => 0,
  getMonthlyCost: () => 0,
  formatCost: (n: number) => `$${n.toFixed(2)}`,
}));

vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: toolPref.value,
    rawValue: toolPref.value,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: toolPref.save,
    set: () => undefined,
    reload: async () => toolPref.value,
  }),
}));

import { UsageFooter } from '../src/components/UsageFooter.js';
import { USAGE_CONTEXT_WINDOW_SOURCES } from '@shared/usage-context-window.js';

function expectRobotAvatar(root: ParentNode | null | undefined) {
  const avatar = root?.querySelector('.session-live-status-robot-avatar') as HTMLImageElement | null;
  expect(avatar).toBeTruthy();
  expect(avatar?.getAttribute('src')).toBe('/imcodes-robot-avatar.png');
  expect(avatar?.getAttribute('alt')).toBe('');
}

afterEach(() => {
  cleanup();
  toolPref.value = true;
  toolPref.save.mockClear();
});

describe('UsageFooter', () => {
  it('renders the execution-clone launcher before summary sync and calls its handler', () => {
    const onRunExecutionClones = vi.fn();
    const onSyncMemorySummaries = vi.fn();
    const { container } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_test_brain"
        onRunExecutionClones={onRunExecutionClones}
        runExecutionClonesTitle="Run clones"
        runExecutionClonesCount={3}
        onSyncMemorySummaries={onSyncMemorySummaries}
      />,
    );

    const cloneButton = screen.getByLabelText('Run clones');
    const syncButton = screen.getByLabelText('chat.memory_summary_sync');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.indexOf(cloneButton as HTMLButtonElement)).toBeLessThan(buttons.indexOf(syncButton as HTMLButtonElement));
    expect(cloneButton.textContent).toContain('🤖');
    expect(cloneButton.textContent).toContain('×3');

    fireEvent.click(cloneButton);
    expect(onRunExecutionClones).toHaveBeenCalledTimes(1);
    expect(onSyncMemorySummaries).not.toHaveBeenCalled();
  });

  it('disables the execution-clone launcher when requested', () => {
    const onRunExecutionClones = vi.fn();
    render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_test_brain"
        onRunExecutionClones={onRunExecutionClones}
        runExecutionClonesTitle="No task"
        runExecutionClonesDisabled
      />,
    );

    const cloneButton = screen.getByLabelText('No task') as HTMLButtonElement;
    expect(cloneButton.disabled).toBe(true);
  });

  it('keeps the robot status row visible without hosting the repo branch summary', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 1000,
          cacheTokens: 2000,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="running"
      />,
    );

    const footer = container.querySelector('.session-usage-footer') as HTMLDivElement;
    const ctxBar = container.querySelector('.session-ctx-bar');
    const statsRow = container.querySelector('.session-usage-stats');
    const liveStatus = container.querySelector('.session-live-status-inline.running');
    const children = Array.from(footer.children);

    expectRobotAvatar(liveStatus);
    expect(liveStatus?.textContent).toContain('⚙️');
    expect(liveStatus?.textContent).toContain('Agent working...');
    expect(container.querySelector('.session-repo-branch-summary')).toBeNull();
    expect(children.indexOf(ctxBar as Element)).toBeLessThan(children.indexOf(statsRow as Element));
  });

  it('shows transport activity detail when running is blocked by a specific reason', () => {
    const { container } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_test_brain"
        sessionState="running"
        transportActivityDetail="provider_compaction"
      />,
    );

    const liveStatus = container.querySelector('.session-live-status-inline.running');
    expect(liveStatus?.textContent).toContain('Agent working: provider_compaction');
  });

  it('shows the concrete session error reason from the session summary', () => {
    const { container } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_error_brain"
        sessionState="error"
        agentType="codex"
        sessionError="Restart loop detected: more than 3 restarts within 5 minutes"
      />,
    );

    const liveStatus = container.querySelector('.session-live-status-inline.error');
    expect(liveStatus?.textContent).toContain('Error: Restart loop detected: more than 3 restarts within 5 minutes');
  });

  it('briefly shows a compact burning effect when ctx usage changes', async () => {
    const { container, rerender } = render(
      <UsageFooter
        usage={{
          inputTokens: 1000,
          cacheTokens: 2000,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
      />,
    );

    expect(container.querySelector('.session-ctx-bar')?.className).not.toContain('is-burning');

    rerender(
      <UsageFooter
        usage={{
          inputTokens: 5000,
          cacheTokens: 3000,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.session-ctx-bar')?.className).toContain('is-burning');
    });
    const burn = container.querySelector('.session-ctx-burn') as HTMLElement | null;
    const edge = container.querySelector('.session-ctx-burn-edge') as HTMLElement | null;
    expect(burn).toBeTruthy();
    expect(burn?.style.width).toBe('0.8%');
    expect(edge).toBeTruthy();
    expect(edge?.style.left).toBe('0.8%');
  });

  it('moves the MiniMax ctx endpoint and cache segment from live stream usage', async () => {
    const usage = (inputTokens: number, cacheTokens: number) => ({
      inputTokens,
      cacheTokens,
      contextWindow: 1_000_000,
      contextWindowSource: USAGE_CONTEXT_WINDOW_SOURCES.PRESET,
      model: 'MiniMax-M3',
    });
    const { container, rerender } = render(
      <UsageFooter usage={usage(437_967, 0)} sessionName="deck_sub_minimax" />,
    );

    const input = () => container.querySelector('.session-ctx-input') as HTMLElement | null;
    const cache = () => container.querySelector('.session-ctx-cache') as HTMLElement | null;
    expect(input()?.style.width).toBe('43.7967%');
    expect(cache()?.style.width).toBe('0%');

    // Real MiniMax stream fixture: 5,063 uncached + 452,608 cache-read tokens.
    rerender(<UsageFooter usage={usage(5_063, 452_608)} sessionName="deck_sub_minimax" />);

    await waitFor(() => {
      expect(cache()?.style.width).toBe('45.2608%');
      expect(input()?.style.width).toBe('0.5063%');
      expect(input()?.style.left).toBe('45.2608%');
      expect((container.querySelector('.session-ctx-burn-edge') as HTMLElement | null)?.style.left).toBe('45.7671%');
    });
  });

  it('keeps the robot status visible for idle or unknown agent states', () => {
    const { container, rerender } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 0,
        }}
        sessionName="deck_test_brain"
      />,
    );

    let status = container.querySelector('.session-live-status-inline.idle') as HTMLSpanElement | null;
    expectRobotAvatar(status);
    expect(status?.textContent).toContain('💤');
    expect(status?.getAttribute('aria-label')).toContain('Agent idle');

    rerender(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 0,
        }}
        sessionName="deck_test_brain"
        sessionState="stopped"
      />,
    );

    status = container.querySelector('.session-live-status-inline.idle') as HTMLSpanElement | null;
    expectRobotAvatar(status);
    expect(status?.textContent).toContain('💤');
    expect(status?.getAttribute('aria-label')).toContain('Agent idle');
  });

  it('defaults the tools/thinking toggle on while undecided and first click turns it off', () => {
    toolPref.value = null;

    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
      />,
    );

    expect(container.querySelector('.shortcut-btn-tools-bubble')).toBeTruthy();
    const button = container.querySelector('.shortcut-btn-tools') as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    expect(button?.className).toContain('is-on');

    fireEvent.click(button!);

    expect(toolPref.save).toHaveBeenCalledWith(false);
  });

  it('renders memory summary sync button before the tools toggle and calls the sync handler', () => {
    const onSync = vi.fn();
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        onSyncMemorySummaries={onSync}
      />,
    );

    const syncButton = container.querySelector('.shortcut-btn-memory-sync') as HTMLButtonElement | null;
    const toolsButton = container.querySelector('.shortcut-btn-tools') as HTMLButtonElement | null;
    expect(syncButton).toBeTruthy();
    expect(syncButton?.getAttribute('aria-label')).toBe('chat.memory_summary_sync');
    expect(Array.from(syncButton!.parentElement!.children).indexOf(syncButton!)).toBeLessThan(
      Array.from(toolsButton!.parentElement!.parentElement!.children).indexOf(toolsButton!.parentElement!),
    );

    fireEvent.click(syncButton!);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the robot idle when only stale thinking remains, and renders running states inline', () => {
    const { container, rerender } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="idle"
        activeThinkingTs={Date.now() - 5_000}
      />,
    );

    const staleIdleStatus = container.querySelector('.session-live-status-inline.idle') as HTMLSpanElement | null;
    expectRobotAvatar(staleIdleStatus);
    expect(staleIdleStatus?.textContent).toContain('💤');
    expect(staleIdleStatus?.getAttribute('aria-label')).toBe('Agent idle — waiting for input');
    expect(container.querySelector('.session-live-status-inline.thinking')).toBeNull();

    rerender(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="running"
        activeThinkingTs={Date.now() - 5_000}
      />,
    );

    const runningStatus = container.querySelector('.session-live-status-inline') as HTMLSpanElement | null;
    expectRobotAvatar(runningStatus);
    expect(runningStatus?.textContent).toContain('💭');
    expect(runningStatus?.getAttribute('aria-label')).toContain('thinking');
    expect(container.querySelector('.session-live-status-inline.thinking')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.thinking .session-live-status-emoji.thought')).toBeTruthy();
    expect(container.querySelector('.session-live-status-text')?.textContent).toContain('thinking');

    rerender(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="running"
      />,
    );

    const plainRunningStatus = container.querySelector('.session-live-status-inline') as HTMLSpanElement | null;
    expectRobotAvatar(plainRunningStatus);
    expect(plainRunningStatus?.textContent).toContain('⚙️');
    expect(container.querySelector('.session-live-status-inline.running .session-live-status-emoji.gear')).toBeTruthy();
  });

  it('keeps the robot idle when only stale transport-turn evidence remains', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="idle"
        activeTimelineTurn={true}
      />,
    );

    const idleStatus = container.querySelector('.session-live-status-inline.idle') as HTMLSpanElement | null;
    expectRobotAvatar(idleStatus);
    expect(idleStatus?.textContent).toContain('💤');
    expect(idleStatus?.getAttribute('aria-label')).toBe('Agent idle — waiting for input');
    expect(container.querySelector('.session-live-status-inline.running')).toBeNull();
  });

  it('switches the robot to running immediately while an optimistic send is unresolved', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="idle"
        pendingUserSend={true}
      />,
    );

    expect(container.querySelector('.session-live-status-inline.running')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.running .session-live-status-emoji.gear')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.idle')).toBeNull();
  });

  it('keeps the robot running from authoritative session state even when timeline tail has settled', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="running"
        activeTimelineTurn={false}
      />,
    );

    expect(container.textContent ?? '').toContain('Agent working');
    expect(container.querySelector('.session-live-status-inline.running')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.idle')).toBeNull();
  });

  it('shows tool-call icon when explicit running status text is present', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="running"
        statusText="Reading file..."
        activeToolCall={true}
      />,
    );

    expect((container.querySelector('.session-live-status-inline') as HTMLSpanElement | null)?.textContent).toContain('🔍');
    expect(container.querySelector('.session-live-status-inline.tool .session-live-status-emoji.tool')).toBeTruthy();
    expect(container.querySelector('.session-live-status-text')?.textContent).toBe('Reading file...');
    expect((container.querySelector('.session-live-status-inline') as HTMLSpanElement | null)?.getAttribute('aria-label')).toBe('Reading file...');
  });

  it('shows stop requested and cancelled feedback from the shared live status', () => {
    const { container, rerender } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 1_000_000, model: 'coder-model' }}
        sessionName="deck_test_brain"
        sessionState="stopping"
      />,
    );

    expect(container.querySelector('.session-live-status-inline.stopping')).toBeTruthy();
    expect(container.textContent).toContain('Stop requested');

    rerender(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 1_000_000, model: 'coder-model' }}
        sessionName="deck_test_brain"
        sessionState="idle"
        sessionError="Turn cancelled by user stop"
      />,
    );

    expect(container.querySelector('.session-live-status-inline.cancelled')).toBeTruthy();
    expect(container.textContent).toContain('Error: Turn cancelled by user stop');
  });

  it('shows a waiting indicator when idle has an active supervision status', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="idle"
        statusText="Checking whether the task is complete..."
      />,
    );

    expect(container.querySelector('.session-live-status-inline.idle')).toBeNull();
    expect(container.querySelector('.session-live-status-inline.waiting')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.waiting .session-live-status-emoji.wait')).toBeTruthy();
    expect(container.querySelector('.session-live-status-text')?.textContent).toBe('Checking whether the task is complete...');
  });

  it('shows a result indicator when idle has a supervised outcome status', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        sessionState="idle"
        statusText="Supervised: task looks complete."
      />,
    );

    expect(container.querySelector('.session-live-status-inline.result')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.result .session-live-status-emoji.result')).toBeTruthy();
    expect(container.querySelector('.session-live-status-text')?.textContent).toBe('Supervised: task looks complete.');
  });

  it('renders explicit quota label inline in the ctx footer', () => {
    render(
      <UsageFooter
        usage={{
          inputTokens: 2000,
          cacheTokens: 1000,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        agentType="codex-sdk"
        modelOverride="gpt-5"
        planLabel="Free"
        quotaLabel="5h 43% 2h03m 4/6 14:40 · 7d 34% 1d04h 4/8 15:48"
      />,
    );

    expect(screen.getByText('gpt-5')).toBeDefined();
    expect(screen.getByText(/5h 43% 2h03m 4\/6 14:40/)).toBeDefined();
    expect(screen.getByText(/7d 34% 1d04h 4\/8 15:48/)).toBeDefined();
  });

  it('does not render stale codexStatus data when no explicit quota label is present', () => {
    render(
      <UsageFooter
        usage={{
          inputTokens: 2000,
          cacheTokens: 1000,
          contextWindow: 1_000_000,
          model: 'coder-model',
          codexStatus: {
            capturedAt: 1,
            fiveHourLeftPercent: 43,
            fiveHourResetAt: '4/6 14:40',
            weeklyLeftPercent: 34,
            weeklyResetAt: '4/8 15:48',
          },
        }}
        sessionName="deck_test_brain"
        agentType="codex"
        modelOverride="gpt-5"
      />,
    );

    expect(screen.getByText('gpt-5')).toBeDefined();
    expect(screen.queryByText(/5h 43% 4\/6 14:40/)).toBeNull();
    expect(screen.queryByText(/7d 34% 4\/8 15:48/)).toBeNull();
  });

  it('recomputes codex quota countdown from quotaMeta', () => {
    render(
      <UsageFooter
        usage={{
          inputTokens: 2000,
          cacheTokens: 1000,
          contextWindow: 1_000_000,
          model: 'coder-model',
        }}
        sessionName="deck_test_brain"
        agentType="codex-sdk"
        modelOverride="gpt-5"
        quotaLabel="stale quota text"
        quotaMeta={{
          primary: {
            usedPercent: 43,
            windowDurationMins: 300,
            resetsAt: Math.floor((2 * 60_000 + 15_000) / 1000),
          },
          secondary: {
            usedPercent: 34,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: Math.floor((26 * 60 * 60_000) / 1000),
          },
        }}
        now={0}
      />,
    );

    expect(screen.queryByText('stale quota text')).toBeNull();
    expect(screen.getByText(/5h 43% 2m/)).toBeDefined();
    expect(screen.getByText(/7d 34% 1d02h/)).toBeDefined();
  });

  it('uses provider-sourced context window before model-family inference', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 100_000,
          cacheTokens: 0,
          contextWindow: 258_400,
          contextWindowSource: USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER,
          model: 'gpt-5.4-mini',
        }}
        sessionName="deck_test_brain"
      />,
    );

    expect(container.querySelector('.session-usage-footer')?.getAttribute('title')).toContain('Context: 100k / 258k (39%)');
  });

  it('uses a preset-sourced 1M window before model-family inference', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 100_000,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          contextWindowSource: USAGE_CONTEXT_WINDOW_SOURCES.PRESET,
          model: 'claude-haiku-4-5',
        }}
        sessionName="deck_test_brain"
      />,
    );

    expect(container.querySelector('.session-usage-footer')?.getAttribute('title')).toContain('Context: 100k / 1M (10%)');
  });

  it('honors Codex provider effective GPT-5.5 context window', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 100_000,
          cacheTokens: 0,
          contextWindow: 258_400,
          contextWindowSource: USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER,
          model: 'gpt-5.5',
        }}
        sessionName="deck_test_brain"
      />,
    );

    expect(container.querySelector('.session-usage-footer')?.getAttribute('title')).toContain('Context: 100k / 258k (39%)');
  });

  it('honors provider-reported 1M GPT-5.5 context window', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 100_000,
          cacheTokens: 0,
          contextWindow: 1_000_000,
          contextWindowSource: USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER,
          model: 'gpt-5.5',
        }}
        sessionName="deck_test_brain"
      />,
    );

    expect(container.querySelector('.session-usage-footer')?.getAttribute('title')).toContain('Context: 100k / 1M (10%)');
  });

  it('keeps the ctx meter visible at zero usage when the model is known', () => {
    const { container } = render(
      <UsageFooter
        usage={{
          inputTokens: 0,
          cacheTokens: 0,
          contextWindow: 0,
        }}
        sessionName="deck_test_brain"
        agentType="codex-sdk"
        modelOverride="gpt-5.5"
      />,
    );

    expect(container.querySelector('.session-ctx-bar')).toBeTruthy();
    expect(screen.getByText('gpt-5.5')).toBeDefined();
    expect(screen.getByText('0 / 922k (0.0%)')).toBeDefined();
    expect(container.querySelector('.session-usage-footer')?.getAttribute('title')).toContain('Context: 0 / 922k (0.0%)');
  });

  // ── Shell / script sessions are not "agents" ────────────────────────────────
  //
  // Regression: shell + script terminals fired session.state(running) on any
  // raw bytes (idle detection runs without a structured watcher), and the
  // footer used `sessionState === 'running'` as the only check to render
  // "Agent working..." That wording was wrong for a plain shell — running
  // `top` or `tail -f` should not look like an AI is busy. Suppress the
  // live-status UI entirely for these session types.

  it('does NOT show "Agent working..." for shell sessions even when sessionState=running', () => {
    const { container } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_shell_brain"
        sessionState="running"
        agentType="shell"
      />,
    );
    expect(container.querySelector('.session-live-status-inline')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Agent working');
  });

  it('does NOT show "Agent working..." for script sessions even when sessionState=running', () => {
    const { container } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_script_brain"
        sessionState="running"
        agentType="script"
      />,
    );
    expect(container.querySelector('.session-live-status-inline')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Agent working');
  });

  it('does NOT show idle agent text for shell sessions', () => {
    const { container } = render(
      <UsageFooter
        usage={{ inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
        sessionName="deck_shell_brain"
        sessionState="idle"
        agentType="shell"
      />,
    );
    expect(container.textContent ?? '').not.toContain('Agent idle');
  });
});
