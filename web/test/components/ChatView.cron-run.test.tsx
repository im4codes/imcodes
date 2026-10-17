/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_COMPLETION_POLICY,
  CRON_MSG,
  CRON_RUN_TIMELINE,
  buildCronRunTimelineProjection,
  type CronDispatchMessage,
} from '../../../shared/cron-types.js';
import type { TimelineEvent } from '../../src/ws-client.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (values?.name) return `${key}:${values.name}`;
      if (values?.id) return `${key}:${values.id}:v${values.version}:${values.count}`;
      return key;
    },
    i18n: { resolvedLanguage: 'en', language: 'en' },
  }),
}));

import { __ChatEventForTests } from '../../src/components/ChatView.js';

const RAW_WRAPPER = '<imcodes-cron-control {"contractRef":"supervision_cron_control_v2"}></imcodes-cron-control>';

function cronEvent(sessionId = 'deck_project_brain'): TimelineEvent {
  const dispatch: CronDispatchMessage = {
    type: CRON_MSG.DISPATCH,
    jobId: 'schedule-1',
    executionId: 'execution-1',
    jobName: 'Cross-region revenue report',
    serverId: 'server-1',
    projectName: 'project',
    targetRole: 'brain',
    cronExpr: '*/15 * * * *',
    timezone: 'Asia/Shanghai',
    completionPolicy: CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    previousRunAt: Date.parse('2026-09-20T00:00:00Z'),
    nextRunAt: Date.parse('2026-09-20T00:15:00Z'),
    action: { type: 'command', command: 'Generate the authorized report without printing secrets.' },
  };
  const projection = buildCronRunTimelineProjection(dispatch);
  if (!projection) throw new Error('fixture projection missing');
  return {
    eventId: 'event-1', sessionId, ts: 1, epoch: 1, seq: 1,
    source: 'daemon', confidence: 'high', type: 'user.message',
    payload: { text: RAW_WRAPPER, [CRON_RUN_TIMELINE.PAYLOAD_KEY]: projection },
  } as TimelineEvent;
}

function renderEvent(event: TimelineEvent) {
  return render(h(__ChatEventForTests as never, { event } as never));
}

describe('cron run timeline card', () => {
  afterEach(() => cleanup());

  it.each([
    ['live main-session', () => cronEvent()],
    ['reloaded sub-session', () => JSON.parse(JSON.stringify(cronEvent('deck_sub_worker'))) as TimelineEvent],
  ])('renders %s metadata and hides the raw wrapper behind collapsed task details', (_label, makeEvent) => {
    const view = renderEvent(makeEvent());
    expect(view.getByText('Cross-region revenue report')).toBeTruthy();
    expect(view.getByText('*/15 * * * *')).toBeTruthy();
    expect(view.getByText('cron.completion_until_complete')).toBeTruthy();
    expect(view.getByText('cron.run_card.status_dispatched')).toBeTruthy();
    expect(view.queryByText(RAW_WRAPPER)).toBeNull();
    expect(view.queryByText('Generate the authorized report without printing secrets.')).toBeNull();

    const toggle = view.getByRole('button', { name: 'cron.run_card.show_details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toContain('cron-run-schedule-1-execution-1');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.getByText('Generate the authorized report without printing secrets.')).toBeTruthy();
    expect(view.getByText(/supervision_cron_control_v2/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(view.queryByText('Generate the authorized report without printing secrets.')).toBeNull();
  });

  it('fails closed to ordinary text for an untrusted projection', () => {
    const event = { ...cronEvent(), confidence: 'low' as const };
    const view = renderEvent(event);
    expect(view.getByText(RAW_WRAPPER)).toBeTruthy();
    expect(view.queryByText('Cross-region revenue report')).toBeNull();
  });
});
