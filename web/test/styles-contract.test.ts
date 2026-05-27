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

  it('ctx live-status robot avatar stays legible in the compact footer', () => {
    const robotRule = css.match(/\.session-live-status-robot-avatar\s*\{[^}]*\}/);
    expect(robotRule).not.toBeNull();
    expect(robotRule![0]).toMatch(/width:\s*18px/);
    expect(robotRule![0]).toMatch(/height:\s*18px/);
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

  it('mobile Team/P2P dropdown is portaled and clamped to the visual viewport', () => {
    const sessionControls = readFileSync(resolve(__dirname, '../src/components/SessionControls.tsx'), 'utf8');
    const helper = sessionControls.match(/const renderP2pDropdown = useCallback\([\s\S]*?\}, \[isOpenSpecMobile\]\);/);
    expect(helper?.[0]).toContain('createPortal');
    expect(helper?.[0]).toContain('document.body');
    expect(sessionControls).toMatch(/p2pDropdownRef\.current\?\.contains/);

    const mobileP2pRule = css.match(/\.menu-dropdown-p2p\s*\{[^}]*position:\s*fixed[^}]*\}/);
    expect(mobileP2pRule).not.toBeNull();
    expect(mobileP2pRule![0]).toMatch(/z-index:\s*2147483646/);
    expect(mobileP2pRule![0]).toMatch(/max-height:\s*min\(72vh,\s*calc\(var\(--vvh,\s*100dvh\)/);
    expect(mobileP2pRule![0]).toMatch(/overflow-y:\s*auto/);
  });

  it('context meters keep the segmented static tech styling', () => {
    const meterRule = css.match(/\.session-ctx-bar,\s*[\s\S]*?\.subsession-card-ctx\s*\{[^}]*\}/);
    expect(meterRule).not.toBeNull();
    expect(meterRule![0]).toMatch(/repeating-linear-gradient\(90deg/);
    expect(meterRule![0]).toMatch(/isolation:\s*isolate/);
    expect(meterRule![0]).toMatch(/rgba\(34,\s*211,\s*238,\s*0\.16\)/);

    const fillRule = css.match(/\.session-ctx-input,\s*[\s\S]*?\.subsession-card-ctx-fill\s*\{[^}]*\}/);
    expect(fillRule).not.toBeNull();
    expect(fillRule![0]).toMatch(/repeating-linear-gradient\(135deg/);
    expect(fillRule![0]).toMatch(/transition:\s*width\s+0\.32s/);
    expect(fillRule![0]).toMatch(/left\s+0\.32s/);
    expect(fillRule![0]).not.toMatch(/animation\s*:/);

    const cacheRule = css.match(/\.session-ctx-cache,\s*[\s\S]*?\.subcard-ctx-cache\s*\{[^}]*\}/);
    expect(cacheRule).not.toBeNull();
    expect(cacheRule![0]).toMatch(/#c084fc/);
    expect(cacheRule![0]).toMatch(/#a855f7/);
    expect(cacheRule![0]).toMatch(/rgba\(168,\s*85,\s*247,\s*0\.56\)/);
    expect(cacheRule![0]).toMatch(/transition:\s*width\s+0\.32s/);

    expect(css).toMatch(/\.session-usage-footer \.session-ctx-bar\.is-burning/);
    expect(css).toMatch(/\.session-ctx-burn\s*\{[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.session-ctx-burn::after\s*\{[\s\S]*?animation:\s*ctx-burn-sparks\s+0\.78s/);
  });

  it('transport stop shortcut stays left while meta header controls stay right', () => {
    const transportShortcutRule = css.match(/\.shortcuts-transport\s*\{[^}]*\}/);
    expect(transportShortcutRule).not.toBeNull();
    expect(transportShortcutRule![0]).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(transportShortcutRule![0]).toMatch(/margin-left:\s*0/);

    const mobileTransportShortcutRule = Array.from(css.matchAll(/\.shortcuts-transport\s*\{[^}]*\}/g))
      .map((match) => match[0])
      .find((rule) => /max-width:\s*none/.test(rule));
    expect(mobileTransportShortcutRule).not.toBeNull();
    expect(mobileTransportShortcutRule!).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(mobileTransportShortcutRule!).toMatch(/max-width:\s*none/);
  });

  it('daemon stats strip keeps the compact tech styling and animated clock digits', () => {
    const statsRule = css.match(/\.daemon-stats-inline-tech\s*\{[^}]*\}/);
    expect(statsRule).not.toBeNull();
    expect(statsRule![0]).toMatch(/repeating-linear-gradient\(90deg/);
    expect(statsRule![0]).toMatch(/border-radius:\s*999px/);

    const clockRule = css.match(/\.daemon-local-clock\s*\{[^}]*\}/);
    expect(clockRule).not.toBeNull();
    expect(clockRule![0]).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(clockRule![0]).toMatch(/display:\s*inline-flex/);
    expect(clockRule![0]).toMatch(/gap:\s*0/);

    const dateTimeGroupRule = css.match(/\.daemon-local-clock-date,\s*[\s\S]*?\.daemon-local-clock-time\s*\{[^}]*\}/);
    expect(dateTimeGroupRule).not.toBeNull();
    expect(dateTimeGroupRule![0]).toMatch(/display:\s*inline-flex/);
    expect(dateTimeGroupRule![0]).toMatch(/align-items:\s*baseline/);

    const spaceRule = css.match(/\.daemon-local-clock-space\s*\{[^}]*\}/);
    expect(spaceRule).not.toBeNull();
    expect(spaceRule![0]).toMatch(/white-space:\s*pre/);

    const digitRule = css.match(/\.daemon-local-clock-digit\s*\{[^}]*\}/);
    expect(digitRule).not.toBeNull();
    expect(digitRule![0]).toMatch(/animation:\s*daemon-clock-tick\s+0\.28s/);
    expect(css).toMatch(/@keyframes daemon-clock-tick/);
  });

  it('sub-session close-all control stays a narrow strip at the left of the row', () => {
    const rowRule = css.match(/\.subsession-row-with-close\s*\{[^}]*\}/);
    expect(rowRule).not.toBeNull();
    expect(rowRule![0]).toMatch(/display:\s*flex/);
    expect(rowRule![0]).toMatch(/align-items:\s*stretch/);

    const childRule = css.match(/\.subsession-row-with-close \.subsession-bar,\s*[\s\S]*?\.subsession-row-with-close \.subcard-scroll\s*\{[^}]*\}/);
    expect(childRule).not.toBeNull();
    expect(childRule![0]).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(childRule![0]).toMatch(/min-width:\s*0/);

    const stripRule = css.match(/\.subsession-close-all-strip\s*\{[^}]*\}/);
    expect(stripRule).not.toBeNull();
    expect(stripRule![0]).toMatch(/flex:\s*0\s+0\s+18px/);
    expect(stripRule![0]).toMatch(/width:\s*18px/);
    expect(stripRule![0]).toMatch(/border-radius:\s*8px/);
  });

  it('server rail buttons stay rounded rectangles and do not clip status dots', () => {
    const serverIconRule = css.match(/\.server-icon\s*\{[^}]*\}/);
    expect(serverIconRule).not.toBeNull();
    expect(serverIconRule![0]).toMatch(/width:\s*38px/);
    expect(serverIconRule![0]).toMatch(/height:\s*34px/);
    expect(serverIconRule![0]).toMatch(/border-radius:\s*11px/);
    expect(serverIconRule![0]).toMatch(/overflow:\s*visible/);
    expect(serverIconRule![0]).not.toMatch(/border-radius:\s*50%/);
    expect(serverIconRule![0]).not.toMatch(/overflow:\s*hidden/);

    const dotRule = css.match(/\.server-icon-dot\s*\{[^}]*\}/);
    expect(dotRule).not.toBeNull();
    expect(dotRule![0]).toMatch(/bottom:\s*3px/);
    expect(dotRule![0]).toMatch(/right:\s*3px/);
    expect(dotRule![0]).toMatch(/z-index:\s*1/);
  });

  it('mobile OpenSpec dropdown is a body-level viewport sheet, not an inline clipped menu', () => {
    const sessionControls = readFileSync(resolve(__dirname, '../src/components/SessionControls.tsx'), 'utf8');
    const helper = sessionControls.match(/const renderOpenSpecDropdown = useCallback\([\s\S]*?\}, \[clearOpenSpecRequestTimer, isOpenSpecMobile, openSpecDropdownStyle, t\]\);/);
    expect(helper?.[0]).toContain('createPortal');
    expect(helper?.[0]).toContain('document.body');
    expect(helper?.[0]).toContain('menu-dropdown-openspec-inline');

    const inlineRules = [...css.matchAll(/\.menu-dropdown-openspec-inline\s*\{[^}]*\}/g)].map((match) => match[0]);
    const mobileRule = inlineRules.find((rule) => /position:\s*fixed/.test(rule));
    expect(mobileRule).toBeTruthy();
    expect(mobileRule!).toMatch(/top:\s*var\(--sat,\s*0px\)/);
    expect(mobileRule!).toMatch(/height:\s*calc\(var\(--vvh,\s*100dvh\)/);
    expect(mobileRule!).toMatch(/overflow:\s*hidden/);
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

  it('fullscreen HTML preview must be clamped to the browser viewport', () => {
    const overlayRule = css.match(/\.html-fullscreen-preview\s*\{[^}]*\}/);
    expect(overlayRule).not.toBeNull();
    expect(overlayRule![0]).toMatch(/width:\s*100vw/);
    expect(overlayRule![0]).toMatch(/max-width:\s*100vw/);
    expect(overlayRule![0]).toMatch(/overflow:\s*hidden/);

    const bodyRule = css.match(/\.html-fullscreen-preview-body\s*\{[^}]*\}/);
    expect(bodyRule).not.toBeNull();
    expect(bodyRule![0]).toMatch(/max-width:\s*100vw/);
    expect(bodyRule![0]).toMatch(/min-width:\s*0/);

    const iframeRule = css.match(/\.html-safe-preview-frame\s*\{[^}]*\}/);
    expect(iframeRule).not.toBeNull();
    expect(iframeRule![0]).toMatch(/max-width:\s*100%/);
    expect(iframeRule![0]).toMatch(/min-width:\s*0/);
  });

  it('shared image lightbox keeps the close button out of mobile safe areas', () => {
    const overlayRule = css.match(/\.fb-lightbox\s*\{[^}]*\}/);
    expect(overlayRule).not.toBeNull();
    expect(overlayRule![0]).toMatch(/padding:\s*calc\(var\(--sat,\s*0px\) \+ 12px\)/);
    expect(overlayRule![0]).toMatch(/env\(safe-area-inset-bottom,\s*0px\)/);

    const closeRule = css.match(/\.fb-lightbox-close\s*\{[^}]*\}/);
    expect(closeRule).not.toBeNull();
    expect(closeRule![0]).toMatch(/top:\s*calc\(var\(--sat,\s*0px\) \+ 16px\)/);
    expect(closeRule![0]).toMatch(/right:\s*calc\(env\(safe-area-inset-right,\s*0px\) \+ 16px\)/);
  });

  it('mobile server switcher remains a roomy primary control', () => {
    const barRule = Array.from(css.matchAll(/\.mobile-server-bar\s*\{[^}]*\}/g))
      .map((match) => match[0])
      .find((rule) => /gap:\s*8px/.test(rule));
    expect(barRule).not.toBeNull();
    expect(barRule!).toMatch(/gap:\s*8px/);

    const wrapRule = css.match(/\.mobile-server-switcher-wrap\s*\{[^}]*\}/);
    expect(wrapRule).not.toBeNull();
    expect(wrapRule![0]).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(wrapRule![0]).toMatch(/min-width:\s*0/);

    const buttonRule = css.match(/\.mobile-server-btn\s*\{[^}]*\}/);
    expect(buttonRule).not.toBeNull();
    expect(buttonRule![0]).toMatch(/width:\s*100%/);
    expect(buttonRule![0]).toMatch(/min-height:\s*38px/);
    expect(buttonRule![0]).toMatch(/border-radius:\s*13px/);

    const nameRule = css.match(/\.mobile-server-btn-name\s*\{[^}]*\}/);
    expect(nameRule).not.toBeNull();
    expect(nameRule![0]).toMatch(/text-overflow:\s*ellipsis/);
    expect(nameRule![0]).toMatch(/white-space:\s*nowrap/);
  });

  it('Shared Context management keeps the sci-fi chrome styling hooks', () => {
    const app = readFileSync(resolve(__dirname, '../src/app.tsx'), 'utf8');
    expect(app).toContain('className="shared-context-floating-panel"');

    const floatingPanel = readFileSync(resolve(__dirname, '../src/components/FloatingPanel.tsx'), 'utf8');
    expect(floatingPanel).toContain('className?: string');
    expect(floatingPanel).toContain('floating-panel-titlebar');
    expect(floatingPanel).toContain('floating-panel-content');

    const panel = readFileSync(resolve(__dirname, '../src/components/SharedContextManagementPanel.tsx'), 'utf8');
    expect(panel).toContain('shared-context-shell-tech');
    expect(panel).toContain('shared-context-hero-tech');
    expect(panel).toContain('shared-context-tabbar-tech');
    expect(panel).toContain('shared-context-tab-tech');
    expect(panel).toContain('repeating-linear-gradient(90deg');

    const floatRule = css.match(/\.shared-context-floating-panel\s*\{[^}]*\}/);
    expect(floatRule).not.toBeNull();
    expect(floatRule![0]).toMatch(/linear-gradient\(180deg,\s*#08111d/);
    expect(floatRule![0]).toMatch(/rgba\(34,\s*211,\s*238,\s*0\.24\)/);

    const focusRule = css.match(/\.shared-context-shell-tech input:focus,\s*[\s\S]*?\.shared-context-shell-tech textarea:focus\s*\{[^}]*\}/);
    expect(focusRule).not.toBeNull();
    expect(focusRule![0]).toMatch(/rgba\(34,\s*211,\s*238,\s*0\.70\)/);

    const tabHoverRule = css.match(/\.shared-context-tab-tech:hover\s*\{[^}]*\}/);
    expect(tabHoverRule).not.toBeNull();
    expect(tabHoverRule![0]).toMatch(/rgba\(8,\s*145,\s*178,\s*0\.16\)/);
  });

  it('session creation dialogs cannot exceed narrow mobile viewports', () => {
    const dialogRule = css.match(/\.dialog\s*\{[^}]*\}/);
    expect(dialogRule).not.toBeNull();
    expect(dialogRule![0]).toMatch(/max-width:\s*calc\(100vw - env\(safe-area-inset-left/);
    expect(dialogRule![0]).toMatch(/min-width:\s*0/);
    expect(dialogRule![0]).toMatch(/box-sizing:\s*border-box/);

    const newSessionDialog = readFileSync(resolve(__dirname, '../src/components/NewSessionDialog.tsx'), 'utf8');
    const subSessionDialog = readFileSync(resolve(__dirname, '../src/components/StartSubSessionDialog.tsx'), 'utf8');
    for (const source of [newSessionDialog, subSessionDialog]) {
      expect(source).toContain('responsiveDialogStyle');
      expect(source).toContain('calc(100vw - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px) - 32px)');
      expect(source).toContain('boxSizing');
      expect(source).toContain('overflowWrap');
      expect(source).not.toContain('style={{ width: "100%", maxWidth: 380 }}');
      expect(source).not.toContain("style={{ width: '100%', maxWidth: 380 }}");
    }
  });

  it('custom-provider checkbox cannot be stretched to 100% by .form-group input', () => {
    // Regression: the global rule `.form-group input { width: 100% }`
    // stretched the custom-provider <input type="checkbox"> to the full
    // label width inside its `display:flex` parent, pushing the span text
    // past the dialog's right edge. The span then inherited the dialog's
    // `overflow-wrap: anywhere` and the "Custom provider SDK" label
    // rendered as a one-character-per-line vertical strip outside the
    // dialog. Both dialogs MUST explicitly size the checkbox so the rule
    // can't clobber it.
    const formGroupInputRule = css.match(/\.form-group input\s*\{[^}]*\}/);
    expect(formGroupInputRule).not.toBeNull();
    expect(formGroupInputRule![0]).toMatch(/width:\s*100%/);

    const newSessionDialog = readFileSync(resolve(__dirname, '../src/components/NewSessionDialog.tsx'), 'utf8');
    const subSessionDialog = readFileSync(resolve(__dirname, '../src/components/StartSubSessionDialog.tsx'), 'utf8');
    for (const source of [newSessionDialog, subSessionDialog]) {
      // Inline width:auto on the checkbox is the override that beats the
      // global rule's specificity.
      expect(source).toMatch(/type=['"]checkbox['"][\s\S]{0,600}?width:\s*['"]auto['"]/);
    }
  });
});
