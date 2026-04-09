/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

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

const sessionControlsSpy = vi.fn((props: any) => (
  <div data-testid="session-controls" data-queued={(props.activeSession?.transportPendingMessages ?? []).join('|')}>
    <button type="button" data-testid="session-controls-open-overlay" onClick={() => props.onOverlayOpenChange?.(true)}>open overlay</button>
    <button type="button" data-testid="session-controls-close-overlay" onClick={() => props.onOverlayOpenChange?.(false)}>close overlay</button>
  </div>
));

vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: (props: any) => sessionControlsSpy(props),
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

  it('does not render idle-flash layer for idle cards by default', () => {
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
    expect(container.querySelector('.idle-flash-layer--frame')).toBeNull();
  });

  it('renders an idle-flash layer only when the token increments after mount', () => {
    const view = render(
      <SubSessionCard
        sub={makeSubSession({ state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        idleFlashToken={1}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.idle-flash-layer--frame')).toBeNull();

    view.rerender(
      <SubSessionCard
        sub={makeSubSession({ state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        idleFlashToken={2}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.idle-flash-layer--frame')).not.toBeNull();
  });

  it('does not replay an old idle flash token after remount', () => {
    const first = render(
      <SubSessionCard
        sub={makeSubSession({ state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        idleFlashToken={3}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    first.unmount();

    const second = render(
      <SubSessionCard
        sub={makeSubSession({ state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        idleFlashToken={3}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(second.container.querySelector('.idle-flash-layer--frame')).toBeNull();
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

  it('renders a transport stop icon button and sends /stop from the fallback input path', async () => {
    const ws = { sendSessionCommand: vi.fn() } as any;
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport', state: 'running' } as any)}
        ws={ws}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const stopBtn = container.querySelector('.subcard-stop-btn') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', { sessionName: 'deck_sub_sub-card-1', text: '/stop' });
    });
  });

  it('keeps the transport stop icon when the card uses compact SessionControls', async () => {
    const ws = { sendSessionCommand: vi.fn() } as any;
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport', state: 'running' } as any)}
        ws={ws}
        connected={true}
        isOpen={false}
        quickData={{} as any}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const stopBtn = container.querySelector('.subcard-stop-btn') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', { sessionName: 'deck_sub_sub-card-1', text: '/stop' });
    });
  });

  it('passes queued transport messages through to shared session controls in compact mode', async () => {
    render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport', transportPendingMessages: ['queued send'] } as any)}
        ws={null}
        connected={true}
        isOpen={false}
        quickData={{} as any}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    await waitFor(() => {
      const controls = document.querySelector('[data-testid="session-controls"]') as HTMLElement | null;
      expect(controls?.dataset.queued).toBe('queued send');
    });
  });

  it('raises the whole card above neighbors while a compact dropdown is open', async () => {
    const { container, getByTestId } = render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        quickData={{ data: [], recordHistory: vi.fn() } as any}
      />,
    );

    const card = container.querySelector('.subcard') as HTMLDivElement;
    expect(card.className).not.toContain('subcard-overlay-open');

    fireEvent.click(getByTestId('session-controls-open-overlay'));
    expect(card.className).toContain('subcard-overlay-open');

    fireEvent.click(getByTestId('session-controls-close-overlay'));
    expect(card.className).not.toContain('subcard-overlay-open');
  });

  it('keeps compact meta controls available inside the card composer', () => {
    render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        quickData={{ data: [], recordHistory: vi.fn() } as any}
      />,
    );

    expect(sessionControlsSpy).toHaveBeenCalled();
    const props = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(props.compact).toBe(true);
    expect(props.hideShortcuts).toBeUndefined();
  });
});
