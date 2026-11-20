/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../../src/ws-client.js';

const i18nMock = vi.hoisted(() => ({
  language: 'en-US',
}));

const nativeMocks = vi.hoisted(() => ({
  streamingPlugin: {} as Record<string, unknown>,
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => new Proxy({}, {
    get: (_target, prop) => (nativeMocks.streamingPlugin as Record<PropertyKey, unknown>)[prop],
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const enDict: Record<string, string> = {
        'chat.tts_speak': 'Read aloud',
        'chat.tts_stop': 'Stop reading',
        'chat.tts_autoread_on': 'Enable auto-read replies',
        'chat.tts_autoread_off': 'Disable auto-read and stop speaking',
        'chat.tts_settings': 'Voice settings',
        'common.on': 'On',
        'common.off': 'Off',
        'settings.tts_auto_read': 'Auto-read new replies',
        'settings.tts_rate': 'Speech rate',
        'settings.tts_current_voice': 'Current voice: {{name}} ({{quality}})',
        'settings.tts_quality_premium': 'Premium',
        'settings.tts_quality_enhanced': 'Enhanced',
        'settings.tts_quality_siri': 'Siri',
        'settings.tts_quality_default': 'Default',
        'settings.tts_ios_enhanced_hint': 'Currently using a standard iOS voice.',
        'settings.tts_open_ios_settings': 'Open iOS Voice Settings',
        'settings.tts_open_android_settings': 'Open Android TTS Settings',
        'common.copy': 'Copy',
        'common.copied': 'Copied',
        'taskPair.card_untitled': 'Untitled task',
        'taskPair.status.working': 'Working',
        'taskPair.status.in_audit': 'In audit',
        'taskPair.status.rework': 'Rework',
        'taskPair.status.rework_round': 'Rework round {{round}}',
        'taskPair.status.passed': 'Audit passed',
        'taskPair.status.done': 'Done',
        'taskPair.status.cancelled': 'Cancelled',
        'taskPair.flag.blocked': 'Blocked',
        'taskPair.flag.needs_input': 'Needs input',
        'tts.task_pair_announcement': 'Task {{title}}: {{status}}',
      };
      const zhDict: Record<string, string> = {
        ...enDict,
        'taskPair.card_untitled': '未命名任务',
        'taskPair.status.working': '进行中',
        'taskPair.status.in_audit': '审计中',
        'taskPair.status.rework_round': '第 {{round}} 轮返工',
        'taskPair.status.passed': '审核通过',
        'taskPair.status.done': '已完成',
        'tts.task_pair_announcement': '任务「{{title}}」，{{status}}',
      };
      const dict = i18nMock.language.startsWith('zh') ? zhDict : enDict;
      let text = dict[key] ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    i18n: {
      get language() { return i18nMock.language; },
      get resolvedLanguage() { return i18nMock.language; },
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api.js')>();
  return {
    ...actual,
    downloadAttachment: vi.fn().mockResolvedValue(undefined),
  };
});
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
    i18nMock.language = 'en-US';
    spoken = [];
    cancelMock = vi.fn();
    nativeMocks.streamingPlugin = {};
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

  it('renders topbar auto-read speaker button right of usage button, stops immediately when toggled off, and skips file-list-only replies', async () => {
    const { getTtsAutoReadEnabled } = await import('../../src/tts.js');
    const { ChatView } = await import('../../src/components/ChatView.js');

    const { container, rerender } = render(
      <ChatView
        events={[makeAssistantEvent('m-init', 'Initial reply.', 1000)]}
        loading={false}
        sessionId="sess-1"
        visible={true}
      />,
    );

    const usageBtn = container.querySelector('.chat-session-usage-btn');
    const controlGroup = container.querySelector('.chat-tts-control-group');
    const speakerBtn = container.querySelector('.chat-tts-autoread-btn') as HTMLButtonElement | null;
    const settingsBtn = container.querySelector('.chat-tts-settings-btn') as HTMLButtonElement | null;
    expect(usageBtn).toBeTruthy();
    expect(controlGroup).toBeTruthy();
    expect(speakerBtn).toBeTruthy();
    expect(settingsBtn).toBeTruthy();
    expect(usageBtn?.nextElementSibling?.className).toBe('chat-tts-control-wrap');
    expect(controlGroup?.contains(speakerBtn)).toBe(true);
    expect(controlGroup?.contains(settingsBtn)).toBe(true);
    expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();
    expect(speakerBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(getTtsAutoReadEnabled()).toBe(false);

    // Toggle on -> aria-pressed=true, persists auto-read=true and does NOT open popover
    await act(async () => {
      fireEvent.click(speakerBtn!);
    });
    expect(speakerBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(getTtsAutoReadEnabled()).toBe(true);
    expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();

    // File-list-only assistant reply -> not auto-read and has no per-message read button
    await act(async () => {
      rerender(
        <ChatView
          events={[
            makeAssistantEvent('m-init', 'Initial reply.', 1000),
            makeAssistantEvent('m-files', '- `web/src/tts.ts`\n- `web/src/styles.css`', 2000),
          ]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(1);

    // Prose reply -> auto-read triggers while active
    await act(async () => {
      rerender(
        <ChatView
          events={[
            makeAssistantEvent('m-init', 'Initial reply.', 1000),
            makeAssistantEvent('m-files', '- `web/src/tts.ts`\n- `web/src/styles.css`', 2000),
            makeAssistantEvent('m-prose', 'Build succeeded cleanly.', 3000),
          ]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken.map((u) => u.text)).toEqual(['Build succeeded cleanly.']);

    // Toggle off -> stops active playback immediately
    const callsBeforeStop = cancelMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(speakerBtn!);
    });
    expect(speakerBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(getTtsAutoReadEnabled()).toBe(false);
    expect(cancelMock.mock.calls.length).toBeGreaterThan(callsBeforeStop);
  });

  it('auto-reads live task pair transitions in UI locale, deduplicates same-state cross-source events, isolates history, and queues concurrent text + task events', async () => {
    const { setTtsAutoReadEnabled } = await import('../../src/tts.js');
    setTtsAutoReadEnabled(true);
    const { ChatView } = await import('../../src/components/ChatView.js');

    const makeTaskPairEvent = (id: string, ts: number, payload: Record<string, unknown>): TimelineEvent => ({
      eventId: id,
      type: 'task_pair.event',
      sessionId: 'sess-1',
      ts,
      epoch: 1,
      seq: ts,
      source: 'daemon',
      confidence: 'high',
      payload,
    } as TimelineEvent);

    const historyEvents: TimelineEvent[] = [
      makeTaskPairEvent('tp-hist', 1000, { taskId: 'tsk_old', title: 'Old task', verb: 'DONE', toStatus: 'done' }),
    ];

    const { rerender } = render(
      <ChatView events={historyEvents} loading={false} sessionId="sess-1" visible={true} />,
    );
    expect(spoken).toHaveLength(0);

    // Reconnect / older backfill: still must NOT speak historical task events
    await act(async () => {
      rerender(
        <ChatView
          events={[
            makeTaskPairEvent('tp-backfill', 500, { taskId: 'tsk_older', title: 'Backfill task', verb: 'PASS', toStatus: 'passed' }),
            ...historyEvents,
          ]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken).toHaveLength(0);

    // Live DISPATCH + STARTED + assistant notice for same working status speaks ONCE, queued after concurrent prose reply
    await act(async () => {
      rerender(
        <ChatView
          events={[
            ...historyEvents,
            makeAssistantEvent('live-msg-1', 'Starting the task now.', 2000),
            makeTaskPairEvent('tp-dispatch', 2001, { taskId: 'tsk_live', title: 'Fix login', verb: 'DISPATCH', toStatus: 'working', round: 0 }),
            makeTaskPairEvent('tp-started', 2002, { taskId: 'tsk_live', title: 'Fix login', verb: 'STARTED', toStatus: 'working', round: 0 }),
          ]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    // First item starts speaking immediately; second is queued FIFO without interrupting
    expect(spoken.map((u) => u.text)).toEqual(['Starting the task now.']);
    await act(async () => { spoken[0].onend?.(); });
    expect(spoken.map((u) => u.text)).toEqual(['Starting the task now.', 'Task Fix login: Working']);
    await act(async () => { spoken[1].onend?.(); });

    // Round 1 rework vs Round 2 rework in zh-CN both speak with round numbers, followed by passed -> done
    i18nMock.language = 'zh-CN';
    await act(async () => {
      rerender(
        <ChatView
          events={[
            ...historyEvents,
            makeAssistantEvent('live-msg-1', 'Starting the task now.', 2000),
            makeTaskPairEvent('tp-dispatch', 2001, { taskId: 'tsk_live', title: 'Fix login', verb: 'DISPATCH', toStatus: 'working', round: 0 }),
            makeTaskPairEvent('tp-rework-1', 3000, { taskId: 'tsk_live', title: 'Fix login', verb: 'REWORK', toStatus: 'rework', round: 1 }),
            makeTaskPairEvent('tp-rework-2', 3100, { taskId: 'tsk_live', title: 'Fix login', verb: 'REWORK', toStatus: 'rework', round: 2 }),
            makeTaskPairEvent('tp-pass', 3200, { taskId: 'tsk_live', title: 'Fix login', verb: 'PASS', toStatus: 'passed', round: 2 }),
          ]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />,
      );
    });
    expect(spoken.slice(2).map((u) => u.text)).toEqual(['任务「Fix login」，第 1 轮返工']);
    await act(async () => { spoken[2].onend?.(); });
    expect(spoken[3].text).toBe('任务「Fix login」，第 2 轮返工');
    await act(async () => { spoken[3].onend?.(); });
    expect(spoken[4].text).toBe('任务「Fix login」，审核通过');
  });

  it('opens compact voice quick-settings popover, syncs auto-read & rate bidirectionally, and closes on outside click or Escape', async () => {
    const {
      getTtsAutoReadEnabled,
      getTtsSpeechRate,
      setTtsSpeechRate,
      setTtsAutoReadEnabled,
    } = await import('../../src/tts.js');
    const { ChatView } = await import('../../src/components/ChatView.js');

    // Preview mode or missing sessionId omits segmented TTS control group completely
    const previewRender = render(
      <ChatView events={[makeAssistantEvent('p1', 'Preview reply.', 1000)]} loading={false} sessionId="sess-1" preview={true} visible={true} />,
    );
    expect(previewRender.container.querySelector('.chat-tts-control-group')).toBeNull();
    previewRender.unmount();

    const noSessionRender = render(
      <ChatView events={[makeAssistantEvent('p2', 'No session.', 1000)]} loading={false} visible={true} />,
    );
    expect(noSessionRender.container.querySelector('.chat-tts-control-group')).toBeNull();
    noSessionRender.unmount();

    const { container } = render(
      <div>
        <div data-testid="outside-area">outside</div>
        <ChatView
          events={[makeAssistantEvent('m1', 'Ready to read.', 1000)]}
          loading={false}
          sessionId="sess-1"
          visible={true}
        />
      </div>,
    );

    const speakerBtn = container.querySelector('.chat-tts-autoread-btn') as HTMLButtonElement;
    const settingsBtn = screen.getByTestId('chat-tts-settings-btn');
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();

    // Open popover on web -> Web hides native section
    await act(async () => {
      fireEvent.click(settingsBtn);
    });
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('chat-tts-settings-popover')).toBeTruthy();
    expect(screen.queryByTestId('chat-tts-settings-native-section')).toBeNull();

    // Toggle auto-read inside popover -> syncs left speaker button + localStorage, and stops speaking when disabled
    const popoverSwitch = screen.getByTestId('chat-tts-settings-autoread-toggle');
    expect(popoverSwitch.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(popoverSwitch);
    });
    expect(popoverSwitch.getAttribute('aria-checked')).toBe('true');
    expect(speakerBtn.getAttribute('aria-pressed')).toBe('true');
    expect(getTtsAutoReadEnabled()).toBe(true);

    const callsBeforeStop = cancelMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(popoverSwitch);
    });
    expect(popoverSwitch.getAttribute('aria-checked')).toBe('false');
    expect(speakerBtn.getAttribute('aria-pressed')).toBe('false');
    expect(getTtsAutoReadEnabled()).toBe(false);
    expect(cancelMock.mock.calls.length).toBeGreaterThan(callsBeforeStop);

    // External SettingsPage update reflects inside open popover immediately
    await act(async () => {
      setTtsAutoReadEnabled(true);
      setTtsSpeechRate(1.25);
    });
    expect(popoverSwitch.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('chat-tts-settings-rate-1.25').getAttribute('aria-pressed')).toBe('true');

    // Selecting rate inside popover updates getTtsSpeechRate & pressed state
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-tts-settings-rate-1.5'));
    });
    expect(getTtsSpeechRate()).toBe(1.5);
    expect(screen.getByTestId('chat-tts-settings-rate-1.5').getAttribute('aria-pressed')).toBe('true');

    // Escape closes popover; reopening and clicking outside closes popover
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(settingsBtn);
    });
    expect(screen.getByTestId('chat-tts-settings-popover')).toBeTruthy();
    await waitFor(async () => {
      fireEvent.mouseDown(screen.getByTestId('outside-area'));
      expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();
    });

    // Clicking inside the popover / control group does NOT close it; pointerdown outside does close it
    await act(async () => {
      fireEvent.click(settingsBtn);
    });
    expect(screen.getByTestId('chat-tts-settings-popover')).toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('chat-tts-settings-popover'));
    });
    expect(screen.getByTestId('chat-tts-settings-popover')).toBeTruthy();
    await waitFor(async () => {
      screen.getByTestId('outside-area').dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();
    });
  });

  it('lazy-loads native iOS voice info & openTtsSettings only when popover opens, and omits missing native capabilities cleanly', async () => {
    const getVoiceMock = vi.fn().mockResolvedValue({
      quality: 'default',
      language: 'zh-CN',
      voiceName: 'Tingting',
      voiceIdentifier: 'com.apple.voice.compact.zh-CN.Tingting',
    });
    const openSettingsMock = vi.fn().mockResolvedValue({ opened: true });

    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
      getPlatform: () => 'ios',
    });
    nativeMocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      getTtsVoiceQuality: getVoiceMock,
      openTtsSettings: openSettingsMock,
    };

    const { ChatView } = await import('../../src/components/ChatView.js');
    const rIos = render(
      <ChatView events={[makeAssistantEvent('m1', 'Hello.', 1000)]} loading={false} sessionId="sess-1" visible={true} />,
    );

    // Closed popover must NOT probe native voice quality eagerly
    expect(getVoiceMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-tts-settings-btn'));
    });

    await waitFor(() => {
      expect(getVoiceMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('chat-tts-settings-current-voice').textContent).toBe('Current voice: Tingting (Default)');
    });
    expect(screen.getByTestId('chat-tts-settings-ios-hint')).toBeTruthy();

    const openBtn = screen.getByTestId('chat-tts-settings-open-native-btn');
    expect(openBtn.textContent).toBe('Open iOS Voice Settings');
    await act(async () => {
      fireEvent.click(openBtn);
    });
    expect(openSettingsMock).toHaveBeenCalledTimes(1);
    rIos.unmount();

    // Siri neural voice suppresses standard iOS warning
    getVoiceMock.mockResolvedValueOnce({
      quality: 'default',
      language: 'zh-CN',
      voiceName: 'Yushu',
      voiceIdentifier: 'com.apple.ttsbundle.siri_yu-shu_zh-CN_compact',
    });
    const rSiri = render(
      <ChatView events={[makeAssistantEvent('m2', 'Hello Siri.', 1000)]} loading={false} sessionId="sess-1" visible={true} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-tts-settings-btn'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-tts-settings-current-voice').textContent).toBe('Current voice: Yushu (Siri)');
    });
    expect(screen.queryByTestId('chat-tts-settings-ios-hint')).toBeNull();
    rSiri.unmount();

    // Android native shows Android open-settings button without iOS-only voice/hint
    const androidOpenMock = vi.fn().mockResolvedValue({ opened: true });
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
      getPlatform: () => 'android',
    });
    nativeMocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      openTtsSettings: androidOpenMock,
    };
    const rAndroid = render(
      <ChatView events={[makeAssistantEvent('m3', 'Hello Android.', 1000)]} loading={false} sessionId="sess-1" visible={true} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-tts-settings-btn'));
    });
    const androidOpenBtn = screen.getByTestId('chat-tts-settings-open-native-btn');
    expect(androidOpenBtn.textContent).toBe('Open Android TTS Settings');
    await act(async () => {
      fireEvent.click(androidOpenBtn);
    });
    expect(androidOpenMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chat-tts-settings-current-voice')).toBeNull();
    expect(screen.queryByTestId('chat-tts-settings-ios-hint')).toBeNull();
    rAndroid.unmount();

    // Legacy native shell without openTtsSettings / getTtsVoiceQuality hides native section cleanly
    nativeMocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
    };
    render(
      <ChatView events={[makeAssistantEvent('m4', 'Hello Legacy.', 1000)]} loading={false} sessionId="sess-1" visible={true} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-tts-settings-btn'));
    });
    expect(screen.queryByTestId('chat-tts-settings-native-section')).toBeNull();
  });
});
