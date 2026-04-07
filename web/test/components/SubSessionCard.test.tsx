/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { cleanup, render, waitFor } from '@testing-library/preact';

const chatScrollBottomSpy = vi.fn();
const terminalScrollBottomSpy = vi.fn();
let timelineEvents = [{ type: 'assistant.text', payload: { text: 'hello' } }];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: ({ onScrollBottomFn }: any) => {
    useEffect(() => {
      onScrollBottomFn?.(chatScrollBottomSpy);
    }, [onScrollBottomFn]);
    return <div style={{ height: '1200px' }}>chat</div>;
  },
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: ({ onScrollBottomFn }: any) => {
    useEffect(() => {
      onScrollBottomFn?.(terminalScrollBottomSpy);
    }, [onScrollBottomFn]);
    return null;
  },
}));

vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({ events: timelineEvents, refreshing: false }),
}));

vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: () => null,
}));

import { SubSessionCard } from '../../src/components/SubSessionCard.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-card-1',
    serverId: 'srv-1',
    type: 'claude-code',
    shellBin: null,
    cwd: '/tmp',
    label: 'worker',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_proj_brain',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-card-1',
    state: 'running',
    ...overrides,
  };
}

describe('SubSessionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    timelineEvents = [{ type: 'assistant.text', payload: { text: 'hello' } }];
  });

  afterEach(() => {
    cleanup();
  });

  it('forces preview scroll to bottom after sending from the card input', async () => {
    const ws = { sendSessionCommand: vi.fn() } as any;
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={ws}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const preview = container.querySelector('.subcard-preview') as HTMLDivElement;
    Object.defineProperty(preview, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(preview, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(preview, 'clientHeight', { configurable: true, value: 200 });
    const input = container.querySelector('.subcard-input') as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await waitFor(() => {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', { sessionName: 'deck_sub_sub-card-1', text: 'hello' });
      expect(preview.scrollTop).toBe(1500);
    });
  });

  it('does not apply running or idle-flash classes to idle cards', () => {
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        isFocused={true}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const card = container.querySelector('.subcard') as HTMLDivElement;
    expect(card.className).toContain('subcard-focused');
    expect(card.className).not.toContain('subcard-running-pulse');
    expect(card.className).not.toContain('subcard-idle-flash');
  });

  it('applies idle flash only when explicitly requested', () => {
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        idleFlash={true}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const card = container.querySelector('.subcard') as HTMLDivElement;
    expect(card.className).toContain('subcard-idle-flash');
  });

  it('forces chat preview to follow when timeline events update', async () => {
    const view = render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(chatScrollBottomSpy).toHaveBeenCalled();
    });

    chatScrollBottomSpy.mockClear();
    timelineEvents = [
      { type: 'assistant.text', payload: { text: 'hello' } },
      { type: 'assistant.text', payload: { text: 'next' } },
    ];

    view.rerender(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(chatScrollBottomSpy).toHaveBeenCalled();
    });
  });

  it('forces terminal preview to follow after sending from a shell card', async () => {
    const ws = { sendSessionCommand: vi.fn() } as any;
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ type: 'shell', shellBin: '/bin/bash' })}
        ws={ws}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    terminalScrollBottomSpy.mockClear();
    const input = container.querySelector('.subcard-input') as HTMLInputElement;
    input.value = 'echo hi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await waitFor(() => {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', { sessionName: 'deck_sub_sub-card-1', text: 'echo hi' });
      expect(terminalScrollBottomSpy).toHaveBeenCalled();
    });
  });
});
