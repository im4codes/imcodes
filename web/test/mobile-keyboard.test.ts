import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMobileKeyboardState,
  installMobileKeyboardTapDismiss,
  isMobileKeyboardInputTarget,
  isSubSessionBarInputTarget,
  measureMobileKeyboardShrink,
  shouldDismissMobileKeyboardOnTap,
  shouldSuppressSubSessionBarForKeyboard,
} from '../src/mobile-keyboard.js';

describe('getMobileKeyboardState', () => {
  it('keeps controls hidden immediately after focus before the keyboard resize lands', () => {
    expect(getMobileKeyboardState(true, 0, false)).toEqual({
      kbOpen: false,
      hideInputUi: true,
      hadKeyboardOpen: false,
    });
  });

  it('keeps controls hidden while the keyboard is open', () => {
    expect(getMobileKeyboardState(true, 220, false)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });
  });

  it('restores controls when the keyboard closes without a blur event', () => {
    expect(getMobileKeyboardState(true, 0, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: true,
    });
  });

  it('re-hides controls if the focused input opens the keyboard again', () => {
    expect(getMobileKeyboardState(true, 180, true)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });
  });

  it('does not keep keyboard history once focus is gone', () => {
    expect(getMobileKeyboardState(false, 0, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: false,
    });
  });
});

describe('sub-session mobile keyboard targeting & suppression', () => {
  it('identifies main, card, and window keyboard targets accurately', () => {
    document.body.innerHTML = `
      <div class="controls-input" contenteditable="true" data-testid="main-ce"></div>
      <div class="subsession-window">
        <div class="controls-input" contenteditable="true" data-testid="win-ce"></div>
      </div>
      <div class="subcard-bar">
        <div class="subcard-input-area">
          <div class="controls-input" contenteditable="true" data-testid="card-ce"></div>
          <input class="subcard-input" data-testid="card-input" />
        </div>
      </div>
      <button type="button" data-testid="plain-btn">Tap</button>
    `;

    const mainCe = document.querySelector('[data-testid="main-ce"]');
    const winCe = document.querySelector('[data-testid="win-ce"]');
    const cardCe = document.querySelector('[data-testid="card-ce"]');
    const cardInput = document.querySelector('[data-testid="card-input"]');
    const plainBtn = document.querySelector('[data-testid="plain-btn"]');

    expect(isMobileKeyboardInputTarget(mainCe)).toBe(true);
    expect(isMobileKeyboardInputTarget(winCe)).toBe(true);
    expect(isMobileKeyboardInputTarget(cardCe)).toBe(true);
    expect(isMobileKeyboardInputTarget(cardInput)).toBe(true);
    expect(isMobileKeyboardInputTarget(plainBtn)).toBe(false);

    expect(isSubSessionBarInputTarget(mainCe)).toBe(false);
    expect(isSubSessionBarInputTarget(winCe)).toBe(false);
    expect(isSubSessionBarInputTarget(cardCe)).toBe(true);
    expect(isSubSessionBarInputTarget(cardInput)).toBe(true);
    expect(isSubSessionBarInputTarget(plainBtn)).toBe(false);
  });

  it('suppresses .subcard-bar for external/main/window input focus, never when .subcard-bar owns focus', () => {
    document.documentElement.className = '';
    document.body.innerHTML = `
      <div class="subcard-bar">
        <input class="subcard-input" data-testid="card-input" />
      </div>
    `;

    // Positive control: main/window input focus or keyboard open hides .subcard-bar
    document.documentElement.classList.add('input-focused');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(true);
    document.documentElement.classList.add('kb-open');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(true);

    // Focusing sub-session card input sets .subcard-input-focused -> never suppress .subcard-bar
    document.documentElement.classList.add('subcard-input-focused');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(false);

    // Even if .subcard-input-focused is absent, native :focus-within inside .subcard-bar keeps it alive
    document.documentElement.classList.remove('subcard-input-focused');
    const cardInput = document.querySelector('[data-testid="card-input"]') as HTMLInputElement;
    cardInput.focus();
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(false);

    cardInput.blur();
    document.documentElement.className = '';
  });
});

describe('measureMobileKeyboardShrink', () => {
  it('preserves pre-focus baseline across Android staggered adjustResize while keeping layoutVsVisualShrink for --kbh', () => {
    const unfocused = measureMobileKeyboardShrink({
      inputFocused: false,
      layoutHeight: 900,
      visualHeight: 900,
      baselineHeight: 0,
    });
    expect(unfocused).toEqual({ baselineHeight: 900, shrink: 0, layoutVsVisualShrink: 0 });

    // Frame 1: visualViewport shrinks first (900 -> 550)
    const transient = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 900,
      visualHeight: 550,
      baselineHeight: unfocused.baselineHeight,
      hadKeyboardOpen: false,
    });
    expect(transient).toEqual({ baselineHeight: 900, shrink: 350, layoutVsVisualShrink: 350 });
    expect(getMobileKeyboardState(true, transient.shrink, false)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });

    // Frame 2: Android adjustResize / MainActivity IME margin shrinks layoutHeight to 550
    const settled = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 550,
      visualHeight: 550,
      baselineHeight: transient.baselineHeight,
      hadKeyboardOpen: true,
    });
    expect(settled).toEqual({ baselineHeight: 900, shrink: 350, layoutVsVisualShrink: 0 });
    expect(getMobileKeyboardState(true, settled.shrink, true)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });

    // Dismiss: both heights recover to 900
    const dismissed = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 900,
      visualHeight: 900,
      baselineHeight: settled.baselineHeight,
      hadKeyboardOpen: true,
    });
    expect(dismissed).toEqual({ baselineHeight: 900, shrink: 0, layoutVsVisualShrink: 0 });
    expect(getMobileKeyboardState(true, dismissed.shrink, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: true,
    });
  });

  it('detects Android simultaneous adjustResize open and dismiss cleanly', () => {
    const open = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 550,
      visualHeight: 550,
      baselineHeight: 900,
      hadKeyboardOpen: false,
    });
    expect(open).toEqual({ baselineHeight: 900, shrink: 350, layoutVsVisualShrink: 0 });
    expect(getMobileKeyboardState(true, open.shrink, false)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });

    const dismissed = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 900,
      visualHeight: 900,
      baselineHeight: open.baselineHeight,
      hadKeyboardOpen: true,
    });
    expect(dismissed).toEqual({ baselineHeight: 900, shrink: 0, layoutVsVisualShrink: 0 });
    expect(getMobileKeyboardState(true, dismissed.shrink, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: true,
    });
  });

  it('tracks iOS visual-only shrink, iOS Safari URL-bar collapse/restore, unfocused multi-window shrink, browser chrome shifts, and width resets', () => {
    // Unfocused split-screen resize shrinks baseline downward so subsequent focus starts at 0 shrink.
    const split = measureMobileKeyboardShrink({
      inputFocused: false,
      layoutHeight: 620,
      visualHeight: 620,
      baselineHeight: 900,
    });
    expect(split).toEqual({ baselineHeight: 620, shrink: 0, layoutVsVisualShrink: 0 });

    // iOS keyboard: layoutHeight stays 844, visualHeight shrinks to 500
    const iosOpen = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 844,
      visualHeight: 500,
      baselineHeight: 844,
      hadKeyboardOpen: false,
    });
    expect(iosOpen).toEqual({ baselineHeight: 844, shrink: 344, layoutVsVisualShrink: 344 });

    // iOS Safari URL-bar collapse/restore (760/760 -> 810/460 -> 760/760):
    // baselineHeight stays frozen at 760 so restoring 760/760 returns shrink=0 (never stuck open).
    const safariOpen = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 810,
      visualHeight: 460,
      baselineHeight: 760,
      hadKeyboardOpen: false,
    });
    expect(safariOpen).toEqual({ baselineHeight: 760, shrink: 350, layoutVsVisualShrink: 350 });
    expect(getMobileKeyboardState(true, safariOpen.shrink, false)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });

    const safariDismissed = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 760,
      visualHeight: 760,
      baselineHeight: safariOpen.baselineHeight,
      hadKeyboardOpen: true,
    });
    expect(safariDismissed).toEqual({ baselineHeight: 760, shrink: 0, layoutVsVisualShrink: 0 });
    expect(getMobileKeyboardState(true, safariDismissed.shrink, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: true,
    });

    // Synchronous browser-chrome resize (844 -> 780) before keyboard opens does not trigger kbOpen
    const chromeBar = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 780,
      visualHeight: 780,
      baselineHeight: 844,
      hadKeyboardOpen: false,
    });
    expect(chromeBar).toEqual({ baselineHeight: 844, shrink: 0, layoutVsVisualShrink: 0 });

    // Width transition reset (baselineHeight: 0) re-seeds cleanly from current viewport
    const afterWidthReset = measureMobileKeyboardShrink({
      inputFocused: true,
      layoutHeight: 720,
      visualHeight: 720,
      baselineHeight: 0,
      hadKeyboardOpen: false,
    });
    expect(afterWidthReset).toEqual({ baselineHeight: 720, shrink: 0, layoutVsVisualShrink: 0 });
  });
});

function createTouchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  points: Array<{ clientX: number; clientY: number }>,
  changedPoints = points,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points, configurable: true });
  Object.defineProperty(event, 'changedTouches', { value: changedPoints, configurable: true });
  return event;
}

describe('tap blank space to dismiss mobile keyboard', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('allows dismiss only on blank/reading targets when a mobile input is focused and selection is collapsed', () => {
    document.body.innerHTML = `
      <div class="chat-view" data-testid="chat-view">
        <div class="chat-event" data-testid="chat-event"><p data-testid="msg-text">Hello world</p></div>
        <a href="https://example.com" data-testid="msg-link">link</a>
        <span class="chat-path-link" data-testid="path-link">src/app.tsx</span>
        <div class="ask-question-timeline-card-interactive" data-testid="ask-card">
          <div class="ask-option" data-testid="ask-option">Option A</div>
        </div>
        <div class="chat-sel-menu" data-testid="sel-menu">Copy</div>
        <div class="chat-ctx-menu" data-testid="ctx-menu">Reply</div>
      </div>
      <div class="controls" data-testid="controls">
        <div class="controls-composer">
          <div class="controls-input" contenteditable="true" tabindex="0" data-testid="composer">
            <span data-testid="composer-child">typed text</span>
          </div>
          <button type="button" data-testid="send-btn">Send</button>
        </div>
      </div>
      <div class="controls-slash-picker" data-testid="slash-picker"><div data-testid="slash-item">/help</div></div>
      <div class="controls-alias-picker" data-testid="alias-picker"><div data-testid="alias-item">;dev</div></div>
      <div class="at-picker" data-testid="at-picker"><div data-testid="at-item">@agent</div></div>
      <div class="qp" data-testid="qp-panel"><div class="qp-item" data-testid="qp-item">cmd</div></div>
      <div class="voice-overlay" data-testid="voice-overlay"><div data-testid="voice-area"></div></div>
      <div class="remote-desktop-stage" data-testid="rd-stage"><video data-testid="rd-video"></video></div>
      <div class="remote-desktop-mobile-keyboard" data-testid="rd-kb"><div data-testid="rd-key">Ctrl</div></div>
      <div class="subcard-input-area" data-testid="subcard-area"><div data-testid="subcard-row"></div></div>
      <div class="xterm" data-testid="xterm"><div data-testid="xterm-screen"></div></div>
    `;

    const composer = document.querySelector('[data-testid="composer"]') as HTMLElement;
    const composerChild = document.querySelector('[data-testid="composer-child"]');
    const chatView = document.querySelector('[data-testid="chat-view"]');
    const msgText = document.querySelector('[data-testid="msg-text"]');

    // No active input -> false
    expect(shouldDismissMobileKeyboardOnTap(chatView, document.body)).toBe(false);

    // Focused input + blank/reading areas -> true
    expect(shouldDismissMobileKeyboardOnTap(chatView, composer)).toBe(true);
    expect(shouldDismissMobileKeyboardOnTap(msgText, composer)).toBe(true);

    // Active non-collapsed text selection -> false
    expect(shouldDismissMobileKeyboardOnTap(msgText, composer, false)).toBe(false);

    // Tapping inside focused composer or interactive / picker controls -> false
    const exemptTestIds = [
      'composer',
      'composer-child',
      'send-btn',
      'msg-link',
      'path-link',
      'ask-card',
      'ask-option',
      'sel-menu',
      'ctx-menu',
      'controls',
      'slash-picker',
      'slash-item',
      'alias-picker',
      'alias-item',
      'at-picker',
      'at-item',
      'qp-panel',
      'qp-item',
      'voice-overlay',
      'voice-area',
      'rd-stage',
      'rd-video',
      'rd-kb',
      'rd-key',
      'subcard-area',
      'subcard-row',
      'xterm',
      'xterm-screen',
    ];
    for (const id of exemptTestIds) {
      expect(shouldDismissMobileKeyboardOnTap(document.querySelector(`[data-testid="${id}"]`), composer), id).toBe(false);
    }
  });

  it('blurs active input on short single-finger blank tap and ignores drags, long-press, multi-touch, and buttons', () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div class="chat-view" data-testid="chat-view">
        <div class="chat-event" data-testid="chat-event">Hello</div>
      </div>
      <div class="controls">
        <div class="controls-composer">
          <div class="controls-input" contenteditable="true" tabindex="0" data-testid="composer"></div>
          <button type="button" data-testid="send-btn">Send</button>
        </div>
      </div>
    `;

    const composer = document.querySelector('[data-testid="composer"]') as HTMLElement;
    const chatEvent = document.querySelector('[data-testid="chat-event"]') as HTMLElement;
    const sendBtn = document.querySelector('[data-testid="send-btn"]') as HTMLButtonElement;
    const textNode = chatEvent.firstChild as Text;

    const uninstall = installMobileKeyboardTapDismiss(document);
    const blurSpy = vi.spyOn(composer, 'blur');
    const getSelectionSpy = vi.spyOn(document, 'getSelection').mockReturnValue({ isCollapsed: true } as Selection);

    composer.focus();
    expect(document.activeElement).toBe(composer);

    // 1. Scroll/drag (>10px) does NOT blur
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 200 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchmove', [{ clientX: 100, clientY: 215 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 100, clientY: 215 }]));
    expect(blurSpy).not.toHaveBeenCalled();

    // 2. Long press (>350ms) does NOT blur
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 200 }]));
    vi.advanceTimersByTime(400);
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 100, clientY: 200 }]));
    expect(blurSpy).not.toHaveBeenCalled();

    // 3. Multi-touch pinch cancels tap and does NOT blur
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 200 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchmove', [{ clientX: 100, clientY: 200 }, { clientX: 150, clientY: 250 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 100, clientY: 200 }]));
    expect(blurSpy).not.toHaveBeenCalled();

    // 4. Tapping composer/send button does NOT blur
    sendBtn.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 300, clientY: 700 }]));
    sendBtn.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 300, clientY: 700 }]));
    expect(blurSpy).not.toHaveBeenCalled();

    // 5. Non-collapsed text selection does NOT blur
    getSelectionSpy.mockReturnValue({ isCollapsed: false } as Selection);
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 200 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 100, clientY: 200 }]));
    expect(blurSpy).not.toHaveBeenCalled();

    // 6. Short single-finger tap on blank/Text node DOES blur
    getSelectionSpy.mockReturnValue({ isCollapsed: true } as Selection);
    textNode.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 200 }]));
    vi.advanceTimersByTime(80);
    textNode.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 103, clientY: 204 }]));
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(composer);

    // 7. After uninstall, short tap no longer blurs
    composer.focus();
    blurSpy.mockClear();
    uninstall();
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 200 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 100, clientY: 200 }]));
    expect(blurSpy).not.toHaveBeenCalled();
  });

  it('preserves focus on remote desktop stage / prevented events and native textarea or input text selections, while blurring when collapsed or on non-range inputs', () => {
    document.body.innerHTML = `
      <div class="chat-view" data-testid="chat-view">
        <div class="chat-event" data-testid="chat-event">Blank space</div>
      </div>
      <div class="remote-desktop-stage" data-testid="rd-stage">
        <video data-testid="rd-video"></video>
      </div>
      <div class="custom-surface" data-testid="custom-surface">Custom prevented</div>
      <textarea class="remote-desktop-mobile-keyboard-proxy" data-testid="textarea">hello world</textarea>
      <input type="text" data-testid="text-input" value="sample text" />
      <input type="email" data-testid="email-input" value="a@b.c" />
    `;

    const chatEvent = document.querySelector('[data-testid="chat-event"]') as HTMLElement;
    const rdStage = document.querySelector('[data-testid="rd-stage"]') as HTMLElement;
    const rdVideo = document.querySelector('[data-testid="rd-video"]') as HTMLElement;
    const customSurface = document.querySelector('[data-testid="custom-surface"]') as HTMLElement;
    const textarea = document.querySelector('[data-testid="textarea"]') as HTMLTextAreaElement;
    const textInput = document.querySelector('[data-testid="text-input"]') as HTMLInputElement;
    const emailInput = document.querySelector('[data-testid="email-input"]') as HTMLInputElement;

    // Document selection reports collapsed even when native input/textarea has a selection range (as in Chromium)
    vi.spyOn(document, 'getSelection').mockReturnValue({ isCollapsed: true } as Selection);
    const uninstall = installMobileKeyboardTapDismiss(document);

    // 1. Touching .remote-desktop-stage (whose handler calls preventDefault) keeps textarea focus, while blank chat tap blurs
    rdStage.addEventListener('touchend', (e) => e.preventDefault());
    textarea.focus();
    const taBlurSpy = vi.spyOn(textarea, 'blur');
    rdVideo.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 120, clientY: 240 }]));
    rdVideo.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 120, clientY: 240 }]));
    expect(taBlurSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);

    // 2. Any consumed touchend (defaultPrevented=true) keeps focus
    customSurface.addEventListener('touchend', (e) => e.preventDefault());
    customSurface.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 50, clientY: 60 }]));
    customSurface.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 50, clientY: 60 }]));
    expect(taBlurSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);

    // 3. Non-collapsed textarea selection keeps focus even though document.getSelection().isCollapsed === true
    textarea.setSelectionRange(0, 6);
    expect(shouldDismissMobileKeyboardOnTap(chatEvent, textarea)).toBe(false);
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 40, clientY: 40 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 40, clientY: 40 }]));
    expect(taBlurSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);

    // 4. Collapsing textarea selection allows blank chat tap to blur
    textarea.setSelectionRange(3, 3);
    expect(shouldDismissMobileKeyboardOnTap(chatEvent, textarea)).toBe(true);
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 40, clientY: 40 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 40, clientY: 40 }]));
    expect(taBlurSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(textarea);

    // 5. Non-collapsed input[type="text"] selection keeps focus; collapsed blurs
    textInput.focus();
    const inputBlurSpy = vi.spyOn(textInput, 'blur');
    textInput.setSelectionRange(0, 6);
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 40, clientY: 40 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 40, clientY: 40 }]));
    expect(inputBlurSpy).not.toHaveBeenCalled();
    textInput.setSelectionRange(2, 2);
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 40, clientY: 40 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 40, clientY: 40 }]));
    expect(inputBlurSpy).toHaveBeenCalledTimes(1);

    // 6. Input types without numeric selectionStart/selectionEnd (null or throwing InvalidStateError) fall back safely and blur when blank-tapped
    Object.defineProperty(emailInput, 'selectionStart', {
      get: () => null,
      configurable: true,
    });
    Object.defineProperty(emailInput, 'selectionEnd', {
      get: () => null,
      configurable: true,
    });
    emailInput.focus();
    const emailBlurSpy = vi.spyOn(emailInput, 'blur');
    chatEvent.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 40, clientY: 40 }]));
    chatEvent.dispatchEvent(createTouchEvent('touchend', [], [{ clientX: 40, clientY: 40 }]));
    expect(emailBlurSpy).toHaveBeenCalledTimes(1);

    uninstall();
  });
});
