/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { clearGlobalTaskBriefCache } from '../../src/components/GlobalTaskBriefModal.js';
import { mergeTaskPairTimelinePayload } from '../../src/task-pair-panel-order.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, optOrValues?: string | Record<string, unknown>) => {
      if (key === 'taskPair.panel_model_separator') return ' · ';
      if (typeof optOrValues === 'string') return optOrValues;
      if (optOrValues && typeof optOrValues === 'object') {
        if (typeof optOrValues.defaultValue === 'string') {
          let text = optOrValues.defaultValue;
          for (const [k, v] of Object.entries(optOrValues)) {
            if (k !== 'defaultValue') {
              text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
            }
          }
          return text;
        }
        return `${key}:${JSON.stringify(optOrValues)}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div data-testid="mock-chat-markdown">{text}</div>,
}));

const originalFetch = globalThis.fetch;

function ensureExpanded(container: HTMLElement) {
  if (!container.querySelector('.task-pair-status-rows')) {
    const toggle = container.querySelector('.task-pair-status-toggle');
    if (toggle) fireEvent.click(toggle);
  }
}

beforeEach(() => {
  clearGlobalTaskBriefCache();
  window.localStorage.clear();
  delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
});

afterEach(() => {
  cleanup();
  clearGlobalTaskBriefCache();
  window.localStorage.clear();
  delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('TaskPairStatusPanel audit strip & compact model display', () => {
  it('renders REWORK and PASS audit strips from snapshots and hides missing/null/malformed lastAudit', () => {
    (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = {
      serverId: 'srv-1',
      tasks: [
        {
          taskId: 'tsk_rework',
          title: 'Rework task',
          updatedAt: 5000,
          pair: {
            status: 'rework',
            round: 2,
            executor: 'deck_sub_exec',
            auditor: 'deck_sub_aud',
            lastAudit: {
              verb: 'REWORK',
              round: 2,
              counts: { p0: 5, p1: 2, p2: 0, p3: 0, p4: 0 },
              blocking: ['P0'],
              blockingCount: 5,
              findingsCount: 7,
              summary: 'Five P0 defects and two P1 follow-ups remain.',
            },
          },
        },
        {
          taskId: 'tsk_pass',
          title: 'Passed task',
          updatedAt: 4000,
          pair: {
            status: 'passed',
            round: 3,
            executor: 'deck_sub_exec',
            auditor: 'deck_sub_aud',
            lastAudit: {
              verb: 'PASS',
              round: 3,
              counts: { p0: 0, p1: 1, p2: 0, p3: 0, p4: 0 },
              blocking: ['P0'],
              blockingCount: 0,
              findingsCount: 1,
              summary: 'All P0 resolved.',
            },
          },
        },
        {
          taskId: 'tsk_pass_clean',
          title: 'Clean pass task',
          updatedAt: 3500,
          pair: {
            status: 'passed',
            round: 0,
            executor: 'deck_sub_exec',
            auditor: 'deck_sub_aud',
            lastAudit: {
              verb: 'PASS',
              round: 0,
              counts: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 },
              blocking: ['P0'],
              blockingCount: 0,
              findingsCount: 0,
              summary: 'Zero findings.',
            },
          },
        },
        {
          taskId: 'tsk_null_audit',
          title: 'Null audit task',
          updatedAt: 3000,
          pair: {
            status: 'working',
            round: 1,
            lastAudit: null,
          },
        },
        {
          taskId: 'tsk_malformed_audit',
          title: 'Malformed audit task',
          updatedAt: 2000,
          pair: {
            status: 'working',
            round: 1,
            lastAudit: { verb: 'UNKNOWN' },
          },
        },
      ],
    };

    const { container } = render(<TaskPairStatusPanel events={[]} serverId="srv-1" />);
    ensureExpanded(container);

    const reworkStrip = screen.getByTestId('task-pair-panel-audit-strip-tsk_rework');
    expect(reworkStrip.className).toContain('is-rework');
    expect(reworkStrip.textContent).toContain('Rework · R2');
    expect(screen.getByTestId('task-pair-panel-audit-blocking-tsk_rework').textContent).toContain('P0 ×5 pending');
    expect(reworkStrip.textContent).toContain('P1 ×2');
    expect(reworkStrip.textContent).toContain('View 1..7');
    expect(reworkStrip.textContent).toContain('Five P0 defects and two P1 follow-ups remain.');

    // Passed row lives in collapsed <details> "recent" group, still mounted in DOM
    const passStrip = screen.getByTestId('task-pair-panel-audit-strip-tsk_pass');
    expect(passStrip.className).toContain('is-pass');
    expect(passStrip.textContent).toContain('Passed · R3');
    expect(passStrip.textContent).toContain('P0 0');
    expect(passStrip.textContent).toContain('P1 ×1');
    expect(passStrip.textContent).toContain('View 1..1');
    expect(passStrip.textContent).toContain('All P0 resolved.');

    const cleanPassStrip = screen.getByTestId('task-pair-panel-audit-strip-tsk_pass_clean');
    expect(cleanPassStrip.className).toContain('is-pass');
    expect(cleanPassStrip.textContent).toContain('Passed');
    expect(cleanPassStrip.textContent).toContain('P0 0');
    expect(cleanPassStrip.textContent).toContain('Details');
    expect(cleanPassStrip.textContent).toContain('Zero findings.');

    expect(screen.queryByTestId('task-pair-panel-audit-strip-tsk_null_audit')).toBeNull();
    expect(screen.queryByTestId('task-pair-panel-audit-strip-tsk_malformed_audit')).toBeNull();
  });

  it('preserves lastAudit across subsequent timeline events without lastAudit and clears when lastAudit is null', () => {
    const auditR2 = {
      verb: 'REWORK' as const,
      round: 2,
      counts: { p0: 2, p1: 0, p2: 0, p3: 0, p4: 0 },
      blocking: ['P0'],
      blockingCount: 2,
      findingsCount: 2,
      summary: 'Two P0 issues.',
    };

    const afterWorking = mergeTaskPairTimelinePayload(
      { taskId: 'tsk_tl', toStatus: 'rework', lastAudit: auditR2 },
      { taskId: 'tsk_tl', toStatus: 'working', verb: 'WORKING' },
    );
    expect(afterWorking.lastAudit).toEqual(auditR2);

    const afterNextRound = mergeTaskPairTimelinePayload(
      afterWorking,
      { taskId: 'tsk_tl', toStatus: 'working', verb: 'NEXT_ROUND', lastAudit: null },
    );
    expect(afterNextRound.lastAudit).toBeNull();

    const eventsPhase1 = [
      {
        eventId: 'e1',
        type: 'task_pair.event',
        ts: 1000,
        payload: { taskId: 'tsk_tl', title: 'Timeline audit', toStatus: 'rework', round: 2, lastAudit: auditR2 },
      },
      {
        eventId: 'e2',
        type: 'task_pair.event',
        ts: 2000,
        payload: { taskId: 'tsk_tl', title: 'Timeline audit', toStatus: 'working', round: 2 },
      },
    ] as never;

    const view = render(<TaskPairStatusPanel events={eventsPhase1} serverId="srv-1" />);
    ensureExpanded(view.container);
    expect(screen.getByTestId('task-pair-panel-audit-strip-tsk_tl')).toBeTruthy();

    const eventsPhase2 = [
      ...eventsPhase1,
      {
        eventId: 'e3',
        type: 'task_pair.event',
        ts: 3000,
        payload: { taskId: 'tsk_tl', title: 'Timeline audit', toStatus: 'working', round: 2, deliveryRound: 2, lastAudit: null },
      },
    ] as never;
    view.rerender(<TaskPairStatusPanel events={eventsPhase2} serverId="srv-1" />);
    expect(screen.queryByTestId('task-pair-panel-audit-strip-tsk_tl')).toBeNull();
  });

  it('opens GlobalTaskBriefModal on audit tab when clicked, navigates via deck:navigate, and clears on serverId change', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_modal/brief')) {
        return new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_modal',
          brief: '- [x][ ] 1. Ship taskbar strip',
          briefRevision: 'rev-1',
          checklist: { total: 1, implemented: 1, audited: 0 },
          lastAudit: {
            verb: 'REWORK',
            round: 2,
            counts: { p0: 1, p1: 0, p2: 0, p3: 0, p4: 0 },
            blocking: ['P0'],
            blockingCount: 1,
            findingsCount: 1,
            summary: 'Missing modal test.',
            findings: [
              { index: 1, severity: 'P0', blocking: true, summary: 'Missing modal test', location: 'TaskPairStatusPanel.tsx:10', proposal: 'Add test' },
            ],
          },
          updatedAt: 5000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = {
      serverId: 'srv-1',
      tasks: [
        {
          taskId: 'tsk_modal',
          title: 'Modal integration',
          updatedAt: 5000,
          pair: {
            status: 'rework',
            round: 2,
            brain: 'deck_proj_brain',
            executor: 'deck_sub_exec',
            executorLabel: 'Ag1',
            executorModel: 'claude-sonnet-4-6-20250514',
            auditor: 'deck_sub_aud',
            auditorLabel: 'Sol1',
            auditorModel: 'gpt-5.4-codex',
            lastAudit: {
              verb: 'REWORK',
              round: 2,
              counts: { p0: 1, p1: 0, p2: 0, p3: 0, p4: 0 },
              blocking: ['P0'],
              blockingCount: 1,
              findingsCount: 1,
              summary: 'Missing modal test.',
            },
          },
        },
      ],
    };

    const navigate = vi.fn();
    const onNavigate = (e: Event) => navigate((e as CustomEvent).detail.session);
    window.addEventListener('deck:navigate', onNavigate);
    try {
      const view = render(<TaskPairStatusPanel events={[]} serverId="srv-1" />);
      ensureExpanded(view.container);

      fireEvent.click(screen.getByTestId('task-pair-panel-audit-strip-tsk_modal'));
      const auditTab = await screen.findByTestId('global-task-brief-tab-audit');
      expect(auditTab.getAttribute('aria-selected')).toBe('true');

      await waitFor(() => {
        expect(screen.getByTestId('global-task-audit-finding-1')).toBeTruthy();
      });
      expect(screen.getByTestId('global-task-audit-finding-1').textContent).toContain('Missing modal test');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Open session closes modal and dispatches deck:navigate to brainSession
      fireEvent.click(screen.getByTestId('global-task-brief-open-session'));
      expect(navigate).toHaveBeenCalledWith('deck_proj_brain');
      expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();

      // Re-open and switch serverId -> modal closes cleanly
      fireEvent.click(screen.getByTestId('task-pair-panel-audit-strip-tsk_modal'));
      await screen.findByTestId('global-task-brief-hud');
      await act(async () => {
        view.rerender(<TaskPairStatusPanel events={[]} serverId="srv-2" />);
      });
      expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();
    } finally {
      window.removeEventListener('deck:navigate', onNavigate);
    }
  });

  it('degrades safely when serverId is unavailable (read-only strip, no modal or fetch)', () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const events = [
      {
        eventId: 'e-nosrv',
        type: 'task_pair.event',
        ts: 1000,
        payload: {
          taskId: 'tsk_nosrv',
          title: 'Offline event task',
          toStatus: 'rework',
          round: 1,
          lastAudit: {
            verb: 'REWORK',
            round: 1,
            counts: { p0: 1, p1: 0, p2: 0, p3: 0, p4: 0 },
            blocking: ['P0'],
            blockingCount: 1,
            findingsCount: 1,
            summary: 'Offline summary.',
          },
        },
      },
    ] as never;

    const { container } = render(<TaskPairStatusPanel events={events} />);
    ensureExpanded(container);

    const strip = screen.getByTestId('task-pair-panel-audit-strip-tsk_nosrv');
    expect(strip.tagName).toBe('DIV');
    expect(strip.className).toContain('is-readonly');
    expect(strip.querySelector('.global-task-audit-strip-cta')).toBeNull();

    fireEvent.click(strip);
    expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats assigned and unassigned model names compactly with full raw title tooltips and edge guards', () => {
    const events = [
      {
        eventId: 'm1',
        type: 'task_pair.event',
        ts: 1000,
        payload: {
          taskId: 'tsk_models_1',
          title: 'Assigned compact models',
          toStatus: 'working',
          executor: 'deck_sub_exec',
          executorLabel: 'Exec',
          executorModel: 'claude-sonnet-4-6-20250514',
          auditor: 'deck_sub_aud',
          auditorLabel: 'Aud',
          auditorModel: 'anthropic/claude-opus-4-6',
        },
      },
      {
        eventId: 'm2',
        type: 'task_pair.event',
        ts: 2000,
        payload: {
          taskId: 'tsk_models_2',
          title: 'Unassigned and edge models',
          toStatus: 'queued',
          executorModel: 'openai-codex/gpt-5.3-codex',
          auditorModel: 'claude-sonnet-4-5-20250929',
        },
      },
      {
        eventId: 'm3',
        type: 'task_pair.event',
        ts: 3000,
        payload: {
          taskId: 'tsk_models_edge',
          title: 'Blank and sentinel models',
          toStatus: 'queued',
          executorModel: '[1m]',
          auditorModel: '__none__',
        },
      },
    ] as never;

    const { container } = render(<TaskPairStatusPanel events={events} serverId="srv-1" />);
    ensureExpanded(container);

    const execModelEl = container.querySelector('[data-session-name="deck_sub_exec"] .task-pair-status-session-model')!;
    expect(execModelEl.textContent).toBe('sonnet-4.6');
    expect(execModelEl.getAttribute('title')).toBe('claude-sonnet-4-6-20250514');

    const audModelEl = container.querySelector('[data-session-name="deck_sub_aud"] .task-pair-status-session-model')!;
    expect(audModelEl.textContent).toBe('opus-4.6');
    expect(audModelEl.getAttribute('title')).toBe('anthropic/claude-opus-4-6');

    const unassignedEls = [...container.querySelectorAll('.task-pair-role-unassigned')];
    expect(unassignedEls.some((el) => el.textContent === 'taskPair.panel_unassigned · 5.3-codex' && el.getAttribute('title') === 'openai-codex/gpt-5.3-codex')).toBe(true);
    expect(unassignedEls.some((el) => el.textContent === 'taskPair.panel_unassigned · sonnet-4.5' && el.getAttribute('title') === 'claude-sonnet-4-5-20250929')).toBe(true);

    // Edge: [1m] and __none__ must not render trailing separator or sentinel text
    const edgeRow = container.querySelector('[data-task-id="tsk_models_edge"]')!;
    const edgeUnassigned = [...edgeRow.querySelectorAll('.task-pair-role-unassigned')];
    expect(edgeUnassigned).toHaveLength(2);
    for (const el of edgeUnassigned) {
      expect(el.textContent).toBe('taskPair.panel_unassigned');
    }
  });
});
