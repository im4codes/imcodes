/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import { isUserVisible } from '../../src/util/isUserVisible.js';
import { AGENT_DELEGATION_SUPERVISION_TASK_OBJECTIVE_MAX_BYTES } from '@shared/agent-delegation.js';

const fileBrowserProps: any[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'chat.file_change_title': `File changes (${vars?.count ?? 0})`,
        'chat.file_change_patch_count': `${vars?.count ?? 0} patch(s)`,
        'chat.file_change_provider_claude_code': 'Claude Code',
        'chat.file_change_provider_opencode': 'OpenCode',
        'chat.file_change_provider_codex_sdk': 'Codex SDK',
        'chat.file_change_provider_qwen': 'Qwen',
        'chat.file_change_provider_gemini': 'Gemini',
        'chat.file_change_operation_create': 'create',
        'chat.file_change_operation_update': 'update',
        'chat.file_change_operation_delete': 'delete',
        'chat.file_change_operation_rename': 'rename',
        'chat.file_change_operation_unknown': 'change',
        'chat.file_change_operation_mixed': 'mixed',
        'chat.file_change_confidence_exact': 'exact',
        'chat.file_change_confidence_derived': 'derived',
        'chat.file_change_confidence_coarse': 'coarse',
        'chat.file_change_confidence_mixed': 'mixed fidelity',
        'chat.file_change_removed': 'Removed',
        'chat.file_change_added': 'Added',
        'chat.file_change_truncated': 'truncated',
        'chat.file_change_no_before': '(no original text)',
        'chat.file_change_no_after': '(no new text)',
        'chat.file_change_derived_no_preview': '(no preview available)',
        'chat.file_change_coarse_hint': 'File path available, but no diff text was provided.',
        'chat.file_change_renamed_from': `${vars?.oldPath ?? ''} → ${vars?.newPath ?? ''}`,
        'peerAuditResult.title': 'Peer audit result',
        'peerAuditResult.attributionAuditor': `Reviewed by ${vars?.auditor ?? ''}`,
        'peerAuditResult.elapsedMs': `Took ${vars?.seconds ?? 0}s`,
        'peerAuditResult.findingsPreview': 'Findings',
        'peerAuditQuick.result_unavailable': 'Peer auditor unavailable.',
        'peerAuditQuick.disposition.sent_unrevocable': 'sent (cannot revoke)',
        'delegation.reply_title': 'Delegation reply',
        'delegation.reply_from': `From ${vars?.source ?? ''}`,
        'delegation.reply_objective_details': 'Full task objective',
        'delegation.claim.task_id': 'Task ID',
        'delegation.claim.assignment_id': 'Assignment ID',
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: (props: any) => {
    fileBrowserProps.push(props);
    return <div data-testid="mock-file-browser" />;
  },
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
// See ChatView.test.tsx for the rationale — opt this suite into the
// "developer" branch of the show_tool_calls preference.
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: true,
    rawValue: true,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { ChatView } from '../../src/components/ChatView.js';

function makeEvent(type: TimelineEvent['type'], payload: Record<string, unknown>, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-a',
    ts: Date.now(),
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
    ...extra,
  } as TimelineEvent;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  fileBrowserProps.length = 0;
});

describe('ChatView file-change cards', () => {
  it('routes right-side file panel previews to the shared preview host', () => {
    localStorage.setItem('chatFilePanelOpen:session-a', '1');
    const onPreviewFile = vi.fn();

    render(
      <ChatView
        events={[]}
        loading={false}
        ws={{} as any}
        workdir="/repo"
        sessionId="session-a"
        onPreviewFile={onPreviewFile}
      />,
    );

    expect(fileBrowserProps).toHaveLength(1);
    fileBrowserProps[0]?.onPreviewFile?.({
      path: '/repo/src/panel.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/src/panel.ts' },
    });

    expect(onPreviewFile).toHaveBeenCalledWith({
      path: '/repo/src/panel.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/src/panel.ts' },
      rootPath: '/repo',
      sourcePreviewLive: false,
    });
  });

  it('renders exact file-change cards with stacked before/after blocks and opens diff preview in the shared preview host', () => {
    const onPreviewFile = vi.fn();
    const events = [
      makeEvent('file.change', {
        batch: {
          provider: 'claude-code',
          patches: [
            {
              filePath: '/repo/src/app.tsx',
              operation: 'update',
              confidence: 'exact',
              beforeText: 'const a = 1;\nconst b = 2;',
              afterText: 'const a = 1;\nconst b = 3;',
            },
          ],
        },
      }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        ws={{} as any}
        workdir="/repo"
        sessionId="session-a"
        onPreviewFile={onPreviewFile}
      />,
    );

    expect(container.textContent).toContain('File changes (1)');
    expect(container.textContent).toContain('exact');
    expect(container.querySelector('.chat-file-change-diff-label-removed')?.textContent).toBe('-');
    expect(container.querySelector('.chat-file-change-diff-label-added')?.textContent).toBe('+');
    expect(Array.from(container.querySelectorAll('.chat-file-change-diff-ln')).every((node) => (node.textContent ?? '').trim() === '')).toBe(true);

    fireEvent.click(container.querySelector('.chat-file-change-path') as HTMLElement);

    expect(onPreviewFile).toHaveBeenCalledWith({
      path: '/repo/src/app.tsx',
      preferDiff: true,
      previewViewMode: 'diff',
      preview: { status: 'loading', path: '/repo/src/app.tsx' },
      rootPath: '/repo',
      sessionName: undefined,
      sourcePreviewLive: false,
    });
  });

  it('renders full file update text instead of clipping long previews', () => {
    const beforeText = Array.from({ length: 18 }, (_, index) => `before line ${index + 1}`).join('\n');
    const afterText = [
      ...Array.from({ length: 18 }, (_, index) => `after line ${index + 1}`),
      `after long tail ${'x'.repeat(1300)}`,
    ].join('\n');
    const derivedText = [
      ...Array.from({ length: 20 }, (_, index) => `derived line ${index + 1}`),
      `derived long tail ${'y'.repeat(1300)}`,
    ].join('\n');
    const events = [
      makeEvent('file.change', {
        batch: {
          provider: 'codex-sdk',
          patches: [
            {
              filePath: '/repo/src/full.ts',
              operation: 'update',
              confidence: 'exact',
              beforeText,
              afterText,
            },
            {
              filePath: '/repo/src/derived-full.ts',
              operation: 'update',
              confidence: 'derived',
              afterText: derivedText,
            },
          ],
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} ws={{} as any} workdir="/repo" sessionId="session-a" />);

    expect(container.textContent).toContain('before line 18');
    expect(container.textContent).toContain('after line 18');
    expect(container.textContent).toContain(`after long tail ${'x'.repeat(1300)}`);
    expect(container.textContent).toContain('derived line 20');
    expect(container.textContent).toContain(`derived long tail ${'y'.repeat(1300)}`);
    expect(container.textContent).not.toContain('truncated');
  });

  it('does not render provider badges on file-change cards', () => {
    const events = [
      makeEvent('file.change', {
        batch: {
          provider: 'qwen',
          patches: [
            {
              filePath: '/repo/src/app.ts',
              operation: 'update',
              confidence: 'derived',
              afterText: 'export const value = 2;',
            },
          ],
        },
      }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        ws={{} as any}
        workdir="/repo"
        sessionId="session-a"
        agentType="claude-code-sdk"
      />,
    );

    expect(container.textContent).toContain('File changes (1)');
    expect(container.textContent).not.toContain('Qwen');
    expect(container.querySelectorAll('.chat-file-change-header .chat-file-change-chip')).toHaveLength(0);
  });

  it('renders derived and coarse file-change states honestly and does not show hidden raw tool rows', () => {
    const events = [
      makeEvent('tool.call', { tool: 'Edit', input: { file_path: '/repo/src/hidden.ts' } }, { hidden: true }),
      makeEvent('tool.result', { output: 'updated successfully' }, { hidden: true }),
      makeEvent('file.change', {
        batch: {
          provider: 'opencode',
          patches: [
            {
              filePath: '/repo/src/derived.ts',
              operation: 'update',
              confidence: 'derived',
              afterText: 'const x = 2;',
            },
            {
              filePath: '/repo/src/coarse.ts',
              operation: 'update',
              confidence: 'coarse',
            },
          ],
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} ws={{} as any} workdir="/repo" sessionId="session-a" />);

    expect(container.textContent).toContain('/repo/src/derived.ts');
    expect(container.textContent).toContain('/repo/src/coarse.ts');
    expect(container.textContent).toContain('derived');
    expect(container.textContent).toContain('coarse');
    expect(container.textContent).not.toContain('hidden.ts');
    expect(container.textContent).not.toContain('Edit ✓');
  });

  it('renders exact unified diffs as stacked removed and added previews and keeps one preview request active', () => {
    const onPreviewFile = vi.fn();
    const events = [
      makeEvent('file.change', {
        batch: {
          provider: 'opencode',
          patches: [
            {
              filePath: '/repo/src/diff.ts',
              operation: 'update',
              confidence: 'exact',
              unifiedDiff: '@@ -1 +1 @@\n-const before = 1;\n+const after = 2;',
            },
            {
              filePath: '/repo/src/diff.ts',
              operation: 'update',
              confidence: 'derived',
              afterText: 'export const extra = true;',
            },
          ],
        },
      }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        ws={{} as any}
        workdir="/repo"
        sessionId="session-a"
        onPreviewFile={onPreviewFile}
      />,
    );

    expect(container.querySelector('.chat-file-change-diff-label-removed')?.textContent).toBe('-');
    expect(Array.from(container.querySelectorAll('.chat-file-change-diff-pre-removed .chat-file-change-diff-ln')).map((node) => node.textContent)).toContain('1');
    expect(container.textContent).toContain('const before = 1;');
    expect(container.querySelector('.chat-file-change-diff-label-added')?.textContent).toBe('+');
    expect(Array.from(container.querySelectorAll('.chat-file-change-diff-pre-added .chat-file-change-diff-ln')).map((node) => node.textContent)).toContain('1');
    expect(container.textContent).toContain('const after = 2;');
    expect(container.textContent).toContain('2 patch(s)');
    expect(container.querySelectorAll('.chat-file-change-file')).toHaveLength(1);

    fireEvent.click(container.querySelector('.chat-file-change-path') as HTMLElement);

    expect(onPreviewFile).toHaveBeenCalledOnce();
    expect(onPreviewFile).toHaveBeenCalledWith({
      path: '/repo/src/diff.ts',
      preferDiff: true,
      previewViewMode: 'diff',
      preview: { status: 'loading', path: '/repo/src/diff.ts' },
      rootPath: '/repo',
      sessionName: undefined,
      sourcePreviewLive: false,
    });
  });

  it('renders created-file exact previews without an empty removed block', () => {
    const events = [
      makeEvent('file.change', {
        batch: {
          provider: 'codex-sdk',
          patches: [
            {
              filePath: '/repo/src/new-file.ts',
              operation: 'create',
              confidence: 'exact',
              unifiedDiff: '@@ -0,0 +1 @@\n+export const created = true;',
            },
          ],
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} ws={{} as any} workdir="/repo" sessionId="session-a" />);

    expect(container.textContent).toContain('export const created = true;');
    expect(container.querySelector('.chat-file-change-diff-label-removed')).toBeNull();
    expect(container.querySelector('.chat-file-change-diff-label-added')?.textContent).toBe('+');
  });

  it('keeps renamed and deleted entries actionable through the shared preview host', () => {
    const onPreviewFile = vi.fn();
    const events = [
      makeEvent('file.change', {
        batch: {
          provider: 'codex-sdk',
          patches: [
            {
              filePath: '/repo/src/new-name.ts',
              oldPath: '/repo/src/old-name.ts',
              operation: 'rename',
              confidence: 'coarse',
            },
            {
              filePath: '/repo/src/deleted.ts',
              operation: 'delete',
              confidence: 'coarse',
            },
          ],
        },
      }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        ws={{} as any}
        workdir="/repo"
        sessionId="session-a"
        onPreviewFile={onPreviewFile}
      />,
    );

    expect(container.textContent).toContain('/repo/src/old-name.ts → /repo/src/new-name.ts');
    expect(container.textContent).toContain('/repo/src/deleted.ts');

    const paths = Array.from(container.querySelectorAll('.chat-file-change-path'));
    fireEvent.click(paths[0] as HTMLElement);
    fireEvent.click(paths[1] as HTMLElement);

    expect(onPreviewFile).toHaveBeenNthCalledWith(1, {
      path: '/repo/src/new-name.ts',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'loading', path: '/repo/src/new-name.ts' },
      rootPath: '/repo',
      sessionName: undefined,
      sourcePreviewLive: false,
    });
    expect(onPreviewFile).toHaveBeenNthCalledWith(2, {
      path: '/repo/src/deleted.ts',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'loading', path: '/repo/src/deleted.ts' },
      rootPath: '/repo',
      sessionName: undefined,
      sourcePreviewLive: false,
    });
  });
});

describe('isUserVisible', () => {
  it('treats file.change as visible chat content', () => {
    expect(isUserVisible({ type: 'file.change', payload: {} })).toBe(true);
  });

  it('treats peer audit results as visible reconnect-safe chat content', () => {
    expect(isUserVisible({ type: 'peer_audit.result', payload: {} })).toBe(true);
  });

  it('treats delegation replies as visible reconnect-safe chat content', () => {
    expect(isUserVisible({ type: 'delegation.reply', payload: {} })).toBe(true);
  });
});

describe('ChatView peer-audit result cards', () => {
  it('renders stable localized outcome/disposition text without exposing wire codes', () => {
    const event = makeEvent('peer_audit.result', {
      outcome: 'target_unavailable',
      auditorLabel: 'Peer CC',
      elapsedMs: 2_100,
      disposition: 'sent_unrevocable',
      findingsPreview: 'Daemon was unavailable.',
    }, { eventId: 'peer-result-1' });
    const { container } = render(
      <ChatView events={[event]} loading={false} sessionId="session-a" />,
    );

    const card = container.querySelector('.peer-audit-result-card');
    expect(card?.getAttribute('data-event-id')).toBe('peer-result-1');
    expect(card?.textContent).toContain('Peer auditor unavailable.');
    expect(card?.textContent).toContain('sent (cannot revoke)');
    expect(card?.textContent).toContain('Peer CC');
    expect(card?.textContent).not.toContain('target_unavailable');
  });
});

describe('ChatView delegation reply cards', () => {
  it('renders authoritative audit findings as markdown in one collapsed card, not JSON escapes', () => {
    const findings = 'VERDICT: PASS\n\n- exact evidence\n- role="status"';
    const event = makeEvent('delegation.reply', {
      memoryExcluded: true,
      sourceSessionName: 'deck_sub_reviewer',
      sourceLabel: 'CC10',
      result: findings,
      verdict: 'PASS',
    }, { eventId: 'audit-result-markdown' });
    const { container } = render(
      <ChatView events={[event]} loading={false} sessionId="session-a" />,
    );

    const card = container.querySelector('.delegation-reply-card');
    expect(card?.querySelector('details')).toBeTruthy();
    expect(card?.querySelector('.delegation-reply-card-body')?.textContent).toBe(findings);
    expect(card?.textContent).toContain('role="status"');
    expect(card?.textContent).not.toContain('\\n');
    expect(card?.textContent).not.toContain('[history truncated]');
  });

  it('renders the reply source and full result without exposing notification framing', () => {
    const event = makeEvent('delegation.reply', {
      memoryExcluded: true,
      sourceSessionName: 'deck_sub_reviewer',
      sourceLabel: 'CC0',
      result: 'PASS with exact evidence.',
    }, { eventId: 'delegation-reply-1' });
    const { container } = render(
      <ChatView events={[event]} loading={false} sessionId="session-a" />,
    );

    const card = container.querySelector('.delegation-reply-card');
    expect(card?.getAttribute('data-event-id')).toBe('delegation-reply-1');
    expect(card?.textContent).toContain('Delegation reply');
    expect(card?.textContent).toContain('From CC0');
    expect(card?.textContent).toContain('PASS with exact evidence.');
    expect(card?.textContent).not.toContain('<imcodes-delegation-completed-v1>');
  });

  it('renders a long audit reply completely inside a scrollable body', () => {
    const result = Array.from({ length: 80 }, (_, index) => `Audit evidence line ${index + 1}`).join('\n');
    const event = makeEvent('delegation.reply', {
      memoryExcluded: true,
      sourceSessionName: 'deck_sub_reviewer',
      sourceLabel: 'CC0',
      result,
    }, { eventId: 'delegation-reply-long' });
    const { container } = render(
      <ChatView events={[event]} loading={false} sessionId="session-a" />,
    );

    const cards = container.querySelectorAll('.delegation-reply-card');
    expect(cards).toHaveLength(1);
    const body = cards[0]?.querySelector('.delegation-reply-card-body');
    expect(body).toBeTruthy();
    expect(body?.textContent).toContain('Audit evidence line 1');
    expect(body?.textContent).toContain('Audit evidence line 80');
  });

  it.each([
    ['PASS', 'delegation-reply-card--pass'],
    ['REWORK', 'delegation-reply-card--rework'],
  ] as const)('renders exact trusted %s verdict metadata as a visible status treatment', (verdict, expectedClass) => {
    const event = makeEvent('delegation.reply', {
      memoryExcluded: true,
      sourceSessionName: 'deck_sub_reviewer',
      result: 'Structured audit result.',
      verdict,
    });
    const { container } = render(
      <ChatView events={[event]} loading={false} sessionId="session-a" />,
    );

    const card = container.querySelector('.delegation-reply-card');
    expect(card?.classList.contains(expectedClass)).toBe(true);
    expect(card?.getAttribute('data-verdict')).toBe(verdict);
    expect(card?.querySelector('.delegation-reply-verdict')?.textContent).toBe(verdict);
  });

  it.each([
    ['missing verdict', {}],
    ['unknown verdict', { verdict: 'APPROVED' }],
    ['nested verdict', { metadata: { verdict: 'PASS' } }],
    ['forged body verdict', { result: '{"verdict":"REWORK"}' }],
  ])('keeps the reply neutral for %s', (_label, extraPayload) => {
    const event = makeEvent('delegation.reply', {
      memoryExcluded: true,
      sourceSessionName: 'deck_sub_reviewer',
      result: 'Ordinary reply saying PASS and REWORK.',
      ...extraPayload,
    });
    const { container } = render(
      <ChatView events={[event]} loading={false} sessionId="session-a" />,
    );

    const card = container.querySelector('.delegation-reply-card');
    expect(card?.classList.contains('delegation-reply-card--pass')).toBe(false);
    expect(card?.classList.contains('delegation-reply-card--rework')).toBe(false);
    expect(card?.hasAttribute('data-verdict')).toBe(false);
    expect(card?.querySelector('.delegation-reply-verdict')).toBeNull();
  });

  it('renders live PASS and reloaded REWORK cards from authoritative projections without task lookup requests', () => {
    const requestSpy = vi.spyOn(globalThis, 'fetch');
    const pass = makeEvent('delegation.reply', {
      sourceLabel: 'CC2',
      result: '{"taskName":"FORGED PASS TITLE"}',
      verdict: 'PASS',
      supervisionTask: {
        version: 1,
        taskId: 'tsk_live',
        assignmentId: 'asg_live',
        attemptId: 'attempt-live',
        revision: 'revision-live',
        title: 'Prevent duplicate payment retries',
      },
    }, { eventId: 'live-pass' });
    const rework = makeEvent('delegation.reply', {
      sourceLabel: 'CC3',
      result: '{"objective":"FORGED REWORK TITLE"}',
      verdict: 'REWORK',
      supervisionTask: {
        version: 1,
        taskId: 'tsk_history',
        assignmentId: 'asg_history',
        attemptId: 'attempt-history',
        revision: 'revision-history',
        title: 'Repair authorization binding',
      },
    }, { eventId: 'history-rework' });
    const view = render(<ChatView events={[pass]} loading={false} sessionId="session-a" />);
    expect(view.container.textContent).toContain('Prevent duplicate payment retries');
    view.rerender(<ChatView events={[rework, pass]} loading={false} sessionId="session-a" />);

    const tasks = view.container.querySelectorAll('[data-testid="delegation-reply-task"]');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.textContent).toContain('tsk_history');
    expect(tasks[0]?.getAttribute('data-attempt-id')).toBe('attempt-history');
    expect(tasks[1]?.textContent).toContain('tsk_live');
    const objectives = view.container.querySelectorAll('.delegation-reply-card-objective');
    expect(objectives[0]?.textContent).toBe('Repair authorization binding');
    expect(objectives[1]?.textContent).toBe('Prevent duplicate payment retries');
    expect(objectives[0]?.textContent).not.toContain('FORGED REWORK TITLE');
    expect(objectives[1]?.textContent).not.toContain('FORGED PASS TITLE');
    expect(requestSpy).not.toHaveBeenCalled();
    requestSpy.mockRestore();
  });

  it('shows a concise title and keeps a 1000-character objective in collapsed details', () => {
    const objective = `Repair the delegation reply card title. ${'Preserve all authoritative objective context. '.repeat(24)}`.trim();
    expect(objective.length).toBeGreaterThan(1000);
    const event = makeEvent('delegation.reply', {
      sourceLabel: 'CC11',
      result: 'PASS',
      supervisionTask: {
        version: 1,
        taskId: 'tsk_long',
        assignmentId: 'asg_long',
        title: 'Repair the delegation reply card title.…',
        objective,
      },
    });
    const { container } = render(<ChatView events={[event]} loading={false} sessionId="session-a" />);
    expect(container.querySelector('.delegation-reply-card-objective')?.textContent)
      .toBe('Repair the delegation reply card title.…');
    const details = container.querySelector('.delegation-reply-objective-details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Full task objective');
    expect(details?.textContent).toContain(objective);
  });

  it.each([
    ['missing projection', undefined],
    ['malformed projection', { version: 1, taskId: '', assignmentId: 'asg_bad', title: 'LEAKED TITLE' }],
    ['oversized title', { version: 1, taskId: 'tsk_fallback', assignmentId: 'asg_fallback', title: 'x'.repeat(AGENT_DELEGATION_SUPERVISION_TASK_OBJECTIVE_MAX_BYTES + 1) }],
  ])('uses a privacy-safe fallback for %s', (_label, supervisionTask) => {
    const event = makeEvent('delegation.reply', {
      sourceLabel: 'CC4',
      result: 'Sender result remains visible.',
      verdict: 'REWORK',
      ...(supervisionTask ? { supervisionTask } : {}),
    });
    const { container } = render(<ChatView events={[event]} loading={false} sessionId="session-a" />);
    const task = container.querySelector('[data-testid="delegation-reply-task"]');
    if (supervisionTask && supervisionTask.taskId) {
      expect(task?.textContent).toContain(supervisionTask.taskId);
      expect(container.querySelector('.delegation-reply-card-objective')).toBeNull();
    } else {
      expect(task).toBeNull();
    }
    expect(container.textContent).not.toContain('LEAKED TITLE');
  });

  it('exposes secondary task ids to assistive technology without making them the title', () => {
    const event = makeEvent('delegation.reply', {
      sourceLabel: 'CC5',
      result: 'Accessible result.',
      verdict: 'PASS',
      supervisionTask: {
        version: 1,
        taskId: 'tsk_a11y',
        assignmentId: 'asg_a11y',
        title: 'Accessible supervision objective',
      },
    });
    const { container } = render(<ChatView events={[event]} loading={false} sessionId="session-a" />);
    const task = container.querySelector('[data-testid="delegation-reply-task"]');
    expect(container.querySelector('.delegation-reply-card-objective')?.textContent).toBe('Accessible supervision objective');
    expect(task?.querySelector('[aria-label="Task ID: tsk_a11y"]')).toBeTruthy();
    expect(task?.querySelector('[aria-label="Assignment ID: asg_a11y"]')).toBeTruthy();
  });

  it.each([
    ['non-daemon source', { source: 'provider' }],
    ['non-high confidence', { confidence: 'medium' }],
  ])('does not trust task title metadata from a %s timeline event', (_label, eventOverride) => {
    const event = makeEvent('delegation.reply', {
      sourceLabel: 'CC6',
      result: 'Untrusted event result.',
      verdict: 'PASS',
      supervisionTask: {
        version: 1,
        taskId: 'tsk_untrusted',
        assignmentId: 'asg_untrusted',
        title: 'UNTRUSTED PROJECTED TITLE',
      },
    }, eventOverride as Partial<TimelineEvent>);
    const { container } = render(<ChatView events={[event]} loading={false} sessionId="session-a" />);
    expect(container.querySelector('[data-testid="delegation-reply-task"]')).toBeNull();
    expect(container.textContent).not.toContain('UNTRUSTED PROJECTED TITLE');
  });
});
