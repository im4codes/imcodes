/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenSpecAutoDeliverCurrentRunEntry,
  OpenSpecAutoDeliverDetailsPanel,
  OpenSpecAutoDeliverRunBar,
  computeOpenSpecAutoDeliverProgress,
} from '../../src/components/OpenSpecAutoDeliver.js';
import type { OpenSpecAutoDeliverProjection } from '../../src/openspec-auto-deliver.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'common.close': 'Close',
        'common.hide': 'Hide',
        'openspec.auto.kicker': 'Auto Deliver',
        'openspec.auto.view': 'View',
        'openspec.auto.stop': 'Stop',
        'openspec.auto.compact': 'Compact',
        'openspec.auto.expand': 'Expand',
        'openspec.auto.latest_message': 'Latest',
        'openspec.auto.overall_progress': 'Overall',
        'openspec.auto.current_stage_progress': 'Current stage',
        'openspec.auto.details_title': 'Auto Deliver details',
        'openspec.auto.status_label': 'Status',
        'openspec.auto.stage_label': 'Stage',
        'openspec.auto.elapsed': 'Elapsed',
        'openspec.auto.task_stats': 'Task status',
        'openspec.auto.tasks_unknown': 'Tasks unknown',
        'openspec.auto.audit_results': 'Audit results',
        'openspec.auto.audit_results_empty': 'No audit rounds',
        'openspec.auto.scores': 'Scores',
        'openspec.auto.scores_empty': 'No scores',
        'openspec.auto.evidence': 'Evidence',
        'openspec.auto.lifecycle.spec_audit_repair_p2p_started': 'Spec audit Team run started.',
        'openspec.auto.status.spec_audit_repair': 'Spec audit',
        'openspec.auto.stage.spec_audit_repair': 'Spec audit',
      };
      if (key === 'openspec.auto.progress_count') return `${opts?.current ?? 0}/${opts?.total ?? 0}`;
      if (key === 'openspec.auto.progress_percent') return `${opts?.percent ?? 0}%`;
      if (key === 'openspec.auto.tasks_progress') return `${opts?.checked ?? 0}/${opts?.total ?? 0} tasks`;
      if (key === 'openspec.auto.prompt_progress') return `${opts?.count ?? 0}/${opts?.total ?? 0} prompts`;
      return translations[key] ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
    },
  }),
}));

vi.mock('../../src/hooks/useNowTicker.js', () => ({
  useNowTicker: () => 10_000,
}));

function specAuditProjection(): OpenSpecAutoDeliverProjection {
  return {
    visibility: 'full',
    projectionVersion: 3,
    generation: 1,
    runId: 'auto-spec',
    changeName: 'openspec-auto-delivery',
    status: 'spec_audit_repair',
    stage: 'spec_audit_repair',
    owningMainSessionName: 'deck_brain',
    launchedFromSessionName: 'deck_brain',
    targetImplementationSessionName: 'deck_worker',
    startedAt: 1_000,
    taskStats: { total: 8, checked: 2, unchecked: 6 },
    specAuditRound: { current: 0, total: 1 },
    implementationAuditRound: { current: 0, total: 2 },
    implementationPromptCount: 0,
    recentFinding: 'spec_audit_repair_p2p_started',
    canStop: true,
  };
}

describe('OpenSpecAutoDeliver components', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('computes overall and current-stage progress from state-machine and audit counters', () => {
    const progress = computeOpenSpecAutoDeliverProgress(specAuditProjection());

    expect(progress.overall).toMatchObject({
      current: 2,
      total: 5,
      percent: 40,
      kind: 'overall',
    });
    expect(progress.currentStage).toMatchObject({
      current: 0,
      total: 1,
      percent: 0,
      kind: 'round',
    });
  });

  it('does not treat scalar audit round fallback as completed progress without pair counters', () => {
    const projection = specAuditProjection();
    delete projection.specAuditRound;
    projection.specAuditRepairRound = 1;

    const progress = computeOpenSpecAutoDeliverProgress(projection);

    expect(progress.currentStage).toMatchObject({
      current: 0,
      total: 1,
      percent: 0,
      kind: 'round',
    });
  });

  it('renders full and compact runbar progress without exposing lifecycle keys', () => {
    const projection = specAuditProjection();
    const { rerender } = render(
      <OpenSpecAutoDeliverRunBar
        projection={projection}
        onView={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const runbar = screen.getByTestId('openspec-auto-runbar');
    expect(runbar.textContent).toContain('Overall');
    expect(runbar.textContent).toContain('2/5 · 40%');
    expect(runbar.textContent).toContain('Current stage');
    expect(runbar.textContent).toContain('0/1 · 0%');
    expect(runbar.textContent).toContain('Spec audit Team run started.');
    expect(runbar.textContent).not.toContain('spec_audit_repair_p2p_started');

    rerender(
      <OpenSpecAutoDeliverRunBar
        projection={projection}
        compact
        onView={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const compactRunbar = screen.getByTestId('openspec-auto-runbar');
    expect(compactRunbar.textContent).toContain('2/5 · 40%');
    expect(compactRunbar.textContent).toContain('Spec audit Team run started.');
    expect(compactRunbar.textContent).not.toContain('spec_audit_repair_p2p_started');
  });

  it('localizes lifecycle latest messages in details and recovery rows', () => {
    const projection = specAuditProjection();

    render(
      <>
        <OpenSpecAutoDeliverDetailsPanel
          projection={projection}
          onClose={vi.fn()}
          onStop={vi.fn()}
        />
        <OpenSpecAutoDeliverCurrentRunEntry
          projection={projection}
          onView={vi.fn()}
        />
      </>,
    );

    expect(screen.getAllByText('Spec audit Team run started.').length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain('spec_audit_repair_p2p_started');
  });
});
