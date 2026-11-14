/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  computeRightHalfUnobstructedCloudDocsGeometry,
  formatCloudDocQuoteBadge,
  formatCloudDocQuoteText,
  getCloudDocQuoteKey,
  resolveCloudDocQuoteTarget,
} from '../src/cloud-docs-reference.js';
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
});
