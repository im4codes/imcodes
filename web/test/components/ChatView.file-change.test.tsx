/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
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

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: any) => <div data-testid="floating-panel">{children}</div>,
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
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
  fileBrowserProps.length = 0;
});

describe('ChatView file-change cards', () => {
  it('renders exact file-change cards with stacked before/after blocks and opens diff preview in FileBrowser', async () => {
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

    const { container } = render(<ChatView events={events} loading={false} ws={{} as any} workdir="/repo" sessionId="session-a" />);

    expect(container.textContent).toContain('File changes (1)');
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('exact');
    expect(container.textContent).toContain('Removed');
    expect(container.textContent).toContain('Added');

    fireEvent.click(container.querySelector('.chat-file-change-path') as HTMLElement);

    await waitFor(() => {
      expect(fileBrowserProps).toHaveLength(1);
    });
    expect(fileBrowserProps[0]?.autoPreviewPath).toBe('/repo/src/app.tsx');
    expect(fileBrowserProps[0]?.autoPreviewPreferDiff).toBe(true);
    expect(fileBrowserProps[0]?.initialPath).toBe('/repo/src');
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

  it('renders exact unified diffs as stacked removed and added previews and keeps one preview host active', async () => {
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

    const { container, getAllByTestId } = render(<ChatView events={events} loading={false} ws={{} as any} workdir="/repo" sessionId="session-a" />);

    expect(container.textContent).toContain('OpenCode');
    expect(container.textContent).toContain('Removed');
    expect(container.textContent).toContain('const before = 1;');
    expect(container.textContent).toContain('Added');
    expect(container.textContent).toContain('const after = 2;');
    expect(container.textContent).toContain('2 patch(s)');
    expect(container.querySelectorAll('.chat-file-change-file')).toHaveLength(1);

    fireEvent.click(container.querySelector('.chat-file-change-path') as HTMLElement);

    await waitFor(() => {
      expect(getAllByTestId('mock-file-browser')).toHaveLength(1);
    });
  });

  it('keeps renamed and deleted entries actionable through the file browser handoff', async () => {
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

    const { container } = render(<ChatView events={events} loading={false} ws={{} as any} workdir="/repo" sessionId="session-a" />);

    expect(container.textContent).toContain('/repo/src/old-name.ts → /repo/src/new-name.ts');
    expect(container.textContent).toContain('/repo/src/deleted.ts');

    const paths = Array.from(container.querySelectorAll('.chat-file-change-path'));
    fireEvent.click(paths[0] as HTMLElement);
    fireEvent.click(paths[1] as HTMLElement);

    await waitFor(() => {
      expect(fileBrowserProps.length).toBeGreaterThanOrEqual(2);
    });

    expect(fileBrowserProps[0]?.autoPreviewPath).toBe('/repo/src/new-name.ts');
    expect(fileBrowserProps[0]?.autoPreviewPreferDiff).toBe(false);
    expect(fileBrowserProps[1]?.autoPreviewPath).toBe('/repo/src/deleted.ts');
    expect(fileBrowserProps[1]?.autoPreviewPreferDiff).toBe(false);
  });
});

describe('isUserVisible', () => {
  it('treats file.change as visible chat content', () => {
    expect(isUserVisible({ type: 'file.change', payload: {} })).toBe(true);
  });
});
