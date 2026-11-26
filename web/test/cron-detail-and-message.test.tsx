/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecDetailView, AutoResizeTextarea, CronManager } from '../src/pages/CronManager.js';
import type { SessionInfo } from '../src/types.js';

const apiFetch = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const floatingPanelProps: any[] = [];
vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: (props: any) => {
    floatingPanelProps.push(props);
    return (
      <div data-testid={props.id} className={props.className}>
        <div className="title">{props.title}</div>
        {props.children}
      </div>
    );
  },
}));

afterEach(() => {
  cleanup();
  floatingPanelProps.length = 0;
  vi.clearAllMocks();
});

describe('ExecDetailView — 5/15 lines height & responsive presentation', () => {
  it('renders short content (1~2 lines) naturally without expand toggle or bloated blank space', async () => {
    const exec = {
      id: 'exec-short',
      status: 'dispatched',
      detail: 'Hello world.\nSingle response line.',
      created_at: 1730000000000,
    };

    const { container } = render(
      <ExecDetailView
        jobName="Quick Health Check"
        exec={exec}
        targetSession="deck_cd_brain"
        t={(key: string) => key}
      />
    );

    expect(screen.getByText('Quick Health Check')).toBeDefined();
    expect(screen.getByText('🎯 deck_cd_brain')).toBeDefined();
    expect(screen.getByText('cron.final_output')).toBeDefined();

    const outputBody = screen.getByTestId('cron-execution-output-body');
    expect(outputBody).toBeDefined();
    expect(outputBody.getAttribute('data-expanded')).toBe('false');
    // Short content (2 lines) does not overflow 5 lines
    expect(outputBody.getAttribute('data-overflows')).toBe('false');

    // No expand/collapse button for short content
    expect(screen.queryByText('cron.expand_view')).toBeNull();
  });

  it('renders 6 lines content with default 5-line collapsed view and toggles expansion up to 15 lines', async () => {
    const sixLines = [
      'Line 1: system initialized',
      'Line 2: loading configuration',
      'Line 3: connecting to database',
      'Line 4: executing health check',
      'Line 5: processing responses',
      'Line 6: task completed successfully',
    ].join('\n');

    const exec = {
      id: 'exec-six',
      status: 'dispatched',
      detail: sixLines,
      created_at: 1730000000000,
    };

    render(
      <ExecDetailView
        jobName="Nightly Cleanup"
        exec={exec}
        targetSession="deck_sub_worker"
        t={(key: string) => key}
      />
    );

    const outputBody = screen.getByTestId('cron-execution-output-body');
    expect(outputBody.getAttribute('data-overflows')).toBe('true');
    expect(outputBody.getAttribute('data-expanded')).toBe('false');

    // Initial reading view is collapsed (default 5 lines)
    const expandBtn = screen.getByText('cron.expand_view');
    expect(expandBtn).toBeDefined();

    // Click expand -> expands to show all lines (up to 15 lines)
    fireEvent.click(expandBtn);
    expect(outputBody.getAttribute('data-expanded')).toBe('true');
    expect(screen.getByText('cron.collapse_view')).toBeDefined();

    // Click collapse -> restores default 5-line view
    fireEvent.click(screen.getByText('cron.collapse_view'));
    expect(outputBody.getAttribute('data-expanded')).toBe('false');
    expect(screen.getByText('cron.expand_view')).toBeDefined();
  });

  it('handles ultra-long content (>30 lines) with complete scrollable body and resets on exec switch', async () => {
    const longLines = Array.from({ length: 40 }, (_, i) => `Log entry #${i + 1}: detailed telemetry record at step ${i}`).join('\n');

    const exec1 = {
      id: 'exec-long-1',
      status: 'dispatched',
      detail: longLines,
      created_at: 1730000000000,
    };

    const { rerender } = render(
      <ExecDetailView
        jobName="Heavy Sync"
        exec={exec1}
        t={(key: string) => key}
      />
    );

    const outputBody = screen.getByTestId('cron-execution-output-body');
    expect(outputBody.getAttribute('data-overflows')).toBe('true');
    expect(outputBody.getAttribute('data-expanded')).toBe('false');

    // Expand to 15 lines max-height
    fireEvent.click(screen.getByText('cron.expand_view'));
    expect(outputBody.getAttribute('data-expanded')).toBe('true');

    // Switch to a new execution -> state must reset to collapsed (boundary check)
    const exec2 = {
      id: 'exec-long-2',
      status: 'error',
      detail: 'Fatal exception\n' + longLines,
      created_at: 1730000005000,
    };

    rerender(
      <ExecDetailView
        jobName="Heavy Sync"
        exec={exec2}
        t={(key: string) => key}
      />
    );

    const updatedBody = screen.getByTestId('cron-execution-output-body');
    // Must reset to collapsed for newly switched execution
    expect(updatedBody.getAttribute('data-expanded')).toBe('false');
  });

  it('supports session navigation and quote callback', async () => {
    const onNavigateSession = vi.fn();
    const exec = {
      id: 'exec-nav',
      status: 'dispatched',
      detail: 'Key benchmark output\nSpeed: 45ms',
      created_at: 1730000000000,
    };

    render(
      <ExecDetailView
        jobName="Benchmark"
        exec={exec}
        targetSession="deck_cd_brain"
        onNavigateSession={onNavigateSession}
        t={(key: string) => key}
      />
    );

    const actionBtn = screen.getByText('cron.go_and_quote →');
    expect(actionBtn).toBeDefined();
    fireEvent.click(actionBtn);
    expect(onNavigateSession).toHaveBeenCalledTimes(1);
  });

  it('uses ResizeObserver and dynamically handles narrow/wide resize and expand reset', async () => {
    let observerCallback: (() => void) | null = null;
    const observeMock = vi.fn();
    const disconnectMock = vi.fn();

    // Mock ResizeObserver
    class MockResizeObserver {
      constructor(callback: () => void) {
        observerCallback = callback;
      }
      observe = observeMock;
      disconnect = disconnectMock;
      unobserve = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const exec = {
      id: 'exec-resize-causal',
      status: 'dispatched',
      detail: 'word '.repeat(35),
      created_at: 1730000000000,
    };

    const { unmount } = render(
      <ExecDetailView
        jobName="Resize Test"
        exec={exec}
        t={(key: string) => key}
      />
    );

    expect(observeMock).toHaveBeenCalled();

    const outputBody = screen.getByTestId('cron-execution-output-body');

    // Simulate initial wide render (scrollHeight 100 <= clientHeight 123)
    Object.defineProperty(outputBody, 'clientHeight', { configurable: true, value: 123 });
    Object.defineProperty(outputBody, 'scrollHeight', { configurable: true, value: 100 });
    observerCallback!();
    await waitFor(() => expect(outputBody.getAttribute('data-overflows')).toBe('false'));

    // Simulate resizing to narrow (scrollHeight 220 > clientHeight 123)
    Object.defineProperty(outputBody, 'scrollHeight', { configurable: true, value: 220 });
    observerCallback!();
    await waitFor(() => expect(outputBody.getAttribute('data-overflows')).toBe('true'));

    // Expand
    const expandBtn = await screen.findByText('cron.expand_view');
    fireEvent.click(expandBtn);
    await waitFor(() => expect(outputBody.getAttribute('data-expanded')).toBe('true'));

    // Simulate resizing back to wide (scrollHeight 100 <= collapsedMaxHeight ~131)
    Object.defineProperty(outputBody, 'scrollHeight', { configurable: true, value: 100 });
    observerCallback!();
    // Must reset isExpanded and data-overflows
    await waitFor(() => {
      expect(outputBody.getAttribute('data-overflows')).toBe('false');
      expect(outputBody.getAttribute('data-expanded')).toBe('false');
    });

    // Unmount cleans up observer
    unmount();
    expect(disconnectMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('AutoResizeTextarea — 5 to 15 lines auto-adaptation', () => {
  it('renders with .cron-auto-textarea and adjusts height on input', async () => {
    const onInput = vi.fn();
    const { container } = render(
      <AutoResizeTextarea
        value="Initial command line"
        onInput={onInput}
        placeholder="Enter cron command..."
      />
    );

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeDefined();
    expect(textarea.classList.contains('cron-auto-textarea')).toBe(true);

    fireEvent.input(textarea, { target: { value: 'Updated\nMulti\nLine\nCommand' } });
    expect(onInput).toHaveBeenCalledTimes(1);
  });
});

describe('CronManager — floating panel default 960px width for desktop', () => {
  const sessions: SessionInfo[] = [
    { name: 'deck_cd_brain', project: 'cd', role: 'brain', agentType: 'claude-code', state: 'idle' },
  ];

  it('configures detail FloatingPanel with defaultW=960, defaultH=640 and minW=300', async () => {
    apiFetch
      .mockResolvedValueOnce({
        jobs: [{
          id: 'job-widen',
          server_id: 'srv-current',
          name: 'Widen Test Job',
          cron_expr: '0 9 * * *',
          project_name: 'cd',
          target_role: 'brain',
          target_session_name: null,
          action: JSON.stringify({ type: 'command', command: 'check' }),
          status: 'active',
          last_run_at: null,
          next_run_at: Date.now() + 60_000,
          expires_at: null,
          created_at: Date.now(),
        }],
      })
      .mockResolvedValueOnce({
        executions: [{
          id: 'exec-widen-1',
          status: 'dispatched',
          detail: 'Output for wide panel verification',
          created_at: Date.now(),
        }],
      });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        activeSession="deck_cd_brain"
        onClose={() => {}}
      />
    );

    expect(await screen.findByText('Widen Test Job')).toBeDefined();
    fireEvent.click(screen.getAllByText('cron.history').at(-1)!);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/job-widen/executions?limit=20'));

    // Open detail panel
    fireEvent.click(screen.getByText('Output for wide panel verification'));

    // Verify floatingPanelProps
    const detailPanelCall = floatingPanelProps.find(p => p.id === 'exec-detail-exec-widen-1');
    expect(detailPanelCall).toBeDefined();
    expect(detailPanelCall.defaultW).toBe(960);
    expect(detailPanelCall.defaultH).toBe(640);
    expect(detailPanelCall.minW).toBe(300);
    expect(detailPanelCall.className).toContain('cron-execution-detail-panel');
  });
});
