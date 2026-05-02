/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

const toolPref = vi.hoisted(() => ({
  value: true as boolean | null,
  save: vi.fn(async (_value: boolean) => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
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

afterEach(() => {
  cleanup();
  toolPref.value = true;
  toolPref.save.mockClear();
});

describe('UsageFooter', () => {
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

  it('prioritizes active thinking over stale idle state and renders running states inline', () => {
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

    const staleIdleStatus = container.querySelector('.session-live-status-inline') as HTMLSpanElement | null;
    expect(staleIdleStatus?.textContent).toContain('🤖');
    expect(staleIdleStatus?.textContent).toContain('💭');
    expect(staleIdleStatus?.getAttribute('aria-label')).toContain('thinking');
    expect(container.querySelector('.session-live-status-inline.thinking .session-live-status-emoji.thought')).toBeTruthy();
    expect(container.querySelector('.session-live-status-inline.idle')).toBeNull();

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
    expect(runningStatus?.textContent).toContain('🤖');
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
    expect(plainRunningStatus?.textContent).toContain('🤖');
    expect(plainRunningStatus?.textContent).toContain('⚙️');
    expect(container.querySelector('.session-live-status-inline.running .session-live-status-emoji.gear')).toBeTruthy();
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

  it('does not let stale Codex provider fallback shrink GPT-5.5 context window', () => {
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

    expect(container.querySelector('.session-usage-footer')?.getAttribute('title')).toContain('Context: 100k / 922k (11%)');
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
