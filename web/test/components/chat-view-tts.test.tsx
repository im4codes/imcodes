/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../../src/ws-client.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'chat.tts_speak': 'Read aloud',
        'chat.tts_stop': 'Stop reading',
        'common.copy': 'Copy',
        'common.copied': 'Copied',
      };
      return dict[key] ?? key;
    },
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/api.js', () => ({ downloadAttachment: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: () => null,
  usePref: () => ({
    value: false, rawValue: false, loaded: true, loading: false, stale: false,
    error: null, save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

class MockUtterance {
  text: string;
  lang = '';
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function makeAssistantEvent(id: string, text: string, ts: number, opts?: { streaming?: boolean; automation?: boolean }): TimelineEvent {
  return {
    eventId: id,
    type: 'assistant.text',
    sessionId: 'sess-1',
    ts,
    epoch: 1,
    seq: ts,
    source: 'daemon',
    confidence: 'high',
    payload: {
      text,
      ...(opts?.streaming ? { streaming: true } : {}),
      ...(opts?.automation ? { automation: true } : {}),
    },
  } as TimelineEvent;
}

describe('ChatView system TTS integration', () => {
  let spoken: MockUtterance[];
  let cancelMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    spoken = [];
    cancelMock = vi.fn();
    vi.stubGlobal('Capacitor', undefined);
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
    vi.stubGlobal('speechSynthesis', {
      speak: vi.fn((u: MockUtterance) => { spoken.push(u); }),
      cancel: cancelMock,
    });
  });

  afterEach(async () => {
    cleanup();
    const { __resetTtsForTests } = await import('../../src/tts.js');
    await __resetTtsForTests();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders speak/stop button for prose replies, supports ctxMenu toggle, and skips code-only blocks', async () => {
    const { ChatView } = await import('../../src/components/ChatView.js');
    const events = [
      makeAssistantEvent('e1', 'Here is the explanation.', 1000),
      {
        eventId: 'u1',
        type: 'user.message',
        sessionId: 'sess-1',
        ts: 1500,
        epoch: 1,
        seq: 1500,
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'show code' },
      } as TimelineEvent,
      makeAssistantEvent('e2', '```ts\nconst x = 1;\n```', 2000),
    ];

    render(<ChatView events={events} loading={false} sessionId="sess-1" />);
    const buttons = screen.getAllByRole('button', { name: 'Read aloud' });
    expect(buttons).toHaveLength(1);

    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('Here is the explanation.');

    const stopBtn = screen.getByRole('button', { name: 'Stop reading' });
    expect(stopBtn.className).toContain('is-speaking');

    // Context menu should reflect Stop reading while speaking, then stop on click
    const bubble = document.querySelector('[data-event-id="e1"]') as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(bubble, { clientX: 40, clientY: 40 });
    });
    const ctxMenuBtn = document.querySelector('.chat-sel-menu button.chat-sel-btn:nth-child(2)') as HTMLButtonElement | null;
    expect(ctxMenuBtn?.textContent).toBe('Stop reading');
    await act(async () => {
      fireEvent.click(ctxMenuBtn!);
    });
    expect(cancelMock).toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(1);
  });

  it('auto-reads only newly completed replies after initial load/backfill and skips history/background tabs', async () => {
    const { setTtsAutoReadEnabled } = await import('../../src/tts.js');
    setTtsAutoReadEnabled(true);
    const { ChatView } = await import('../../src/components/ChatView.js');

    const historyEvents = [
      makeAssistantEvent('hist-1', 'Historical message one.', 1000),
      makeAssistantEvent('hist-2', 'Historical message two.', 2000),
    ];

    // 1. Initial load & finish loading: historical messages must NOT be spoken
    const { rerender, unmount } = render(
      <ChatView events={historyEvents} loading={true} sessionId="sess-1" visible={true} />,
    );
    expect(spoken).toHaveLength(0);

    await act(async () => {
      rerender(<ChatView events={historyEvents} loading={false} sessionId="sess-1" visible={true} />);
    });
    expect(spoken).toHaveLength(0);

    // 2. Older history backfill (loadingOlder) & reconnect refresh (refreshing): must NOT speak
    await act(async () => {
      rerender(
        <ChatView
          events={[makeAssistantEvent('older-0', 'Much older loaded message.', 500), ...historyEvents]}
          loading={false}
          loadingOlder={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken).toHaveLength(0);

    // 3. Streaming chunk arrives: must NOT speak until streaming finishes
    await act(async () => {
      rerender(
        <ChatView
          events={[...historyEvents, makeAssistantEvent('live-1', 'Draft part', 3000, { streaming: true })]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken).toHaveLength(0);

    // 4. Streaming completes: speaks the completed reply
    await act(async () => {
      rerender(
        <ChatView
          events={[...historyEvents, makeAssistantEvent('live-1', 'Final live answer.', 3100, { streaming: false })]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('Final live answer.');

    // 5. Background tab (visible=false): must NOT speak when arriving in background or when becoming visible later
    await act(async () => {
      rerender(
        <ChatView
          events={[
            ...historyEvents,
            makeAssistantEvent('live-1', 'Final live answer.', 3100),
            makeAssistantEvent('bg-1', 'Arrived while tab hidden.', 4000),
          ]}
          loading={false}
          sessionId="sess-1"
          visible={false}
        />,
      );
    });
    expect(spoken).toHaveLength(1);

    await act(async () => {
      rerender(
        <ChatView
          events={[
            ...historyEvents,
            makeAssistantEvent('live-1', 'Final live answer.', 3100),
            makeAssistantEvent('bg-1', 'Arrived while tab hidden.', 4000),
          ]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken).toHaveLength(1);

    // Unmounting active chat cleans up / stops TTS owned by this session
    unmount();
    expect(cancelMock).toHaveBeenCalled();
  });
});
