/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { TimelineEvent } from '../../src/ws-client.js';
import { isUserVisible } from '../../src/util/isUserVisible.js';

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
      preview: { status: 'loading', path: '/repo/src/app.tsx' },
      rootPath: '/repo',
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
      preview: { status: 'loading', path: '/repo/src/diff.ts' },
      rootPath: '/repo',
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
      preview: { status: 'loading', path: '/repo/src/new-name.ts' },
      rootPath: '/repo',
      sourcePreviewLive: false,
    });
    expect(onPreviewFile).toHaveBeenNthCalledWith(2, {
      path: '/repo/src/deleted.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/src/deleted.ts' },
      rootPath: '/repo',
      sourcePreviewLive: false,
    });
  });
});

describe('isUserVisible', () => {
  it('treats file.change as visible chat content', () => {
    expect(isUserVisible({ type: 'file.change', payload: {} })).toBe(true);
  });
});
