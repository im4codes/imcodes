/**
 * @vitest-environment jsdom
 *
 * Delegation authority is rendered from the structured
 * `shared/delegation-claim.ts` projection ONLY. These tests pin the boundary:
 * the badge never reads assistant prose, so a turn that performed zero
 * authorized dispatches can never be surfaced as assigned/queued/recovered
 * work no matter what the model wrote.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { h } from 'preact';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LOCALES } from '../../src/i18n/locales/index.js';
import {
  DELEGATION_CLAIM_METADATA_FIELD,
  type DelegationClaimProjection,
} from '../../../shared/delegation-claim.js';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown, extra?: unknown) => {
      const opts = (typeof options === 'object' && options !== null ? options : extra) as
        | Record<string, unknown>
        | undefined;
      const template = typeof options === 'string'
        ? options
        : typeof (opts?.defaultValue) === 'string'
          ? (opts!.defaultValue as string)
          : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/api.js', () => ({
  downloadAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: false,
    rawValue: false,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { DelegationClaimBadge, readDelegationClaimMetadata } from '../../src/components/DelegationClaimBadge.js';
import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';

/** Words a UI may only ever show when real dispatch facts back them. */
const SUCCESS_LABELLING = /assigned|queued|recovered|dispatched|delegated/i;

const withClaim = (projection: DelegationClaimProjection): Record<string, unknown> => ({
  [DELEGATION_CLAIM_METADATA_FIELD]: projection,
});

const assistantEvent = (payload: Record<string, unknown>): TimelineEvent => ({
  eventId: 'evt-assistant-1',
  sessionId: 'deck_claim_brain',
  ts: 1_700_000_000_000,
  seq: 1,
  epoch: 1,
  source: 'daemon',
  confidence: 'high',
  type: 'assistant.text',
  payload,
} as TimelineEvent);

afterEach(() => cleanup());

describe('DelegationClaimBadge', () => {
  it('renders nothing when the message carries no delegation-claim projection', () => {
    const { container } = render(h(DelegationClaimBadge, { metadata: { model: 'gpt-5' } }));
    expect(container.innerHTML).toBe('');

    const empty = render(h(DelegationClaimBadge, { metadata: undefined }));
    expect(empty.container.innerHTML).toBe('');
  });

  it('renders nothing when the projection is malformed', () => {
    const { container } = render(
      h(DelegationClaimBadge, { metadata: { [DELEGATION_CLAIM_METADATA_FIELD]: { status: 'maybe' } } }),
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders a neutral indicator — and no success labelling — for an unsubstantiated turn', () => {
    const { container } = render(
      h(DelegationClaimBadge, { metadata: withClaim({ status: 'unsubstantiated', dispatches: [] }) }),
    );

    const badge = container.querySelector('[data-delegation-claim]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('data-delegation-claim')).toBe('unsubstantiated');
    expect(badge!.textContent ?? '').toMatch(/no authorized dispatch/i);
    // Structural proof: zero dispatch rows exist, so there is nothing that
    // could be read as work having been handed to anyone.
    expect(container.querySelectorAll('[data-delegation-dispatch]').length).toBe(0);
    expect(container.textContent ?? '').not.toMatch(SUCCESS_LABELLING);
  });

  it('treats a status of substantiated with zero dispatch facts as no authority', () => {
    const { container } = render(
      h(DelegationClaimBadge, { metadata: withClaim({ status: 'substantiated', dispatches: [] }) }),
    );
    expect(container.querySelector('[data-delegation-claim]')!.getAttribute('data-delegation-claim'))
      .toBe('unsubstantiated');
    expect(container.querySelectorAll('[data-delegation-dispatch]').length).toBe(0);
  });

  it('renders the exact authority ids for a substantiated turn', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_9f21',
          taskId: 'task_4410',
          assignmentId: 'asg_5gl',
          deliveries: [{ target: 'deck_imcodes_w1', status: 'delivered', messageId: 'msg_1' }],
        }],
      }),
    }));

    const badge = container.querySelector('[data-delegation-claim]')!;
    expect(badge.getAttribute('data-delegation-claim')).toBe('substantiated');

    const rows = container.querySelectorAll('[data-delegation-dispatch]');
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute('data-delegation-dispatch')).toBe('dsp_9f21');

    const text = badge.textContent ?? '';
    expect(text).toContain('dsp_9f21');
    expect(text).toContain('task_4410');
    expect(text).toContain('asg_5gl');
    // The count is bound to the number of facts, never to prose.
    expect(text).toMatch(/1/);
  });

  it('names the executor on one line so an id row is readable without a lookup', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_9f21',
          taskId: 'task_4410',
          assignmentId: 'asg_5gl',
          deliveries: [{
            target: 'deck_imcodes_w1',
            status: 'delivered',
            execution: {
              sessionName: 'deck_imcodes_w1',
              label: 'Coder',
              agentType: 'claude-code-sdk',
              providerFamily: 'anthropic',
              model: 'claude-opus-5',
              pool: 'primary',
              assignmentStatus: 'delegated',
              source: 'assignment',
            },
          }],
        }],
      }),
    }));

    const line = container.querySelector('[data-delegation-field="execution"]');
    const text = line?.textContent ?? '';
    // Facts, in the order a reader scans them: who, what it runs, which lane.
    expect(text).toContain('Coder (deck_imcodes_w1)');
    expect(text).toContain('claude-code-sdk/anthropic');
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('primary');
    expect(text).toContain('delegated');
  });

  it('renders no executor line when the facts do not name one', () => {
    // Silence beats an empty label: a dispatch whose legs state no executor is
    // exactly the case where a rendered blank would read as "nowhere".
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_9f21',
          taskId: 'task_4410',
          assignmentId: 'asg_5gl',
          deliveries: [{ target: 'deck_imcodes_w1', status: 'delivered' }],
        }],
      }),
    }));
    expect(container.querySelector('[data-delegation-field="execution"]')).toBeNull();
  });

  it('omits id rows the facts do not carry', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{ dispatchId: 'dsp_only', deliveries: [{ target: 'deck_x_w1', status: 'queued' }] }],
      }),
    }));

    expect(container.querySelector('[data-delegation-field="dispatchId"]')).toBeTruthy();
    expect(container.querySelector('[data-delegation-field="taskId"]')).toBeNull();
    expect(container.querySelector('[data-delegation-field="assignmentId"]')).toBeNull();
  });

  it('renders every dispatch when a turn made several', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [
          { dispatchId: 'dsp_a', taskId: 'task_a', deliveries: [{ target: 'w1', status: 'delivered' }] },
          { dispatchId: 'dsp_b', assignmentId: 'asg_b', deliveries: [{ target: 'w2', status: 'queued' }] },
        ],
      }),
    }));

    const rows = [...container.querySelectorAll('[data-delegation-dispatch]')]
      .map((el) => el.getAttribute('data-delegation-dispatch'));
    expect(rows).toEqual(['dsp_a', 'dsp_b']);
  });
});

describe('readDelegationClaimMetadata', () => {
  it('reads the projection from a nested metadata record on the event payload', () => {
    const metadata = withClaim({ status: 'unsubstantiated', dispatches: [] });
    expect(readDelegationClaimMetadata({ text: 'hi', metadata })).toBe(metadata);
  });

  it('reads the projection when it sits directly on the payload', () => {
    const payload = { text: 'hi', ...withClaim({ status: 'unsubstantiated', dispatches: [] }) };
    expect(readDelegationClaimMetadata(payload)).toBe(payload);
  });

  it('returns undefined when no projection is present anywhere', () => {
    expect(readDelegationClaimMetadata({ text: 'hi' })).toBeUndefined();
    expect(readDelegationClaimMetadata(undefined)).toBeUndefined();
  });
});

describe('delegation.claim locale coverage', () => {
  const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
  const KEYS = ['none', 'dispatch_count', 'dispatch_id', 'task_id', 'assignment_id'] as const;

  it('ships every badge string in all 7 locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { delegation?: { claim?: Record<string, unknown> } };
      const claim = messages.delegation?.claim;
      for (const key of KEYS) {
        expect(claim?.[key], `${locale}: delegation.claim.${key}`).toEqual(expect.any(String));
        expect((claim?.[key] as string | undefined)?.trim().length, `${locale}: delegation.claim.${key}`)
          .toBeGreaterThan(0);
      }
      // The count is bound to the fact count, so the interpolation slot must
      // survive translation in every locale.
      expect(claim?.dispatch_count as string, `${locale}: delegation.claim.dispatch_count`)
        .toContain('{{total}}');
    }
  });
});

describe('ChatView delegation-claim wiring', () => {
  it('renders the neutral indicator under an assistant turn with no authorized dispatch', () => {
    const { container } = render(
      <ChatView
        events={[assistantEvent({
          text: 'I assigned the work to deck_imcodes_w1 and it is queued.',
          metadata: withClaim({ status: 'unsubstantiated', dispatches: [] }),
        })] as TimelineEvent[]}
        loading={false}
        hasOlderHistory={false}
        sessionId="deck_claim_brain"
      />,
    );

    const block = container.querySelector('.chat-assistant')!;
    expect(block).toBeTruthy();
    const badge = block.querySelector('[data-delegation-claim]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('data-delegation-claim')).toBe('unsubstantiated');
    expect(block.querySelectorAll('[data-delegation-dispatch]').length).toBe(0);
    // The prose still says whatever the model said — the badge just never
    // borrows authority from it.
    expect(badge!.textContent ?? '').not.toMatch(SUCCESS_LABELLING);
  });

  it('renders the authority ids under an assistant turn that really dispatched', () => {
    const { container } = render(
      <ChatView
        events={[assistantEvent({
          text: 'Done.',
          metadata: withClaim({
            status: 'substantiated',
            dispatches: [{
              dispatchId: 'dsp_wired',
              taskId: 'task_wired',
              assignmentId: 'asg_wired',
              deliveries: [{ target: 'deck_imcodes_w1', status: 'delivered' }],
            }],
          }),
        })] as TimelineEvent[]}
        loading={false}
        hasOlderHistory={false}
        sessionId="deck_claim_brain"
      />,
    );

    const badge = container.querySelector('.chat-assistant [data-delegation-claim]')!;
    expect(badge.getAttribute('data-delegation-claim')).toBe('substantiated');
    expect(badge.textContent ?? '').toContain('dsp_wired');
    expect(badge.textContent ?? '').toContain('task_wired');
    expect(badge.textContent ?? '').toContain('asg_wired');
  });

  it('renders no badge for an assistant turn that carries no projection', () => {
    const { container } = render(
      <ChatView
        events={[assistantEvent({ text: 'Plain answer.' })] as TimelineEvent[]}
        loading={false}
        hasOlderHistory={false}
        sessionId="deck_claim_brain"
      />,
    );

    expect(container.querySelector('.chat-assistant')).toBeTruthy();
    expect(container.querySelector('[data-delegation-claim]')).toBeNull();
  });
});
