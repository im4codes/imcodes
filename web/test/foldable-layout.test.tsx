/**
 * @vitest-environment jsdom
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';
import { getMobileKeyboardState, shouldResetMobileKeyboardOnWidthTransition } from '../src/mobile-keyboard.js';

const REPO_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const voiceMock = vi.hoisted(() => ({
  startListening: vi.fn(async () => true),
  stopListening: vi.fn(async () => {}),
  isAvailable: vi.fn(() => true),
  prewarm: vi.fn(),
  onAudioLevel: vi.fn(),
  onModelLoading: vi.fn(),
  primeVoiceGesture: vi.fn(() => true),
  cancelVoiceGesturePrime: vi.fn(),
}));

const platformState = vi.hoisted(() => ({
  macDesktop: false,
  touchMobile: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

vi.mock('../src/components/VoiceInput.js', () => voiceMock);

vi.mock('../src/native-platform.js', async () => {
  const actual = await vi.importActual<typeof import('../src/native-platform.js')>('../src/native-platform.js');
  return {
    ...actual,
    isNativeMacDesktop: () => platformState.macDesktop,
  };
});

vi.mock('../src/mobile-device.js', async () => {
  const actual = await vi.importActual<typeof import('../src/mobile-device.js')>('../src/mobile-device.js');
  return {
    ...actual,
    isMobileDevice: () => platformState.touchMobile,
  };
});

import { SessionControls } from '../src/components/SessionControls.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(), addCommand: vi.fn(), addPhrase: vi.fn(),
  removeCommand: vi.fn(), removePhrase: vi.fn(), removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(), clearHistory: vi.fn(), clearSessionHistory: vi.fn(),
};

function makeWs() {
  return {
    connected: true,
    sendSessionCommand: vi.fn(() => 'cmd-1'),
    sendSessionCommandUrgent: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    getDaemonCapabilitySnapshot: vi.fn(() => null),
    onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
    isDaemonCapabilityStale: vi.fn(() => false),
  } as any;
}

describe('Foldable & iPhone Duo responsive behavior', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    vi.clearAllMocks();
    platformState.macDesktop = false;
    platformState.touchMobile = true;
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
  });

  it('keeps touch voice hold-to-talk and mobile placeholder active on unfolded touch phones (>640px) while reacting to live fold/unfold resize', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    const session = { name: 'deck_sub_1', project: 'proj', role: 'executor', state: 'idle' } as any;

    const { container } = render(
      <SessionControls
        ws={makeWs()}
        activeSession={session}
        quickData={quickData}
        onSend={vi.fn()}
        serverId="srv-1"
        subSessions={[]}
      />,
    );

    const composer = container.querySelector('.controls-composer')!;
    const editor = container.querySelector('[contenteditable]')!;
    expect(composer.classList.contains('controls-composer-voice-ready')).toBe(true);
    expect(editor.getAttribute('data-placeholder')).toBe('session.send_placeholder_mobile_voice');
    expect(container.querySelector('[data-voice-trigger="desktop"]')).toBeNull();

    // Simulate unfolding to 780px inner screen without reload
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 780 });
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(container.querySelector('[data-voice-trigger="desktop"]')).not.toBeNull();
    });
    expect(container.querySelector('.controls-composer')!.classList.contains('controls-composer-voice-ready')).toBe(true);
    expect(container.querySelector('[contenteditable]')!.getAttribute('data-placeholder')).toBe('session.send_placeholder_mobile_voice');
  });

  it('keeps desktop shortcut placeholder and disables touch voice lock on desktop (>640px, non-touch)', () => {
    platformState.touchMobile = false;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
    const session = { name: 'deck_sub_1', project: 'proj', role: 'executor', state: 'idle' } as any;

    const { container } = render(
      <SessionControls
        ws={makeWs()}
        activeSession={session}
        quickData={quickData}
        onSend={vi.fn()}
        serverId="srv-1"
        subSessions={[]}
      />,
    );

    const composer = container.querySelector('.controls-composer')!;
    const editor = container.querySelector('[contenteditable]')!;
    expect(composer.classList.contains('controls-composer-voice-ready')).toBe(false);
    expect(editor.getAttribute('data-placeholder')).toBe('session.send_placeholder_desktop_shortcuts');
  });

  it('applies horizontal safe-area insets, expanded foldable rules, and dual-segment hinge avoidance in styles.css', () => {
    const css = readFileSync(join(REPO_WEB_DIR, 'src/styles.css'), 'utf8');
    expect(css).toContain('--sal: env(safe-area-inset-left, 0px);');
    expect(css).toContain('--sar: env(safe-area-inset-right, 0px);');
    expect(css).toContain('padding-left: var(--sal); padding-right: var(--sar);');
    expect(css).toContain('.layout-mobile-expanded .mobile-sidebar-panel');
    expect(css).toContain('.layout-mobile-expanded .mobile-sidebar-overlay.open { background: transparent; pointer-events: none; }');
    expect(css).toContain('.layout-mobile-expanded .mobile-sidebar-overlay.open .mobile-sidebar-panel { pointer-events: auto; }');
    expect(css).toContain('.layout-mobile-expanded:has(> .mobile-sidebar-overlay.open) > .main { margin-left: min(calc(340px / var(--imcodes-ui-zoom-shrink, 1)), calc(44vw / var(--imcodes-ui-zoom-shrink, 1))); min-width: 0; }');
    expect(css).toContain('.layout-mobile-expanded .supervision-task-console.is-mobile');
    expect(css).toContain('.layout-mobile-expanded:has(.supervision-task-console.is-mobile) > .main { margin-right: min(440px, 48vw); min-width: 0; }');
    expect(css).toContain('.layout-mobile-expanded .chat-main > .task-pair-status-panel.is-mobile:not(.is-collapsed):not(.is-fullscreen)');
    expect(css).toContain('.layout-mobile-expanded .chat-view-wrap:has(.chat-main > .task-pair-status-panel.is-mobile:not(.is-collapsed):not(.is-fullscreen)) .chat-view');
    expect(css).toContain('.layout-mobile-expanded .chat-view-wrap:has(.chat-main > .task-pair-status-panel.is-mobile:not(.is-collapsed):not(.is-fullscreen)) .chat-pinned-last-sent');
    expect(css).toContain('.layout-mobile-expanded .chat-view-wrap:has(.chat-main > .task-pair-status-panel.is-mobile:not(.is-collapsed):not(.is-fullscreen)) .chat-scroll-btn');
    // Narrow phone overlay scrim stays intact
    expect(css).toContain('.mobile-sidebar-overlay.open { pointer-events: auto; background: rgba(0,0,0,0.5); }');
    expect(css).toContain('.layout-mobile-expanded .mobile-server-menu-remote-grid');
    expect(css).toContain('@media (horizontal-viewport-segments: 2)');
    expect(css).toContain('viewport-segment-width 0 0');
  });

  it('guards mobile sidebar toggle and supervision console mutual exclusion on expanded viewports in app.tsx', () => {
    const app = readFileSync(join(REPO_WEB_DIR, 'src/app.tsx'), 'utf8');
    expect(app).toContain('const toggleMobileSidebar = useCallback(');
    expect(app).toContain('if (next && isExpandedMobile && showSupervisionTaskConsole)');
    expect(app).toContain('onClick={toggleMobileSidebar}');
  });

  it('docks sidebar, task pair panel, and supervision console side-by-side without overlap in real Chromium at 820x920 while preserving 390x844 phone overlays', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    let chromium: (typeof import('playwright'))['chromium'];
    try {
      ({ chromium } = require('playwright') as typeof import('playwright'));
    } catch {
      return;
    }
    if (!existsSync(chromium.executablePath())) return;

    const css = readFileSync(join(REPO_WEB_DIR, 'src/styles.css'), 'utf8');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
      <div class="layout layout-mobile layout-mobile-expanded" data-testid="layout">
        <main class="main" data-testid="main">
          <div class="mobile-server-bar"><button class="mobile-sidebar-toggle" type="button">≡</button></div>
          <div class="supervision-task-console-workspace">
            <div class="supervision-task-console-primary">
              <div class="chat-view-wrap" data-testid="chat-wrap">
                <div class="chat-main" data-testid="chat-main">
                  <div class="chat-titlebar" style="height:40px;">titlebar</div>
                  <div class="chat-pinned-last-sent" data-testid="pinned">last sent</div>
                  <div class="chat-view" data-testid="chat-view"><div class="chat-event" data-testid="msg" style="background:#1e293b;">hello</div></div>
                  <button class="chat-scroll-btn" data-testid="scroll-btn" type="button">↓</button>
                  <aside class="task-pair-status-panel is-mobile" data-testid="task-panel">panel</aside>
                </div>
              </div>
            </div>
          </div>
        </main>
        <div class="mobile-sidebar-overlay" data-testid="sidebar-overlay">
          <div class="mobile-sidebar-panel" data-testid="sidebar-panel">sidebar</div>
        </div>
      </div>
    </body></html>`;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 820, height: 920 } });
      await page.setContent(html);

      // 1. Open left sidebar + right task panel on 820x920 expanded mobile
      await page.evaluate(() => {
        document.querySelector('[data-testid="sidebar-overlay"]')?.classList.add('open');
      });
      const expandedSidebarAndPanel = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="sidebar-overlay"]')!;
        const sidebar = document.querySelector('[data-testid="sidebar-panel"]')!;
        const main = document.querySelector('[data-testid="main"]')!;
        const chatMain = document.querySelector('[data-testid="chat-main"]')!;
        const chatView = document.querySelector('[data-testid="chat-view"]')!;
        const msg = document.querySelector('[data-testid="msg"]')!;
        const pinned = document.querySelector('[data-testid="pinned"]')!;
        const scrollBtn = document.querySelector('[data-testid="scroll-btn"]')!;
        const taskPanel = document.querySelector('[data-testid="task-panel"]')!;
        const overlayStyle = getComputedStyle(overlay);
        const sidebarStyle = getComputedStyle(sidebar);
        const chatViewStyle = getComputedStyle(chatView);
        const pinnedStyle = getComputedStyle(pinned);
        const scrollBtnStyle = getComputedStyle(scrollBtn);
        return {
          overlayBg: overlayStyle.backgroundColor,
          overlayPointer: overlayStyle.pointerEvents,
          sidebarPointer: sidebarStyle.pointerEvents,
          sidebarRect: sidebar.getBoundingClientRect().toJSON(),
          mainRect: main.getBoundingClientRect().toJSON(),
          chatMainRect: chatMain.getBoundingClientRect().toJSON(),
          msgRect: msg.getBoundingClientRect().toJSON(),
          pinnedRect: pinned.getBoundingClientRect().toJSON(),
          scrollBtnRect: scrollBtn.getBoundingClientRect().toJSON(),
          taskPanelRect: taskPanel.getBoundingClientRect().toJSON(),
          chatViewPaddingRight: parseFloat(chatViewStyle.paddingRight),
          pinnedMarginRight: parseFloat(pinnedStyle.marginRight),
          scrollBtnRight: parseFloat(scrollBtnStyle.right),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });

      expect(expandedSidebarAndPanel.overlayBg).toBe('rgba(0, 0, 0, 0)');
      expect(expandedSidebarAndPanel.overlayPointer).toBe('none');
      expect(expandedSidebarAndPanel.sidebarPointer).toBe('auto');
      expect(expandedSidebarAndPanel.sidebarRect.right).toBeLessThanOrEqual(expandedSidebarAndPanel.mainRect.left + 0.5);
      expect(expandedSidebarAndPanel.scrollWidth).toBeLessThanOrEqual(expandedSidebarAndPanel.innerWidth);
      expect(expandedSidebarAndPanel.taskPanelRect.width).toBeLessThanOrEqual(820 * 0.46 + 1);
      expect(expandedSidebarAndPanel.taskPanelRect.top).toBeGreaterThanOrEqual(expandedSidebarAndPanel.chatMainRect.top + 40 - 0.5);
      expect(Math.abs(expandedSidebarAndPanel.taskPanelRect.bottom - expandedSidebarAndPanel.chatMainRect.bottom)).toBeLessThanOrEqual(1);
      expect(expandedSidebarAndPanel.msgRect.right).toBeLessThanOrEqual(expandedSidebarAndPanel.taskPanelRect.left + 0.5);
      expect(expandedSidebarAndPanel.pinnedRect.right).toBeLessThanOrEqual(expandedSidebarAndPanel.taskPanelRect.left + 0.5);
      expect(expandedSidebarAndPanel.scrollBtnRect.right).toBeLessThanOrEqual(expandedSidebarAndPanel.taskPanelRect.left + 0.5);

      // 2. Scoped sub-window on 820x920: expanded inline panel portaled into .chat-titlebar keeps chat, pinned summary, and scroll button to its left
      await page.evaluate(() => {
        document.querySelector('[data-testid="sidebar-overlay"]')?.classList.remove('open');
        const mainPanel = document.querySelector('[data-testid="task-panel"]');
        mainPanel?.remove();
        const titlebar = document.querySelector('.chat-titlebar')!;
        const subPanel = document.createElement('aside');
        subPanel.className = 'task-pair-status-panel is-mobile';
        subPanel.setAttribute('data-testid', 'scoped-task-panel');
        subPanel.style.height = '180px';
        subPanel.textContent = 'scoped sub-window task panel';
        titlebar.appendChild(subPanel);
        const msg = document.querySelector('[data-testid="msg"]') as HTMLElement;
        msg.textContent = 'Long multi-line sub-window assistant response text that wraps across multiple lines without colliding with the inline task pair status panel on the right side of the chat viewport.';
        const pinnedText = document.querySelector('[data-testid="pinned"]') as HTMLElement;
        pinnedText.textContent = 'Long pinned last sent summary text that stays clear of the inline panel';
      });
      const scopedInline = await page.evaluate(() => {
        const subPanel = document.querySelector('[data-testid="scoped-task-panel"]')!;
        const chatView = document.querySelector('[data-testid="chat-view"]')!;
        const msg = document.querySelector('[data-testid="msg"]')!;
        const pinned = document.querySelector('[data-testid="pinned"]')!;
        const scrollBtn = document.querySelector('[data-testid="scroll-btn"]')!;
        return {
          panelRect: subPanel.getBoundingClientRect().toJSON(),
          msgRect: msg.getBoundingClientRect().toJSON(),
          pinnedRect: pinned.getBoundingClientRect().toJSON(),
          scrollBtnRect: scrollBtn.getBoundingClientRect().toJSON(),
          chatViewPaddingRight: parseFloat(getComputedStyle(chatView).paddingRight),
          pinnedMarginRight: parseFloat(getComputedStyle(pinned).marginRight),
        };
      });
      expect(scopedInline.chatViewPaddingRight).toBeGreaterThanOrEqual(300);
      expect(scopedInline.pinnedMarginRight).toBeGreaterThanOrEqual(300);
      expect(scopedInline.msgRect.right).toBeLessThanOrEqual(scopedInline.panelRect.left + 0.5);
      expect(scopedInline.pinnedRect.right).toBeLessThanOrEqual(scopedInline.panelRect.left + 0.5);
      expect(scopedInline.scrollBtnRect.right).toBeLessThanOrEqual(scopedInline.panelRect.left + 0.5);

      // 3. Close scoped panel, mount and open Supervision Task Console on 820x920
      await page.evaluate(() => {
        document.querySelector('[data-testid="scoped-task-panel"]')?.remove();
        const workspace = document.querySelector('.supervision-task-console-workspace')!;
        const consoleEl = document.createElement('aside');
        consoleEl.className = 'supervision-task-console is-mobile';
        consoleEl.setAttribute('data-testid', 'supervision-console');
        consoleEl.textContent = 'console';
        workspace.appendChild(consoleEl);
      });
      const expandedConsole = await page.evaluate(() => {
        const main = document.querySelector('[data-testid="main"]')!;
        const consoleEl = document.querySelector('[data-testid="supervision-console"]')!;
        return {
          mainRect: main.getBoundingClientRect().toJSON(),
          consoleRect: consoleEl.getBoundingClientRect().toJSON(),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      expect(expandedConsole.mainRect.right).toBeLessThanOrEqual(expandedConsole.consoleRect.left + 0.5);
      expect(expandedConsole.scrollWidth).toBeLessThanOrEqual(expandedConsole.innerWidth);

      // 3. Narrow phone 390x844 (no .layout-mobile-expanded) preserves scrim overlay & fullscreen console
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        document.querySelector('[data-testid="layout"]')?.classList.remove('layout-mobile-expanded');
        document.querySelector('[data-testid="sidebar-overlay"]')?.classList.add('open');
      });
      await page.waitForFunction(() => {
        const overlay = document.querySelector('[data-testid="sidebar-overlay"]');
        return overlay && getComputedStyle(overlay).backgroundColor === 'rgba(0, 0, 0, 0.5)';
      });
      const narrowPhone = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="sidebar-overlay"]')!;
        const main = document.querySelector('[data-testid="main"]')!;
        const consoleEl = document.querySelector('[data-testid="supervision-console"]')!;
        const overlayStyle = getComputedStyle(overlay);
        return {
          overlayBg: overlayStyle.backgroundColor,
          overlayPointer: overlayStyle.pointerEvents,
          mainRect: main.getBoundingClientRect().toJSON(),
          consoleRect: consoleEl.getBoundingClientRect().toJSON(),
        };
      });
      expect(narrowPhone.overlayBg).toBe('rgba(0, 0, 0, 0.5)');
      expect(narrowPhone.overlayPointer).toBe('auto');
      expect(narrowPhone.mainRect.left).toBe(0);
      expect(narrowPhone.consoleRect.width).toBe(390);
    } finally {
      await browser.close();
    }
  });

  it('resets stale keyboard flags on large fold/unfold width transitions when unfocused, but preserves active input focus', () => {
    expect(shouldResetMobileKeyboardOnWidthTransition(390, 780, document.body)).toBe(true);
    expect(shouldResetMobileKeyboardOnWidthTransition(780, 390, null)).toBe(true);
    expect(shouldResetMobileKeyboardOnWidthTransition(390, 410, document.body)).toBe(false);

    const textarea = document.createElement('textarea');
    expect(shouldResetMobileKeyboardOnWidthTransition(390, 780, textarea)).toBe(false);

    // Once stale flags are cleared, getMobileKeyboardState recovers kbOpen=false cleanly
    expect(getMobileKeyboardState(false, 20, false)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: false,
    });
  });
});
