/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../src/components/TerminalView.js', () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

vi.mock('../src/components/UsageFooter.js', () => ({
  UsageFooter: () => <div data-testid="usage-footer" />,
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: () => <div data-testid="file-browser" />,
}));

vi.mock('../src/components/ChatView.js', () => ({
  ChatView: ({ onQuote }: { onQuote?: (text: string) => void }) => {
    const [menuOpen, setMenuOpen] = useState(true);
    return (
      <div data-testid="mock-chat-view">
        {menuOpen && (
          <div class="chat-sel-menu">
            <button
              type="button"
              data-testid="quote-action-btn"
              onClick={() => {
                onQuote?.('quoted message line');
                setMenuOpen(false);
              }}
            >
              Quote
            </button>
          </div>
        )}
      </div>
    );
  },
}));

vi.mock('../src/components/SessionControls.js', () => ({
  SessionControls: ({
    inputRef,
    quotes,
  }: {
    inputRef?: { current: HTMLDivElement | null };
    quotes?: string[];
  }) => (
    <div data-testid="mock-session-controls" data-quote-count={String(quotes?.length ?? 0)}>
      <div
        ref={(el) => {
          if (inputRef) inputRef.current = el;
        }}
        class="controls-input"
        contentEditable="true"
        tabIndex={-1}
        data-testid="composer-input"
      />
    </div>
  ),
}));

vi.mock('../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: () => ({
    events: [],
    loading: false,
    refreshing: false,
    loadingOlder: false,
    hasOlderHistory: false,
    addOptimisticUserMessage: vi.fn(),
    markOptimisticFailed: vi.fn(),
    removeOptimisticMessage: vi.fn(),
    retryOptimisticMessage: vi.fn(),
    loadOlderEvents: vi.fn(),
    historyGap: null,
    loadMessageContext: vi.fn(),
    forceRefresh: vi.fn(),
  }),
}));

vi.mock('../src/git-status-store.js', () => ({
  useSharedGitChanges: () => [],
}));

vi.mock('../src/components/QuickInputPanel.js', () => ({
  useQuickData: () => ({ data: { history: [], sessionHistory: {}, phrases: [], commands: [] }, loaded: true }),
}));

import { SessionPane } from '../src/components/SessionPane.js';
import { SubSessionWindow } from '../src/components/SubSessionWindow.js';

describe('Quote composer auto-focus', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('focuses main SessionPane composer .controls-input when quoting a message', async () => {
    const onInputRef = vi.fn();
    render(
      <SessionPane
        serverId="srv-1"
        session={{
          name: 'deck_alpha_brain',
          project: 'alpha',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
          projectDir: '/tmp/alpha',
        }}
        sessions={[]}
        subSessions={[]}
        ws={null}
        connected={false}
        isActive={true}
        viewMode="chat"
        quickData={{ data: { history: [], sessionHistory: {}, phrases: [], commands: [] }, loaded: true } as any}
        onInputRef={onInputRef}
      />,
    );

    const composer = screen.getByTestId('composer-input');
    const quoteBtn = screen.getByTestId('quote-action-btn');
    quoteBtn.focus();
    expect(document.activeElement).toBe(quoteBtn);

    fireEvent.click(quoteBtn);

    expect(screen.getByTestId('mock-session-controls').getAttribute('data-quote-count')).toBe('1');
    expect(document.activeElement).toBe(composer);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(document.activeElement).toBe(composer);
    expect(onInputRef).toHaveBeenCalledWith(composer);
  });

  it('focuses SubSessionWindow composer .controls-input when quoting a message and registers onInputRef', async () => {
    const onInputRef = vi.fn();
    render(
      <SubSessionWindow
        sub={{
          id: 'sub-1',
          serverId: 'srv-1',
          sessionName: 'deck_sub_sub-1',
          parentSession: 'deck_alpha_brain',
          label: 'Worker 1',
          type: 'codex',
          state: 'idle',
          cwd: '/tmp/alpha',
        } as any}
        ws={null}
        connected={false}
        active={true}
        visible={true}
        zIndex={6000}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        onFocus={vi.fn()}
        onInputRef={onInputRef}
      />,
    );

    const composer = screen.getByTestId('composer-input');
    expect(onInputRef).toHaveBeenCalledWith(composer);

    const quoteBtn = screen.getByTestId('quote-action-btn');
    quoteBtn.focus();
    expect(document.activeElement).toBe(quoteBtn);

    fireEvent.click(quoteBtn);

    expect(screen.getByTestId('mock-session-controls').getAttribute('data-quote-count')).toBe('1');
    expect(document.activeElement).toBe(composer);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(document.activeElement).toBe(composer);
  });
});
