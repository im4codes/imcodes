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
  DELEGATION_AUTHORITY_MCP_SERVER,
  DELEGATION_CLAIM_METADATA_FIELD,
  projectDelegationClaim,
  readDelegationDispatchFact,
  type DelegationClaimProjection,
} from '../../../shared/delegation-claim.js';
import { taskPairBindingId } from '../../../shared/task-pair.js';

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

  it.each(['unsubstantiated', 'substantiated'] as const)(
    'renders nothing for a %s projection with zero task dispatches',
    (status) => {
      const { container } = render(
        h(DelegationClaimBadge, { metadata: withClaim({ status, dispatches: [] }) }),
      );
      expect(container.innerHTML).toBe('');
      expect(container.textContent ?? '').not.toMatch(SUCCESS_LABELLING);
    },
  );

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

  it('ignores a legacy machine-control-only projection', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'mcp-machine-1',
          kind: 'machine-control',
          tool: 'computer_use_call',
          machine: '1472527657',
          taskId: 'tsk_forged',
          assignmentId: 'asg_forged',
          deliveries: [{ target: '1472527657', status: 'delivered' }],
        } as never],
      }),
    }));
    expect(container.innerHTML).toBe('');
  });

  it('keeps only the formal task dispatch from a mixed legacy batch', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'mcp-local-1', kind: 'machine-control', tool: 'computer_use_call',
          machine: 'local', deliveries: [{ target: 'local', status: 'delivered' }],
        } as never, {
          dispatchId: 'dsp-task-1', taskId: 'tsk_1', assignmentId: 'asg_1',
          deliveries: [{ target: 'deck_worker', status: 'delivered' }],
        }],
      }),
    }));
    expect(container.querySelectorAll('[data-delegation-dispatch]')).toHaveLength(1);
    expect(container.textContent).toContain('dsp-task-1');
    expect(container.textContent).not.toContain('computer_use_call');
    expect(container.textContent).not.toContain('local');
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
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('primary');
    // Provider and assignment status are still carried, one layer down: the
    // point of R1 was that no second lookup is needed, and that holds whether
    // a fact is on the scanned line or in the diagnostics beside it.
    const diagnostics = container.querySelector('details[data-delegation-field="diagnostics"]');
    expect(diagnostics?.textContent).toContain('claude-code-sdk/anthropic');
    expect(diagnostics?.textContent).toContain('delegated');
  });

  it.each([
    { label: undefined, expected: 'deck_sub_3v4p6g0n' },
    { label: 'deck_sub_3v4p6g0n', expected: 'deck_sub_3v4p6g0n' },
  ])('falls back to sessionName without duplicating an absent or identical label', ({ label, expected }) => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_label_fallback', taskId: 'tsk_label', assignmentId: 'asg_label',
          deliveries: [{
            target: 'deck_sub_3v4p6g0n', status: 'delivered',
            execution: {
              sessionName: 'deck_sub_3v4p6g0n', ...(label ? { label } : {}),
              model: 'gpt-5.6-sol', pool: 'primary', source: 'assignment',
            },
          }],
        }],
      }),
    }));
    const text = container.querySelector('[data-delegation-field="execution"]')?.textContent ?? '';
    expect(text).toContain(expected);
    expect(text.match(/deck_sub_3v4p6g0n/g)).toHaveLength(1);
  });

  it('leads with session, then model, then pool — the three facts a reader acts on', () => {
    // R1 made the executor available; R2 is about what the eye lands on first.
    // A reader scanning a turn wants to know WHO ran it, on WHAT model, in
    // WHICH lane. The authority ids answer none of those, so they must not be
    // the first thing rendered.
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

    const primary = container.querySelector('[data-delegation-field="execution"]');
    const text = primary?.textContent ?? '';
    expect(text).toContain('Coder (deck_imcodes_w1)');
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('primary');
    // Order, not just presence.
    expect(text.indexOf('deck_imcodes_w1')).toBeLessThan(text.indexOf('claude-opus-5'));
    expect(text.indexOf('claude-opus-5')).toBeLessThan(text.indexOf('primary'));

    // The primary line stays about the executor: provider/runtime and the
    // assignment status are real facts but they are not what a reader scans
    // for, so they belong with the rest of the diagnostics.
    expect(text).not.toContain('anthropic');
    expect(text).not.toContain('delegated');

    // ...and it is the first thing in the row.
    const row = container.querySelector('[data-delegation-dispatch]')!;
    const fields = Array.from(row.querySelectorAll('[data-delegation-field]'))
      .map((node) => node.getAttribute('data-delegation-field'));
    expect(fields[0]).toBe('execution');
  });

  it('always shows the formal task identity and keeps only the dispatch id behind diagnostics', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_9f21',
          taskId: 'task_4410',
          assignmentId: 'asg_5gl',
          taskTitle: 'Enforce formal IM.codes delegation.…',
          taskObjective: 'Enforce formal IM.codes delegation. Preserve the full authoritative objective on every task surface.',
          deliveries: [{
            target: 'deck_imcodes_w1',
            status: 'delivered',
            execution: {
              sessionName: 'deck_imcodes_w1',
              model: 'claude-opus-5',
              pool: 'primary',
              source: 'assignment',
            },
          }],
        }],
      }),
    }));

    // The readable registry title and BOTH exact authority ids are on the card
    // itself, never collapsed: a recipient verifies the whole formal identity.
    const identity = container.querySelector('[data-delegation-field="taskIdentity"]');
    expect(identity).not.toBeNull();
    expect(identity?.closest('details')).toBeNull();
    expect(identity?.querySelector('[data-delegation-field="taskTitle"]')?.textContent)
      .toContain('Enforce formal IM.codes delegation. Preserve the full authoritative objective on every task surface.');
    expect(identity?.querySelector('[data-delegation-field="taskId"] code')?.textContent).toBe('task_4410');
    expect(identity?.querySelector('[data-delegation-field="assignmentId"] code')?.textContent).toBe('asg_5gl');

    // Only the dispatch id stays in the collapsed diagnostics.
    const details = container.querySelector('details[data-delegation-field="diagnostics"]');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('[data-delegation-field="dispatchId"] code')?.textContent).toBe('dsp_9f21');
    expect(details?.querySelector('[data-delegation-field="assignmentId"]')).toBeNull();
  });

  it('bounds a reloaded title and labels a legacy receipt without one as untitled', () => {
    const longTitle = `${'Enforce formal delegation '.repeat(20)}\nsecond line`;
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [
          { dispatchId: 'dsp_long', taskId: 'task_long', assignmentId: 'asg_long', taskTitle: longTitle, deliveries: [{ target: 'deck_x_w1', status: 'delivered' }] },
          { dispatchId: 'dsp_old', taskId: 'task_old', assignmentId: 'asg_old', deliveries: [{ target: 'deck_x_w1', status: 'delivered' }] },
        ],
      }),
    }));
    const titles = Array.from(container.querySelectorAll('[data-delegation-field="taskTitle"]')).map((node) => node.textContent ?? '');
    expect(titles[0]).not.toContain('second line');
    expect(titles[0]!.length).toBeLessThanOrEqual('Task: '.length + 120);
    expect(titles[0]).toMatch(/…$/);
    expect(titles[1]).toContain('Untitled task');
    expect(container.querySelectorAll('[data-delegation-field="assignmentId"] code')[1]?.textContent).toBe('asg_old');
  });

  it('keeps a queued receipt as readable as a delivered one', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_q',
          taskId: 'task_q',
          assignmentId: 'asg_q',
          deliveries: [{
            target: 'deck_imcodes_w2',
            status: 'queued',
            execution: {
              sessionName: 'deck_imcodes_w2',
              model: 'gpt-5.6',
              pool: 'economy',
              source: 'live',
            },
          }],
        }],
      }),
    }));
    const text = container.querySelector('[data-delegation-field="execution"]')?.textContent ?? '';
    expect(text).toContain('deck_imcodes_w2');
    expect(text).toContain('gpt-5.6');
    expect(text).toContain('economy');
  });

  it('still shows the ids for a legacy receipt that carries no executor', () => {
    // Older daemons send no execution facts. Losing the ids there would leave
    // the row saying nothing at all, so diagnostics remain the fallback.
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{
          dispatchId: 'dsp_legacy',
          taskId: 'task_legacy',
          assignmentId: 'asg_legacy',
          deliveries: [{ target: 'deck_imcodes_w1', status: 'delivered' }],
        }],
      }),
    }));
    expect(container.querySelector('[data-delegation-field="execution"]')).toBeNull();
    const details = container.querySelector('details[data-delegation-field="diagnostics"]');
    expect(details?.textContent).toContain('dsp_legacy');
    expect(container.querySelector('[data-delegation-field="taskId"]')?.textContent).toContain('task_legacy');
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

  it('ignores a malformed dispatch without exact task authority ids', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [{ dispatchId: 'dsp_only', deliveries: [{ target: 'deck_x_w1', status: 'queued' }] }],
      }),
    }));

    expect(container.innerHTML).toBe('');
  });

  it('renders every dispatch when a turn made several', () => {
    const { container } = render(h(DelegationClaimBadge, {
      metadata: withClaim({
        status: 'substantiated',
        dispatches: [
          { dispatchId: 'dsp_a', taskId: 'task_a', assignmentId: 'asg_a', deliveries: [{ target: 'w1', status: 'delivered' }] },
          { dispatchId: 'dsp_b', taskId: 'task_b', assignmentId: 'asg_b', deliveries: [{ target: 'w2', status: 'queued' }] },
        ],
      }),
    }));

    const rows = [...container.querySelectorAll('[data-delegation-dispatch]')]
      .map((el) => el.getAttribute('data-delegation-dispatch'));
    expect(rows).toEqual(['dsp_a', 'dsp_b']);
  });
});

describe('readDelegationClaimMetadata', () => {
  it('does not expose an empty projection from nested or flat payload metadata', () => {
    const metadata = withClaim({ status: 'unsubstantiated', dispatches: [] });
    expect(readDelegationClaimMetadata({ text: 'hi', metadata })).toBeUndefined();
    expect(readDelegationClaimMetadata({ text: 'hi', ...metadata })).toBeUndefined();
  });

  it('returns undefined when no projection is present anywhere', () => {
    expect(readDelegationClaimMetadata({ text: 'hi' })).toBeUndefined();
    expect(readDelegationClaimMetadata(undefined)).toBeUndefined();
  });
});

describe('delegation.claim locale coverage', () => {
  const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
  const KEYS = ['none', 'dispatch_count', 'dispatch_id', 'task_id', 'assignment_id', 'execution', 'execution_identity', 'diagnostics'] as const;

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

  it('localizes the visible label/session provenance shape', () => {
    const zh = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/zh-CN.json'), 'utf8')) as {
      delegation: { claim: Record<string, string> };
    };
    const en = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as {
      delegation: { claim: Record<string, string> };
    };
    expect(zh.delegation.claim.execution_identity).toBe('{{label}}（{{sessionName}}）');
    expect(en.delegation.claim.execution_identity).toBe('{{label}} ({{sessionName}})');
  });
});

describe('delegation-claim visual demotion', () => {
  const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
  const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');

  it('gives the executor its own full-width, full-contrast line', () => {
    // Reordering the DOM is only half of "emphasise the executor"; without the
    // rule the three lines render as equal-weight siblings and the ordering is
    // invisible to anyone actually looking at it.
    expect(css).toMatch(/\.delegation-claim-execution \{[^}]*flex: 1 1 100%/);
    expect(css).toMatch(/\.delegation-claim-execution code \{[^}]*font-weight: 600/);
  });

  it('demotes the secondary id and the diagnostics block', () => {
    expect(css).toMatch(/\.delegation-claim-secondary \{[^}]*opacity/);
    expect(css).toMatch(/\.delegation-claim-diagnostics \{[^}]*opacity/);
    // A closed <details> must not look like a link-less dead end.
    expect(css).toMatch(/\.delegation-claim-diagnostics > summary \{[^}]*cursor: pointer/);
  });

  it('stacks the row on narrow viewports instead of scrolling the executor away', () => {
    // Session names and ids are long and monospaced. On a phone the executor
    // is the one thing that must stay on screen.
    const narrow = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(narrow).toContain('.delegation-claim-id { flex: 1 1 100%; }');
    expect(narrow).toContain('overflow-wrap: anywhere');
  });
});

describe('ChatView delegation-claim wiring', () => {
  it('renders no badge for prose-only delegation claims', () => {
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
    expect(container.querySelector('.chat-assistant')).toBeTruthy();
    expect(container.querySelector('[data-delegation-claim]')).toBeNull();
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

  it('renders the dispatch card for a pairs-engine send receipt', () => {
    // The exact receipt shape the `pairs` engine returns: a daemon-minted task
    // id and the executor slot's pair binding id as assignmentId.
    const taskId = 'tsk_0a1b2c3d4e';
    const assignmentId = taskPairBindingId(taskId, 'executor');
    const fact = readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER,
      'send_message',
      { target: 'deck_sub_pairs_exec', message: 'Add a README sentence.', task: { objective: 'Add one README sentence' } },
      {
        status: 'accepted',
        dispatchId: 'send_dispatch_pairs',
        taskId,
        assignmentId,
        taskTitle: 'Add one README sentence',
        taskObjective: 'Add one README sentence',
        deliveries: [{ target: 'deck_sub_pairs_exec', status: 'delivered', taskId, assignmentId }],
      },
    );
    expect(fact).not.toBeNull();
    const claim = projectDelegationClaim([fact!]);
    expect(claim.status).toBe('substantiated');

    const { container } = render(
      <ChatView
        events={[assistantEvent({ text: 'Dispatched.', metadata: withClaim(claim) })] as TimelineEvent[]}
        loading={false}
        hasOlderHistory={false}
        sessionId="deck_claim_brain"
      />,
    );
    const badge = container.querySelector('.chat-assistant [data-delegation-claim]')!;
    expect(badge.getAttribute('data-delegation-claim')).toBe('substantiated');
    expect(badge.querySelector('[data-delegation-field="taskId"] code')?.textContent).toBe(taskId);
    expect(badge.querySelector('[data-delegation-field="assignmentId"] code')?.textContent).toBe(assignmentId);
    expect(badge.textContent ?? '').toContain('Add one README sentence');
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
