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
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

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

  it('P2P dropdown rounds selector uses a blue background with green borders', () => {
    const selectorRule = css.match(/\.menu-dropdown-p2p \.p2p-dropdown-rounds\s*\{[^}]*\}/);
    expect(selectorRule).not.toBeNull();
    expect(selectorRule![0]).toMatch(/background:\s*linear-gradient\([^;]*rgba\(29,\s*78,\s*216/);
    expect(selectorRule![0]).toMatch(/border:\s*1px solid #22c55e/);

    const roundButtonRule = css.match(/\.p2p-dropdown-round\s*\{[^}]*\}/);
    expect(roundButtonRule).not.toBeNull();
    expect(roundButtonRule![0]).toMatch(/background:\s*rgba\(30,\s*64,\s*175/);
    expect(roundButtonRule![0]).toMatch(/border:\s*1px solid rgba\(34,\s*197,\s*94/);
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

  it('file browser split tree sizing must only target direct children', () => {
    // User reported: opening a file preview made the `.fb-files-and-changes`
    // area use less than half of its height. Root cause: the old descendant
    // selector `.fb-body-split .fb-tree { flex: 0 0 38%; }` hit the tree
    // nested inside `.fb-files-and-changes` (a column flex container), turning
    // a row-width rule into a column-height cap. Split sizing must only apply
    // to `.fb-tree` nodes that are direct children of `.fb-body-split`.
    const descendantSplitTreeRules = [...cssWithoutComments.matchAll(/\.fb-body-split\s+\.fb-tree[^{]*\{/g)];
    expect(descendantSplitTreeRules.map((match) => match[0])).toEqual([]);

    const directSplitTreeRules = [...cssWithoutComments.matchAll(/\.fb-body-split\s*>\s*\.fb-tree[^{]*\{/g)];
    expect(directSplitTreeRules.length).toBeGreaterThanOrEqual(2);
  });

  it('file browser panel wrapper owns split width while its inner tree fills height', () => {
    const wrapperRules = [...css.matchAll(/\.fb-files-and-changes\.fb-tree-split\s*\{[^}]*\}/g)].map((match) => match[0]);
    const wrapperRule = wrapperRules.find((rule) => /flex\s*:/.test(rule));
    expect(wrapperRule).toBeTruthy();
    expect(wrapperRule!).toMatch(/flex\s*:\s*0\s+0\s+38%/);

    const innerTreeRule = css.match(/\.fb-files-and-changes\s+\.fb-tree\s*\{[^}]*\}/);
    expect(innerTreeRule).not.toBeNull();
    const flexGrow = innerTreeRule![0].match(/flex\s*:\s*(\d+)/);
    expect(flexGrow).not.toBeNull();
    expect(Number(flexGrow![1])).toBeGreaterThanOrEqual(1);
    expect(innerTreeRule![0]).toMatch(/overflow-y:\s*auto/);
    expect(innerTreeRule![0]).toMatch(/min-height:\s*0/);
  });
});
