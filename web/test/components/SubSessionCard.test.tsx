/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

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
const useTimelineSpy = vi.fn();

vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: (...args: unknown[]) => {
    useTimelineSpy(...args);
    return {
      events: timelineEvents,
      refreshing: false,
      // Exposed so the card's onSend / handleResendFailed handlers exercise
      // real wiring. Shell sub-sessions deliberately skip useTimeline and the
      // card falls back to no-op; that path is covered by its own test.
      addOptimisticUserMessage: addOptimisticUserMessageSpy,
      markOptimisticFailed: markOptimisticFailedSpy,
      retryOptimisticMessage: retryOptimisticMessageSpy,
    };
  },
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
    localStorage.clear();
    vi.clearAllMocks();
    timelineEvents = [{ type: 'assistant.text', payload: { text: 'hello' } }];
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    localStorage.clear();
  });

  it('projects canonical peer-audit identity/model metadata into compact SessionControls', () => {
    render(
      <SubSessionCard
        sub={makeSubSession({
          type: 'codex-sdk',
          sessionInstanceId: 'card-instance-1',
          runtimeEpoch: 'card-runtime-1',
          activeModel: 'gpt-5.6',
          providerId: 'openai',
        })}
        ws={null}
        connected={true}
        quickData={{ data: [], recordHistory: vi.fn() } as any}
        isOpen={false}
        isFocused={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const props = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(props.activeSession).toMatchObject({
      name: 'deck_sub_sub-card-1',
      sessionInstanceId: 'card-instance-1',
      runtimeEpoch: 'card-runtime-1',
      activeModel: 'gpt-5.6',
      providerId: 'openai',
    });
  });

  it('attaches the live timeline before closed preview hydration', async () => {
    vi.useFakeTimers();
    render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={false}
        isFocused={false}
        previewHydrateDelayMs={200}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(useTimelineSpy).toHaveBeenLastCalledWith('deck_sub_sub-card-1', null, undefined, {
      isActiveSession: false,
      isVisible: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(useTimelineSpy).toHaveBeenLastCalledWith('deck_sub_sub-card-1', null, undefined, {
      isActiveSession: false,
      isVisible: true,
    });
  });


  it('treats an open but unfocused card as an active timeline consumer', () => {
    render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={true}
        isFocused={false}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(useTimelineSpy).toHaveBeenLastCalledWith('deck_sub_sub-card-1', null, undefined, {
      isActiveSession: true,
      isVisible: true,
    });
  });

  it('passes streaming assistant text to the card ChatView before hydration delay completes', () => {
    timelineEvents = [{
      eventId: 'stream-1',
      sessionId: 'deck_sub_sub-card-1',
      type: 'assistant.text',
      payload: { text: 'partial stream', streaming: true },
    }];

    render(
      <SubSessionCard
        sub={makeSubSession()}
        ws={null}
        connected={true}
        isOpen={false}
        isFocused={false}
        previewHydrateDelayMs={1200}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const props = chatViewPropsSpy.mock.calls.at(-1)?.[0];
    expect(props.events).toEqual(timelineEvents);
    expect(props.events[0].payload).toMatchObject({ text: 'partial stream', streaming: true });
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
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_sub_sub-card-1',
        text: 'hello',
        commandId: expect.any(String),
      }));
      expect(preview.scrollTop).toBe(1500);
    });
    const sentPayload = ws.sendSessionCommand.mock.calls[0]?.[1];
    expect(addOptimisticUserMessageSpy).toHaveBeenCalledWith('hello', sentPayload.commandId);
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

  it('exposes the accent color as a CSS variable on the root card', () => {
    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ id: 'sub-accent', sessionName: 'deck_sub_sub-accent', state: 'idle' })}
        ws={null}
        connected={true}
        isOpen={false}
        accentColor="#fb7185"
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const card = container.querySelector('.subcard') as HTMLElement;
    expect(card.style.getPropertyValue('--subsession-accent-color')).toBe('#fb7185');
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
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_sub_sub-card-1',
        text: 'echo hi',
        commandId: expect.any(String),
      }));
      expect(terminalScrollBottomSpy).toHaveBeenCalled();
    });
    expect(addOptimisticUserMessageSpy).not.toHaveBeenCalled();
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

  it('fallback shell card cleanup unsubscribes instead of entering passive mode', async () => {
    const ws = { subscribeTerminal: vi.fn(), unsubscribeTerminal: vi.fn() } as any;
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
      expect(ws.subscribeTerminal).toHaveBeenCalledWith('deck_sub_sub-card-1', true);
    });

    view.unmount();

    expect(ws.unsubscribeTerminal).toHaveBeenCalledWith('deck_sub_sub-card-1');
    expect(ws.subscribeTerminal).not.toHaveBeenCalledWith('deck_sub_sub-card-1', false);
  });

  it('renders the stop button in transport fallback input mode and sends direct cancel via the urgent path', async () => {
    // Stop is highest-priority — it must use sendSessionCommandUrgent so a
    // visibility/focus probe-flip (`_connected = false`) can't silently
    // drop the click. See ws-client.ts sendUrgent for the full rationale.
    const ws = { sendSessionCommand: vi.fn(), sendSessionCommandUrgent: vi.fn() } as any;
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
      expect(ws.sendSessionCommandUrgent).toHaveBeenCalledWith('cancel', {
        sessionName: 'deck_sub_sub-card-1',
        commandId: expect.any(String),
      });
    });
    // Stop must not be represented as a chat send.
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalledWith('send', expect.objectContaining({ text: '/stop' }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalledWith('send', expect.objectContaining({ text: '/stop' }));
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


  it('passes React connection state into shared session controls in compact mode', async () => {
    const ws = { connected: false, sendSessionCommand: vi.fn(), subscribeTransportSession: vi.fn(), unsubscribeTransportSession: vi.fn() } as any;
    render(
      <SubSessionCard
        sub={makeSubSession({ runtimeType: 'transport' } as any)}
        ws={ws}
        connected={true}
        isOpen={false}
        quickData={{} as any}
        onOpen={vi.fn()}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(sessionControlsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ connected: true }));
    });
  });

  it('uses saved codex preference as legacy fallback for compact model-less codex-sdk sessions', async () => {
    localStorage.setItem('imcodes-codex-model:deck_sub_sub-card-1', 'gpt-5.5');
    timelineEvents = [{
      type: 'usage.update',
      payload: {
        inputTokens: 166_000,
        cacheTokens: 0,
        contextWindow: 258_400,
        contextWindowSource: 'provider',
      },
    }] as any;

    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({ type: 'codex-sdk', runtimeType: 'transport' as any } as any)}
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
      expect(sessionControlsSpy).toHaveBeenCalled();
    });

    const props = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(props.detectedModel).toBe('gpt-5.5');
    const ctxBar = container.querySelector('.subcard-ctx-bar') as HTMLElement | null;
    expect(ctxBar?.getAttribute('title')).toContain('Context: 166k / 258k (64%)');
    expect(ctxBar?.getAttribute('title')).not.toContain('/ 922k');
  });

  it('passes model metadata to compact controls and computes GPT-5.5 ctx from session metadata when usage omits model', async () => {
    timelineEvents = [{
      type: 'usage.update',
      payload: {
        inputTokens: 100_000,
        cacheTokens: 0,
        contextWindow: 258_400,
        contextWindowSource: 'provider',
      },
    }] as any;

    const { container } = render(
      <SubSessionCard
        sub={makeSubSession({
          type: 'codex-sdk',
          runtimeType: 'transport' as any,
          activeModel: 'gpt-5.5',
          requestedModel: 'gpt-5.5',
          modelDisplay: 'gpt-5.5',
        } as any)}
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
      expect(sessionControlsSpy).toHaveBeenCalled();
    });

    const props = sessionControlsSpy.mock.calls.at(-1)?.[0];
    expect(props.activeSession.activeModel).toBe('gpt-5.5');
    expect(props.activeSession.requestedModel).toBe('gpt-5.5');
    expect(props.detectedModel).toBe('gpt-5.5');

    const ctxBar = container.querySelector('.subcard-ctx-bar') as HTMLElement | null;
    expect(ctxBar?.getAttribute('title')).toContain('Context: 100k / 258k (39%)');
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
