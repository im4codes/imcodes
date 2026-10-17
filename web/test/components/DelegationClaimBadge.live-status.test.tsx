/**
 * @vitest-environment jsdom
 *
 * A dispatch card follows the assignment's live lifecycle: the daemon's
 * announced status wins over the status frozen into the projection at send
 * time, so an automatically started assignment shows `implementing` without a
 * manual message.
 */
import { h } from 'preact';
import { SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT } from '../../../shared/supervision-assignment-start.js';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DELEGATION_CLAIM_METADATA_FIELD,
  type DelegationClaimProjection,
} from '../../../shared/delegation-claim.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown, extra?: unknown) => {
      const opts = (typeof options === 'object' && options !== null ? options : extra) as Record<string, unknown> | undefined;
      const template = typeof options === 'string'
        ? options
        : typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/api.js', () => ({ downloadAttachment: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: false, rawValue: false, loaded: true, loading: false, stale: false, error: null,
    save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

import { DelegationClaimBadge } from '../../src/components/DelegationClaimBadge.js';
import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';

const projection: DelegationClaimProjection = {
  status: 'substantiated',
  dispatches: [{
    dispatchId: 'dsp_live',
    taskId: 'tsk_live',
    assignmentId: 'asg_live',
    deliveries: [{
      target: 'deck_sub_alpha_worker',
      status: 'delivered',
      execution: {
        sessionName: 'deck_sub_alpha_worker',
        agentType: 'codex-sdk',
        providerFamily: 'openai',
        assignmentStatus: 'delegated',
        source: 'assignment',
      },
    }],
  }],
};

afterEach(() => cleanup());

describe('DelegationClaimBadge live assignment status', () => {
  it('shows the status frozen at send time until the daemon announces a newer one', () => {
    const { container } = render(h(DelegationClaimBadge, { metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: projection } }));
    const row = container.querySelector('[data-delegation-dispatch="dsp_live"]');
    expect(row?.getAttribute('data-assignment-status')).toBe('delegated');
    expect(container.querySelector('details[data-delegation-field="diagnostics"]')?.textContent).toContain('delegated');
  });

  it('reflects a newer announced status for that exact assignment only', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: projection },
      messageTs: 1_000,
      liveAssignmentStatuses: new Map([
        ['asg_live', { status: 'implementing', ts: 1_500 }],
        ['asg_other', { status: 'validated', ts: 1_600 }],
      ]),
    }));
    const row = container.querySelector('[data-delegation-dispatch="dsp_live"]');
    expect(row?.getAttribute('data-assignment-status')).toBe('implementing');
    const diagnostics = container.querySelector('details[data-delegation-field="diagnostics"]')?.textContent ?? '';
    expect(diagnostics).toContain('implementing');
    expect(diagnostics).not.toContain('delegated');
    expect(diagnostics).not.toContain('validated');
  });

  it('keeps a card snapshot that is newer than the announcement', () => {
    const reworkProjection: DelegationClaimProjection = {
      ...projection,
      dispatches: [{
        ...projection.dispatches[0]!,
        deliveries: [{
          ...projection.dispatches[0]!.deliveries![0]!,
          execution: { ...projection.dispatches[0]!.deliveries![0]!.execution!, assignmentStatus: 'rework' },
        }],
      }],
    };
    const { container } = render(h(DelegationClaimBadge, {
      metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: reworkProjection },
      messageTs: 5_000,
      liveAssignmentStatuses: new Map([['asg_live', { status: 'implementing', ts: 1_500 }]]),
    }));
    expect(container.querySelector('[data-delegation-dispatch="dsp_live"]')?.getAttribute('data-assignment-status')).toBe('rework');
  });
});

describe('ChatView dispatch card follows the live assignment status', () => {
  const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
    eventId: 'evt', sessionId: 'deck_alpha_brain', ts: 1_700_000_000_000, seq: 1, epoch: 1,
    source: 'daemon', confidence: 'high', type: 'assistant.text', payload: {},
    ...overrides,
  } as TimelineEvent);

  it('updates the card from the hidden daemon status event without any new message', () => {
    const dispatchMessage = event({
      eventId: 'evt-dispatch',
      payload: { text: 'Dispatched.', metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: projection } },
    });
    const view = render(h(ChatView, {
      events: [dispatchMessage], loading: false, hasOlderHistory: false, sessionId: 'deck_alpha_brain',
    } as never));
    expect(view.container.querySelector('[data-delegation-dispatch="dsp_live"]')?.getAttribute('data-assignment-status'))
      .toBe('delegated');

    view.rerender(h(ChatView, {
      events: [dispatchMessage, event({
        eventId: 'supervision-assignment-status:asg_live:implementing', seq: 2, ts: 1_700_000_000_500, hidden: true,
        type: SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT,
        payload: { taskId: 'tsk_live', assignmentId: 'asg_live', status: 'implementing' },
      })],
      loading: false, hasOlderHistory: false, sessionId: 'deck_alpha_brain',
    } as never));
    expect(view.container.querySelector('[data-delegation-dispatch="dsp_live"]')?.getAttribute('data-assignment-status'))
      .toBe('implementing');
    // The status event itself never renders as a chat row.
    expect(view.container.textContent ?? '').not.toContain('supervision.assignment.status');
  });
});

describe('ChatView dispatch card shows the formal task identity on live and reloaded turns', () => {
  const titled: DelegationClaimProjection = {
    ...projection,
    dispatches: [{ ...projection.dispatches[0]!, taskTitle: 'Enforce formal IM.codes delegation' }],
  };
  const dispatchEvent = (payload: Record<string, unknown>): TimelineEvent => ({
    eventId: 'evt-dispatch-identity', sessionId: 'deck_alpha_brain', ts: 1_700_000_000_000, seq: 1, epoch: 1,
    source: 'daemon', confidence: 'high', type: 'assistant.text', payload,
  } as TimelineEvent);
  const identityOf = (container: Element) => {
    const identity = container.querySelector('[data-delegation-dispatch="dsp_live"] [data-delegation-field="taskIdentity"]');
    return {
      insideDiagnostics: Boolean(identity?.closest('details')),
      title: identity?.querySelector('[data-delegation-field="taskTitle"]')?.textContent ?? '',
      taskId: identity?.querySelector('[data-delegation-field="taskId"] code')?.textContent ?? '',
      assignmentId: identity?.querySelector('[data-delegation-field="assignmentId"] code')?.textContent ?? '',
    };
  };
  const expected = {
    insideDiagnostics: false,
    title: 'Task: Enforce formal IM.codes delegation',
    taskId: 'tsk_live',
    assignmentId: 'asg_live',
  };

  it('renders it when the dispatch turn arrives live', () => {
    const view = render(h(ChatView, { events: [], loading: false, hasOlderHistory: false, sessionId: 'deck_alpha_brain' } as never));
    expect(view.container.querySelector('[data-delegation-field="taskIdentity"]')).toBeNull();
    view.rerender(h(ChatView, {
      events: [dispatchEvent({ text: 'Dispatched.', metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: titled } })],
      loading: false, hasOlderHistory: false, sessionId: 'deck_alpha_brain',
    } as never));
    expect(identityOf(view.container)).toEqual(expected);
  });

  it('renders it identically from reloaded history, including the flattened metadata shape', () => {
    const nested = render(h(ChatView, {
      events: [dispatchEvent({ text: 'Dispatched.', metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: titled } })],
      loading: false, hasOlderHistory: false, sessionId: 'deck_alpha_brain',
    } as never));
    expect(identityOf(nested.container)).toEqual(expected);
    cleanup();
    const flattened = render(h(ChatView, {
      events: [dispatchEvent({ text: 'Dispatched.', [DELEGATION_CLAIM_METADATA_FIELD]: titled })],
      loading: false, hasOlderHistory: false, sessionId: 'deck_alpha_brain',
    } as never));
    expect(identityOf(flattened.container)).toEqual(expected);
  });
});
