/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  computeRightHalfUnobstructedCloudDocsGeometry,
  executeCloudDocQuote,
  formatCloudDocQuoteBadge,
  formatCloudDocQuoteText,
  getCloudDocQuoteKey,
  mergeCloudDocQuoteText,
  resolveCloudDocQuoteTarget,
} from '../src/cloud-docs-reference.js';
import { publishCloudDocQuote, subscribeCloudDocQuotes } from '../src/cloud-docs-window.js';
import {
  DESKTOP_WINDOW_IDS,
  DESKTOP_WINDOW_KINDS,
  MutableDesktopWindowStack,
} from '../src/window-stack.js';

describe('cloud-docs-reference helpers', () => {
  it('formats cloud_doc and server_file quotes safely without triggering inline popups', () => {
    const cloudQuote = formatCloudDocQuoteText({
      kind: 'cloud_doc',
      docId: 'doc_123\n',
      name: 'Q3 [Plan] | Final\nReport.docx',
    });
    expect(cloudQuote).toBe('[CloudDoc: Q3 [Plan Final Report.docx | id=doc_123] ');
    expect(cloudQuote.endsWith(' ')).toBe(true);
    expect(/^[@;^%/]/.test(cloudQuote)).toBe(false);

    const badge = formatCloudDocQuoteBadge({
      kind: 'cloud_doc',
      docId: 'doc_123',
      name: 'Report.docx',
    });
    expect(badge).toBe('[CloudDoc: Report.docx | id=doc_123]');

    const fileQuote = formatCloudDocQuoteText({
      kind: 'server_file',
      path: '/srv/app/README.md',
      name: 'README.md',
    });
    expect(fileQuote).toBe('@/srv/app/README.md ');
    expect(formatCloudDocQuoteBadge({
      kind: 'server_file',
      path: '@/srv/app/README.md',
      name: 'README.md',
    })).toBe('@/srv/app/README.md');

    expect(getCloudDocQuoteKey({ kind: 'cloud_doc', docId: 'd1', name: 'A.docx' })).toBe('cloud_doc:d1');
    expect(getCloudDocQuoteKey({ kind: 'server_file', path: '/a.pdf', name: 'a.pdf', serverId: 's1' })).toBe('server_file:s1:/a.pdf');
  });

  it('resolves the frontmost open sub-session, falls back to focused/open sub, then main session', () => {
    const stack = new MutableDesktopWindowStack();
    stack.ensureWindow(DESKTOP_WINDOW_IDS.subSession('sub_a'), {
      kind: DESKTOP_WINDOW_KINDS.subSession,
      subId: 'sub_a',
    }, { bringToFront: true });
    stack.ensureWindow(DESKTOP_WINDOW_IDS.subSession('sub_b'), {
      kind: DESKTOP_WINDOW_KINDS.subSession,
      subId: 'sub_b',
    }, { bringToFront: true });
    stack.ensureWindow(DESKTOP_WINDOW_IDS.cloudDocs, {
      kind: DESKTOP_WINDOW_KINDS.cloudDocs,
    }, { bringToFront: true });

    const subSessions = [
      { id: 'sub_a', sessionName: 'deck_sub_a', label: 'A' },
      { id: 'sub_b', sessionName: 'deck_sub_b', label: 'B' },
    ];

    expect(resolveCloudDocQuoteTarget({
      openSubIds: new Set(['sub_a', 'sub_b']),
      stack,
      focusedSubId: 'sub_a',
      subSessions,
      activeSession: 'deck_cd_brain',
    })).toEqual({ kind: 'sub', subId: 'sub_b', sessionName: 'deck_sub_b', label: 'B' });

    // Closed/minimized sub_b must not win over open sub_a
    expect(resolveCloudDocQuoteTarget({
      openSubIds: new Set(['sub_a']),
      stack,
      focusedSubId: 'sub_a',
      subSessions,
      activeSession: 'deck_cd_brain',
    })).toEqual({ kind: 'sub', subId: 'sub_a', sessionName: 'deck_sub_a', label: 'A' });

    // Mobile/no-stack fallback uses openSubIds
    expect(resolveCloudDocQuoteTarget({
      openSubIds: new Set(['sub_b']),
      stack: null,
      focusedSubId: null,
      subSessions,
      activeSession: 'deck_cd_brain',
    })).toEqual({ kind: 'sub', subId: 'sub_b', sessionName: 'deck_sub_b', label: 'B' });

    // No open sub-sessions falls back to main session
    expect(resolveCloudDocQuoteTarget({
      openSubIds: new Set(),
      stack,
      focusedSubId: null,
      subSessions,
      activeSession: 'deck_cd_brain',
    })).toEqual({ kind: 'main', sessionName: 'deck_cd_brain' });

    expect(resolveCloudDocQuoteTarget({
      openSubIds: new Set(),
      stack,
      focusedSubId: null,
      subSessions,
      activeSession: null,
    })).toBeNull();
  });

  it('computes right-half docking geometry with bottom strictly above main session composer', () => {
    const geom1440 = computeRightHalfUnobstructedCloudDocsGeometry({
      workspaceBounds: { x: 240, y: 40, w: 1200, h: 860 },
      composerTopPx: 770,
    });
    expect(geom1440.x).toBeGreaterThanOrEqual(240 + 600);
    expect(geom1440.x + geom1440.w).toBeLessThanOrEqual(240 + 1200);
    expect(geom1440.w).toBeGreaterThanOrEqual(420);
    expect(geom1440.y).toBeGreaterThanOrEqual(40);
    expect(geom1440.y + geom1440.h).toBeLessThanOrEqual(770 - 12);

    // Tight 1024px viewport with sidebar (remaining workspace w = 784, h = 720)
    const geom1024 = computeRightHalfUnobstructedCloudDocsGeometry({
      workspaceBounds: { x: 240, y: 40, w: 784, h: 720 },
      composerTopPx: 640,
      minW: 420,
      minH: 360,
    });
    expect(geom1024.w).toBeGreaterThanOrEqual(420);
    expect(geom1024.x + geom1024.w).toBeLessThanOrEqual(240 + 784);
    expect(geom1024.y + geom1024.h).toBeLessThanOrEqual(640 - 12);
    expect(geom1024.h).toBeGreaterThanOrEqual(360);
  });

  it('desktop main-session quote exits maximize, docks Cloud Docs to right half with bottom above composer, and focuses composer', () => {
    const controlsWrapper = document.createElement('div');
    controlsWrapper.className = 'controls-wrapper';
    controlsWrapper.getBoundingClientRect = () => ({
      x: 240,
      y: 780,
      top: 780,
      bottom: 890,
      left: 240,
      right: 1440,
      width: 1200,
      height: 110,
      toJSON: () => ({}),
    });
    const inputEl = document.createElement('div');
    inputEl.textContent = 'Review';
    controlsWrapper.appendChild(inputEl);
    document.body.appendChild(controlsWrapper);

    const setDesktopCloudDocsMaximized = vi.fn();
    const requestCloudDocsGeometry = vi.fn();
    const bringSubToFront = vi.fn();
    const setShowCloudDocs = vi.fn();
    const focusComposer = vi.fn();
    const appendPendingPrefill = vi.fn();

    try {
      const dest = executeCloudDocQuote({
        target: { kind: 'cloud_doc', docId: 'doc_main', name: 'Architecture.md' },
        openSubIds: new Set(),
        stack: null,
        focusedSubId: null,
        subSessions: [],
        activeSession: 'deck_cd_brain',
        isMobile: false,
        showCloudDocs: true,
        getInputElement: (name) => (name === 'deck_cd_brain' ? inputEl : null),
        getWorkspaceBounds: () => ({ x: 240, y: 40, w: 1200, h: 860 }),
        bringSubToFront,
        setShowCloudDocs,
        setDesktopCloudDocsMaximized,
        requestCloudDocsGeometry,
        appendComposerText: (el, text) => {
          el.textContent = `${el.textContent ?? ''}${text}`;
        },
        focusComposer,
        appendPendingPrefill,
        scheduleFrame: (cb) => cb(),
      });

      expect(dest).toEqual({ kind: 'main', sessionName: 'deck_cd_brain' });
      expect(setDesktopCloudDocsMaximized).toHaveBeenCalledWith(false);
      expect(requestCloudDocsGeometry).toHaveBeenCalledTimes(1);
      const geom = requestCloudDocsGeometry.mock.calls[0][0];
      expect(geom.x).toBeGreaterThanOrEqual(240 + 600);
      expect(geom.x + geom.w).toBeLessThanOrEqual(240 + 1200);
      expect(geom.y + geom.h).toBeLessThanOrEqual(780 - 12);
      expect(setShowCloudDocs).not.toHaveBeenCalled();
      expect(bringSubToFront).not.toHaveBeenCalled();
      expect(inputEl.textContent).toBe('Review [CloudDoc: Architecture.md | id=doc_main] ');
      expect(focusComposer).toHaveBeenCalledWith(inputEl);
      expect(appendPendingPrefill).not.toHaveBeenCalled();
    } finally {
      controlsWrapper.remove();
    }
  });

  it('desktop sub-session quote raises sub-session without undocking Cloud Docs, and mobile hides Cloud Docs', () => {
    const stack = new MutableDesktopWindowStack();
    stack.ensureWindow(DESKTOP_WINDOW_IDS.subSession('sub_2'), {
      kind: DESKTOP_WINDOW_KINDS.subSession,
      subId: 'sub_2',
    }, { bringToFront: true });

    const bringSubToFront = vi.fn();
    const setShowCloudDocs = vi.fn();
    const setDesktopCloudDocsMaximized = vi.fn();
    const requestCloudDocsGeometry = vi.fn();
    let pending = '';

    const desktopSubDest = executeCloudDocQuote({
      target: { kind: 'server_file', path: '/srv/a.txt', name: 'a.txt' },
      openSubIds: new Set(['sub_2']),
      stack,
      focusedSubId: null,
      subSessions: [{ id: 'sub_2', sessionName: 'deck_sub_2', label: 'Worker' }],
      activeSession: 'deck_cd_brain',
      isMobile: false,
      showCloudDocs: true,
      getInputElement: () => null,
      getWorkspaceBounds: () => ({ x: 0, y: 0, w: 1200, h: 800 }),
      bringSubToFront,
      setShowCloudDocs,
      setDesktopCloudDocsMaximized,
      requestCloudDocsGeometry,
      appendComposerText: vi.fn(),
      focusComposer: vi.fn(),
      appendPendingPrefill: (_name, text) => {
        pending = mergeCloudDocQuoteText(pending, text);
      },
      scheduleFrame: (cb) => cb(),
    });

    expect(desktopSubDest).toEqual({ kind: 'sub', subId: 'sub_2', sessionName: 'deck_sub_2', label: 'Worker' });
    expect(bringSubToFront).toHaveBeenCalledWith('sub_2');
    expect(setDesktopCloudDocsMaximized).not.toHaveBeenCalled();
    expect(requestCloudDocsGeometry).not.toHaveBeenCalled();
    expect(setShowCloudDocs).not.toHaveBeenCalled();
    expect(pending).toBe('@/srv/a.txt ');

    executeCloudDocQuote({
      target: { kind: 'cloud_doc', docId: 'doc_m', name: 'M.docx' },
      openSubIds: new Set(),
      stack: null,
      focusedSubId: null,
      subSessions: [],
      activeSession: 'deck_cd_brain',
      isMobile: true,
      showCloudDocs: true,
      getInputElement: () => null,
      getWorkspaceBounds: () => null,
      bringSubToFront,
      setShowCloudDocs,
      setDesktopCloudDocsMaximized,
      requestCloudDocsGeometry,
      appendComposerText: vi.fn(),
      focusComposer: vi.fn(),
      appendPendingPrefill: (_name, text) => {
        pending = mergeCloudDocQuoteText(pending, text);
      },
    });
    expect(setShowCloudDocs).toHaveBeenCalledWith(false);
    expect(pending).toBe('@/srv/a.txt [CloudDoc: M.docx | id=doc_m] ');
  });

  it('handles standalone BroadcastChannel quote flow into desktop main session unmaximize and dock', () => {
    const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>();
    class FakeBroadcastChannel {
      name: string;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      private ownListeners = new Set<(ev: { data: unknown }) => void>();
      constructor(name: string) {
        this.name = name;
        if (!listeners.has(name)) listeners.set(name, new Set());
      }
      addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
        if (type !== 'message') return;
        this.ownListeners.add(fn);
        listeners.get(this.name)?.add(fn);
      }
      removeEventListener(type: string, fn: (ev: { data: unknown }) => void) {
        if (type !== 'message') return;
        this.ownListeners.delete(fn);
        listeners.get(this.name)?.delete(fn);
      }
      postMessage(data: unknown) {
        for (const fn of listeners.get(this.name) ?? []) {
          fn({ data });
        }
      }
      close() {
        for (const fn of this.ownListeners) {
          listeners.get(this.name)?.delete(fn);
        }
        this.ownListeners.clear();
      }
    }

    const prevBC = globalThis.BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;

    const setDesktopCloudDocsMaximized = vi.fn();
    const requestCloudDocsGeometry = vi.fn();
    const receivedPrefills: string[] = [];

    const unsubscribe = subscribeCloudDocQuotes((target) => {
      executeCloudDocQuote({
        target,
        openSubIds: new Set(),
        stack: null,
        focusedSubId: null,
        subSessions: [],
        activeSession: 'deck_cd_brain',
        isMobile: false,
        showCloudDocs: true,
        getInputElement: () => null,
        getWorkspaceBounds: () => ({ x: 0, y: 0, w: 1280, h: 800 }),
        bringSubToFront: vi.fn(),
        setShowCloudDocs: vi.fn(),
        setDesktopCloudDocsMaximized,
        requestCloudDocsGeometry,
        appendComposerText: vi.fn(),
        focusComposer: vi.fn(),
        appendPendingPrefill: (_name, text) => receivedPrefills.push(text),
      });
    });

    try {
      const sent = publishCloudDocQuote({ kind: 'cloud_doc', docId: 'doc_bc', name: 'Popup.xlsx' });
      expect(sent).toBe(true);
      expect(setDesktopCloudDocsMaximized).toHaveBeenCalledWith(false);
      expect(requestCloudDocsGeometry).toHaveBeenCalledTimes(1);
      const geom = requestCloudDocsGeometry.mock.calls[0][0];
      expect(geom.x).toBeGreaterThanOrEqual(640);
      expect(geom.y + geom.h).toBeLessThanOrEqual(800 - 140);
      expect(receivedPrefills).toEqual(['[CloudDoc: Popup.xlsx | id=doc_bc] ']);
    } finally {
      unsubscribe();
      if (prevBC === undefined) delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
      else (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = prevBC;
    }
  });
});
