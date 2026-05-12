import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Style contracts that must NOT regress.
 *
 * jsdom doesn't load stylesheets, so component tests can't observe these
 * rules through computed style. Reading the source file is the only
 * reliable way to assert "this CSS rule still exists" in CI.
 */

describe('styles.css regression contracts', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

  it('.chat-view-preview must NOT be a scroll container', () => {
    // User reported: card chat history flickers / oscillates infinitely
    // near the bottom at certain heights — only resolves after manual
    // scroll. Root cause: BOTH `.subcard-preview` (outer) and `.chat-view`
    // (inner, default `overflow-y: auto`) were independent scroll
    // containers. ChatView's preview-mode auto-follow wrote scrollTop on
    // the inner, while SubSessionCard.forceFollowLatest wrote scrollTop on
    // the outer. Near the bottom each layout shift desynchronized the two
    // and they fought infinitely.
    //
    // Fix: `.chat-view-preview` (the class added when ChatView is in
    // preview mode, used by SubSessionCard) must use `overflow: visible`
    // so the outer `.subcard-preview` is the only scroll surface. This
    // test pins the contract.
    const previewRule = css.match(/\.chat-view-preview\s*\{[^}]*\}/);
    expect(previewRule).not.toBeNull();
    expect(previewRule![0]).toMatch(/overflow-y:\s*visible/);
    // Defensive: also reject any `overflow-y: auto/scroll` slipping in.
    expect(previewRule![0]).not.toMatch(/overflow-y:\s*(auto|scroll)/);
  });

  it('.subcard-preview must remain the (only) scroll container for sub-session cards', () => {
    const subcardRule = css.match(/\.subcard-preview\s*\{[^}]*\}/);
    expect(subcardRule).not.toBeNull();
    expect(subcardRule![0]).toMatch(/overflow-y:\s*auto/);
  });

  it('sub-session accents stay on card/button top borders and window full borders', () => {
    const cardRule = css.match(/\.subcard\s*\{[^}]*\}/);
    expect(cardRule).not.toBeNull();
    expect(cardRule![0]).toMatch(/border-top:\s*3px solid var\(--subsession-accent-color/);

    const collapsedButtonRule = css.match(/\.subsession-card\s*\{[^}]*\}/);
    expect(collapsedButtonRule).not.toBeNull();
    expect(collapsedButtonRule![0]).toMatch(/border-top:\s*3px solid var\(--subsession-accent-color/);

    const windowRule = css.match(/\.subsession-window\s*\{[^}]*\}/);
    expect(windowRule).not.toBeNull();
    expect(windowRule![0]).toMatch(/border:\s*1px solid var\(--subsession-accent-color/);

    const maximizedWindowRule = css.match(/\.subsession-window-maximized\s*\{[^}]*\}/);
    expect(maximizedWindowRule).not.toBeNull();
    expect(maximizedWindowRule![0]).toMatch(/border:\s*2px solid var\(--subsession-accent-color/);
  });

  it('active brain session tab keeps a thicker purple bottom border', () => {
    const activeBrainRule = css.match(/\.tab\.brain\.active\s*\{[^}]*\}/);
    expect(activeBrainRule).not.toBeNull();
    expect(activeBrainRule![0]).toMatch(/border-top-color:\s*transparent/);
    expect(activeBrainRule![0]).toMatch(/border-bottom-color:\s*#8b5cf6/);
    expect(activeBrainRule![0]).toMatch(/border-bottom-width:\s*4px/);
  });

  it('.fb-changes-section must NOT cap height — list must scroll past 10 items', () => {
    // User reported: file browser changes list silently hides items
    // beyond ~10 even though the DOM has them. Root cause:
    // `.fb-changes-section` carried a `max-height: 25%` from the old
    // layout where it sat alongside the file tree inside
    // `.fb-files-and-changes`. After commit 6c3c1169 removed that
    // embedded use, the section is always the sole content of its
    // container — but the cap remained, clipping the list to 25% of
    // the pane height (~150–200 px = ~10 items). Because the section
    // itself is `overflow: hidden`, items past the cap aren't even
    // scrollable — they're just hidden.
    //
    // Fix: drop `max-height` from the base rule so the section fills
    // its container and `.fb-changes-list { overflow-y: auto }` does
    // the actual clipping/scrolling.
    const sectionRule = css.match(/\.fb-changes-section\s*\{[^}]*\}/);
    expect(sectionRule).not.toBeNull();
    expect(sectionRule![0]).not.toMatch(/max-height\s*:/);
    // The list itself MUST stay a scroll container so overflow goes
    // through native scrolling instead of being silently clipped.
    const listRule = css.match(/\.fb-changes-list\s*\{[^}]*\}/);
    expect(listRule).not.toBeNull();
    expect(listRule![0]).toMatch(/overflow-y:\s*auto/);
  });
});
