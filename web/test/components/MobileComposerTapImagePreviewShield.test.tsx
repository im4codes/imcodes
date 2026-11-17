/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

const voiceState = vi.hoisted(() => ({
  available: true,
}));

const attachmentSpy = vi.hoisted(() => ({
  onPreviewClick: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: () => null,
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => voiceState.available,
  prewarm: vi.fn(async () => {}),
  startListening: vi.fn(async () => false),
  stopListening: vi.fn(async () => ''),
  onAudioLevel: vi.fn(),
}));

vi.mock('../../src/components/AtPicker.js', () => ({
  AtPicker: () => null,
}));

vi.mock('../../src/components/P2pConfigPanel.js', () => ({
  P2pConfigPanel: () => null,
}));

vi.mock('../../src/components/p2p-combos.js', () => ({
  useP2pCustomCombos: () => ({ allCombos: { presets: [], custom: [] } }),
}));

vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({
    machines: [],
    filtered: [],
    loaded: true,
    loading: false,
    error: null,
    stale: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../src/api.js', () => ({
  uploadFile: vi.fn(),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  fetchSessionSupervisorDefaults: vi.fn().mockResolvedValue(null),
  saveSessionSupervisorDefaults: vi.fn().mockResolvedValue({}),
  getUserPref: vi.fn().mockResolvedValue(null),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
  onUserPrefChanged: vi.fn(() => () => {}),
  apiFetch: vi.fn().mockResolvedValue({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } }),
}));

import { ChatLocalImagePreview } from '../../src/components/ChatLocalImagePreview.js';
import { SessionControls } from '../../src/components/SessionControls.js';
import type { SessionInfo } from '../../src/types.js';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const makeSession = (): SessionInfo => ({
  name: 'deck_main',
  project: 'main',
  role: 'main',
  agentType: 'claude-code-sdk',
  state: 'idle',
  runtimeType: 'transport',
  projectDir: '/tmp/project',
});

const makeQuickData = () => ({
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(),
  addCommand: vi.fn(),
  addPhrase: vi.fn(),
  removeCommand: vi.fn(),
  removePhrase: vi.fn(),
  removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(),
  clearHistory: vi.fn(),
  clearSessionHistory: vi.fn(),
});

function dispatchTouchPointer(el: EventTarget, type: string, pointerId = 1) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(ev, {
    clientX: 180,
    clientY: 680,
    pointerId,
    button: 0,
    pointerType: 'touch',
    isPrimary: true,
    buttons: type === 'pointerup' ? 0 : 1,
  });
  return fireEvent(el, ev);
}

describe('Mobile composer touch-tap click-through shield', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    voiceState.available = true;
    attachmentSpy.onPreviewClick.mockReset();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    document.documentElement.classList.remove('input-focused');
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('input-focused');
    vi.useRealTimers();
  });

  it('blocks compatibility click on shifted ChatLocalImagePreview after tapping unfocused voice-ready composer while allowing genuine follow-up tap', async () => {
    const onFocusIn = (e: FocusEvent) => {
      if ((e.target as HTMLElement | null)?.classList.contains('controls-input')) {
        document.documentElement.classList.add('input-focused');
      }
    };
    document.addEventListener('focusin', onFocusIn);
    try {
      const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
      const loadImagePreview = vi.fn(async () => ({ dataUrl: DATA_URL, alt: 'sent-photo.png' }));

      render(
        <div>
          <div class="chat-view" tabIndex={-1}>
            <ChatLocalImagePreview path="/repo/sent-photo.png" loadImagePreview={loadImagePreview} />
          </div>
          <SessionControls
            ws={ws}
            activeSession={makeSession()}
            quickData={makeQuickData()}
            sessions={[]}
            subSessions={[]}
            serverId="srv-1"
          />
        </div>,
      );

      await waitFor(() => expect(document.querySelector('.chat-local-image-preview-img')).not.toBeNull());
      const img = document.querySelector('.chat-local-image-preview-img') as HTMLImageElement;
      fireEvent.load(img);
      const input = document.querySelector('.controls-input') as HTMLElement;
      expect(input.getAttribute('contenteditable')).toBe('false');

      // Short touch tap on unfocused composer focuses it & adds .input-focused (causing downward layout shift)
      dispatchTouchPointer(input, 'pointerdown', 1);
      await vi.advanceTimersByTimeAsync(25);
      dispatchTouchPointer(input, 'pointerup', 1);

      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.documentElement.classList.contains('input-focused')).toBe(true);

      // Compatibility mousedown + click now hit the shifted <img> underneath the tap coordinates
      const compatDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      fireEvent(img, compatDown);
      expect(compatDown.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input);

      const compatClick = new MouseEvent('click', { bubbles: true, cancelable: true });
      fireEvent(img, compatClick);
      expect(compatClick.defaultPrevented).toBe(true);
      expect(document.querySelector('.fb-lightbox')).toBeNull();
      expect(document.activeElement).toBe(input);

      // Typing works immediately into the focused composer
      input.textContent = 'hello after image';
      fireEvent.input(input);
      expect(input.textContent).toBe('hello after image');

      // Positive control: a genuine new tap (pointerdown -> click) on the image DOES open ImageLightbox
      dispatchTouchPointer(img, 'pointerdown', 2);
      dispatchTouchPointer(img, 'pointerup', 2);
      fireEvent(img, new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(document.querySelector('.fb-lightbox')).not.toBeNull();
    } finally {
      document.removeEventListener('focusin', onFocusIn);
    }
  });

  it('blocks compatibility click on shifted attachment button and covers native focus when VoiceInput is unavailable', async () => {
    voiceState.available = false;
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;

    render(
      <div>
        <div class="chat-view" tabIndex={-1}>
          <button
            type="button"
            class="chat-attachment-dl"
            onClick={() => attachmentSpy.onPreviewClick()}
          >
            attachment.png
          </button>
        </div>
        <SessionControls
          ws={ws}
          activeSession={makeSession()}
          quickData={makeQuickData()}
          sessions={[]}
          subSessions={[]}
          serverId="srv-1"
        />
      </div>,
    );

    const attachmentBtn = document.querySelector('.chat-attachment-dl') as HTMLButtonElement;
    const input = document.querySelector('.controls-input') as HTMLElement;
    expect(input.getAttribute('contenteditable')).toBe('true');

    // Unfocused touch tap: pointerdown -> pointerup -> native mousedown/focus on input -> layout shift -> click hits shifted attachment
    dispatchTouchPointer(input, 'pointerdown', 10);
    await vi.advanceTimersByTimeAsync(20);
    dispatchTouchPointer(input, 'pointerup', 10);
    const nativeMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    fireEvent(input, nativeMouseDown);
    expect(nativeMouseDown.defaultPrevented).toBe(false);
    input.focus();
    fireEvent.focus(input);

    const shiftedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(attachmentBtn, shiftedClick);
    expect(shiftedClick.defaultPrevented).toBe(true);
    expect(attachmentSpy.onPreviewClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    // Subsequent genuine interaction on attachment button succeeds
    dispatchTouchPointer(attachmentBtn, 'pointerdown', 11);
    dispatchTouchPointer(attachmentBtn, 'pointerup', 11);
    fireEvent(attachmentBtn, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(attachmentSpy.onPreviewClick).toHaveBeenCalledTimes(1);
  });
});
