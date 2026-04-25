/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

const chatScrollBottomSpy = vi.fn();
const chatViewPropsSpy = vi.fn();
const terminalScrollBottomSpy = vi.fn();
const terminalViewPropsSpy = vi.fn();
let timelineEvents = [{ type: 'assistant.text', payload: { text: 'hello' } }];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: (props: any) => {
    chatViewPropsSpy(props);
    const { onScrollBottomFn } = props;
    useEffect(() => {
      onScrollBottomFn?.(chatScrollBottomSpy);
    }, [onScrollBottomFn]);
    return <div style={{ height: '1200px' }}>chat</div>;
  },
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: (props: any) => {
    terminalViewPropsSpy(props);
    const { onScrollBottomFn } = props;
    useEffect(() => {
      onScrollBottomFn?.(terminalScrollBottomSpy);
    }, [onScrollBottomFn]);
    return null;
  },
}));

const addOptimisticUserMessageSpy = vi.fn();
const markOptimisticFailedSpy = vi.fn();
const retryOptimisticMessageSpy = vi.fn();

vi.mock('../../src/hooks/useTimeline.js', () => ({
  useTimeline: () => ({
    events: timelineEvents,
    refreshing: false,
    // Exposed so the card's onSend / handleResendFailed handlers exercise
    // real wiring. Shell sub-sessions deliberately skip useTimeline and the
    // card falls back to no-op; that path is covered by its own test.
    addOptimisticUserMessage: addOptimisticUserMessageSpy,
    markOptimisticFailed: markOptimisticFailedSpy,
    retryOptimisticMessage: retryOptimisticMessageSpy,
  }),
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

  it('keeps shell cards in raw terminal preview mode', async () => {
    const releaseRaw = vi.fn();
    const ws = { holdTerminalRaw: vi.fn(() => releaseRaw), subscribeTerminal: vi.fn() } as any;
    const view = render(
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

    await waitFor(() => {
      expect(ws.holdTerminalRaw).toHaveBeenCalledWith('deck_sub_sub-card-1');
    });

    const props = terminalViewPropsSpy.mock.calls.at(-1)?.[0];
    expect(props.preview).toBe(true);
    expect(props.mobileInput).toBe(true);
    expect(ws.subscribeTerminal).not.toHaveBeenCalled();

    view.unmount();
    expect(releaseRaw).toHaveBeenCalledOnce();
  });

  it('renders the stop button in transport fallback input mode and sends /stop', async () => {
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

    const stop = container.querySelector('.subcard-stop-btn') as HTMLButtonElement | null;
    expect(stop).not.toBeNull();
    fireEvent.click(stop!);

    await waitFor(() => {
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', { sessionName: 'deck_sub_sub-card-1', text: '/stop' });
    });
  });

  it('renders the stop button when the card uses compact SessionControls', async () => {
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport', state: 'running' } as any)}
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
      expect(container.querySelector('.subcard-stop-btn')).not.toBeNull();
    });
  });

  it('disables the stop button for stopped transport cards', () => {
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport', state: 'stopped' } as any)}
        ws={{ sendSessionCommand: vi.fn() } as any}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect((container.querySelector('.subcard-stop-btn') as HTMLButtonElement | null)?.disabled).toBe(true);
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

  it('adds optimistic bubbles for transport sub-session card sends', () => {
    render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport' as any, type: 'claude-code-sdk' } as any)}
        ws={null}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        quickData={{ data: [], recordHistory: vi.fn() } as any}
      />,
    );

    const props = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(typeof props.onSend).toBe('function');

    props.onSend('deck_sub_x', 'card-typed message', {
      commandId: 'cmd-card-1',
      attachments: [{ kind: 'file', name: 'notes.md' }],
      extra: { mode: 'quick' },
    });

    expect(addOptimisticUserMessageSpy).toHaveBeenCalledWith('card-typed message', 'cmd-card-1', {
      attachments: [{ kind: 'file', name: 'notes.md' }],
      resendExtra: { mode: 'quick' },
    });
  });

  it('keeps a new optimistic bubble visible when retrying a failed transport card send', () => {
    timelineEvents = [{
      eventId: 'failed-send',
      type: 'user.message',
      payload: {
        text: 'retry from card',
        failed: true,
        commandId: 'old-card-cmd',
        _resendExtra: { mode: 'quick' },
        attachments: [{ kind: 'file', name: 'notes.md' }],
      },
    }];
    const ws = { sendSessionCommand: vi.fn() } as any;

    render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport' as any, type: 'claude-code-sdk' } as any)}
        ws={ws}
        connected={true}
        isOpen={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        quickData={{ data: [], recordHistory: vi.fn() } as any}
      />,
    );

    const props = chatViewPropsSpy.mock.calls.at(-1)?.[0] as { onResendFailed?: (commandId: string, text: string) => void };
    props.onResendFailed?.('old-card-cmd', 'retry from card');

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_sub_sub-card-1',
      text: 'retry from card',
      mode: 'quick',
    }));
    expect(retryOptimisticMessageSpy).toHaveBeenCalledWith(
      'old-card-cmd',
      expect.any(String),
      'retry from card',
      {
        attachments: [{ kind: 'file', name: 'notes.md' }],
        resendExtra: { mode: 'quick' },
      },
    );
  });
});
