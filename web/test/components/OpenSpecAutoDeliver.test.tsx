/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
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
        'openspec.auto.continue': 'Continue',
        'openspec.auto.continuing': 'Continuing...',
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
        'openspec.auto.final_scores': 'Final acceptance scores',
        'openspec.auto.final_spec_score': 'Final Spec',
        'openspec.auto.final_impl_score': 'Final Impl',
        'openspec.auto.pre_repair_scores': 'Pre-repair audit scores',
        'openspec.auto.scores_empty': 'No scores',
        'openspec.auto.score_pending': 'Pending final audit',
        'openspec.auto.scores_pending_repair_rescore': 'Repairing from audit findings. Final score will refresh after implementation and validation.',
        'openspec.auto.evidence': 'Evidence',
        'openspec.auto.lifecycle.spec_audit_repair_p2p_started': 'Spec audit Team run started.',
        'openspec.auto.lifecycle.implementation_repair_prompt_dispatched': `Implementation repair prompt sent from audit findings: ${opts?.reason ?? ''}`,
        'openspec.auto.status.spec_audit_repair': 'Spec audit',
        'openspec.auto.stage.spec_audit_repair': 'Spec audit',
        'openspec.auto.status.implementation_task_loop': 'Implementation',
        'openspec.auto.stage.implementation_task_loop': 'Implementation',
        'openspec.auto.status.needs_human': 'Needs human',
        'openspec.auto.stage.needs_human': 'Needs human',
        'openspec.auto.score_module.spec': 'Spec',
        'openspec.auto.score_module.implementation': 'Implementation',
      };
      if (key === 'openspec.auto.progress_count') return `${opts?.current ?? 0}/${opts?.total ?? 0}`;
      if (key === 'openspec.auto.progress_percent') return `${opts?.percent ?? 0}%`;
      if (key === 'openspec.auto.tasks_progress') return `${opts?.checked ?? 0}/${opts?.total ?? 0} tasks`;
      if (key === 'openspec.auto.prompt_progress') return `${opts?.count ?? 0}/${opts?.total ?? 0} prompts`;
      if (key === 'openspec.auto.score_snapshot_meta') return `Round ${opts?.round ?? ''} · ${opts?.reason ?? ''}`;
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
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('computes overall and current-stage progress from state-machine and audit counters', () => {
    const progress = computeOpenSpecAutoDeliverProgress(specAuditProjection());

    expect(progress.overall).toMatchObject({
      current: 2,
      total: 6,
      percent: 33,
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
    expect(runbar.textContent).toContain('2/6 · 33%');
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
    expect(compactRunbar.textContent).toContain('2/6 · 33%');
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

  it('applies the saved desktop details panel size', () => {
    localStorage.setItem('rcc_openspec_auto_deliver_details_size', JSON.stringify({ width: 880, height: 640 }));

    render(
      <OpenSpecAutoDeliverDetailsPanel
        projection={specAuditProjection()}
        onClose={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('openspec-auto-details').querySelector('.openspec-auto-details-panel') as HTMLElement | null;
    expect(panel?.style.getPropertyValue('--openspec-auto-details-width')).toBe('880px');
    expect(panel?.style.getPropertyValue('--openspec-auto-details-height')).toBe('640px');
  });

  it('surfaces final spec and implementation scores in the first-screen hero', () => {
    const projection = specAuditProjection();
    projection.status = 'passed';
    projection.stage = 'passed';
    projection.terminal = true;
    projection.finalAfterRepair = {
      phase: 'final_after_repair',
      stage: 'implementation_audit_repair',
      roundIndex: 2,
      attemptId: 'final-score',
      generation: 2,
      verdict: 'PASS',
      moduleScores: [
        { module: 'spec', score: 9, max_score: 10, summary: 'Spec is tight.' },
        { module: 'implementation', score: 8, max_score: 10, summary: 'Implementation is solid.' },
      ],
      summary: 'passed',
      completedAt: 123,
    };

    render(
      <OpenSpecAutoDeliverDetailsPanel
        projection={projection}
        onClose={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const hero = screen.getByTestId('openspec-auto-hero');
    expect(hero.textContent).toContain('Final Spec');
    expect(hero.textContent).toContain('9/10');
    expect(hero.textContent).toContain('Final Impl');
    expect(hero.textContent).toContain('8/10');
    expect(hero.textContent).toContain('★');
  });

  it('separates pre-repair audit scores from pending final acceptance scores', () => {
    const projection: OpenSpecAutoDeliverProjection = {
      visibility: 'full',
      projectionVersion: 7,
      generation: 2,
      runId: 'auto-repair',
      changeName: 'openspec-auto-delivery',
      status: 'implementation_task_loop',
      stage: 'implementation_task_loop',
      owningMainSessionName: 'deck_brain',
      launchedFromSessionName: 'deck_brain',
      targetImplementationSessionName: 'deck_worker',
      startedAt: 1_000,
      taskStats: { total: 8, checked: 8, unchecked: 0 },
      specAuditRound: { current: 1, total: 1 },
      implementationAuditRound: { current: 1, total: 2 },
      implementationPromptCount: 2,
      recentFinding: 'implementation_repair_prompt_dispatched:implementation_audit_rework_requires_repair',
      moduleScores: [{ module: 'implementation', score: 5, max_score: 10, summary: 'Stale audit score.' }],
      auditBeforeRepair: {
        phase: 'audit_before_repair',
        stage: 'implementation_audit_repair',
        roundIndex: 1,
        attemptId: 'attempt-before',
        generation: 2,
        verdict: 'REWORK',
        moduleScores: [{ module: 'implementation', score: 5, max_score: 10, summary: 'Needs repair.' }],
        summary: 'implementation_audit_rework_requires_repair',
        completedAt: 123,
      },
      canStop: true,
    };

    render(
      <OpenSpecAutoDeliverDetailsPanel
        projection={projection}
        onClose={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain('Pre-repair audit scores');
    expect(document.body.textContent).toContain('Needs repair.');
    expect(document.body.textContent).toContain('Final acceptance scores');
    expect(document.body.textContent).toContain('Repairing from audit findings. Final score will refresh after implementation and validation.');
    expect(document.body.textContent).toContain('No scores');
    expect(document.body.textContent).not.toContain('Stale audit score.');
  });

  it('renders explicit Continue recovery action without conflating Close or Stop', () => {
    const projection: OpenSpecAutoDeliverProjection = {
      visibility: 'full',
      projectionVersion: 8,
      generation: 3,
      runId: 'auto-needs-human',
      changeName: 'openspec-auto-delivery',
      status: 'needs_human',
      stage: 'needs_human',
      owningMainSessionName: 'deck_brain',
      launchedFromSessionName: 'deck_brain',
      targetImplementationSessionName: 'deck_worker',
      terminal: true,
      canContinue: true,
      canStop: false,
      terminalReason: 'missing_authoritative_json',
    };
    const onContinue = vi.fn();
    const onClose = vi.fn();
    const onStop = vi.fn();

    const { rerender } = render(
      <OpenSpecAutoDeliverDetailsPanel
        projection={projection}
        continuePending={false}
        onClose={onClose}
        onStop={onStop}
        onContinue={onContinue}
      />,
    );

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDefined();
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

    const [, footerCloseButton] = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(footerCloseButton);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    rerender(
      <OpenSpecAutoDeliverDetailsPanel
        projection={projection}
        continuePending
        onClose={onClose}
        onStop={onStop}
        onContinue={onContinue}
      />,
    );

    const pendingButton = screen.getByRole('button', { name: 'Continuing...' });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides Continue when the terminal projection is not recoverable', () => {
    render(
      <OpenSpecAutoDeliverDetailsPanel
        projection={{
          visibility: 'full',
          projectionVersion: 9,
          generation: 3,
          runId: 'auto-passed',
          changeName: 'openspec-auto-delivery',
          status: 'passed',
          stage: 'passed',
          owningMainSessionName: 'deck_brain',
          terminal: true,
          canContinue: false,
        }}
        onClose={vi.fn()}
        onStop={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});
