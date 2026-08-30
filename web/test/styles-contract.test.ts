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

  it('keeps the desktop rail exactly one bottom card wide and its vertical cards compact and scrollable', () => {
    const rootRule = cssWithoutComments.match(/:root\s*\{[^}]*\}/)?.[0];
    expect(rootRule).toMatch(/--subsession-compact-card-width:\s*54px/);

    const bottomCardRule = cssWithoutComments.match(/\.subsession-card\s*\{[^}]*\}/)?.[0];
    expect(bottomCardRule).toMatch(/width:\s*var\(--subsession-compact-card-width\)/);
    expect(bottomCardRule).toMatch(/min-width:\s*var\(--subsession-compact-card-width\)/);

    const hostRule = cssWithoutComments.match(/\.subsession-vertical-rail-host\s*\{[^}]*\}/)?.[0];
    expect(hostRule).toBeTruthy();
    expect(hostRule).toMatch(/display:\s*flex/);
    expect(hostRule).toMatch(/flex:\s*0\s+0\s+var\(--subsession-compact-card-width\)/);
    for (const property of ['width', 'min-width', 'max-width']) {
      expect(hostRule).toMatch(new RegExp(`${property}:\\s*var\\(--subsession-compact-card-width\\)`));
    }
    expect(hostRule).not.toMatch(/position:\s*(fixed|absolute)/);

    const leftRule = cssWithoutComments.match(/\.subsession-vertical-rail-host-left\s*\{[^}]*\}/)?.[0];
    const rightRule = cssWithoutComments.match(/\.subsession-vertical-rail-host-right\s*\{[^}]*\}/)?.[0];
    expect(leftRule).toMatch(/border-right:/);
    expect(rightRule).toMatch(/border-left:/);
    expect(leftRule).not.toMatch(/position:\s*(fixed|absolute)/);
    expect(rightRule).not.toMatch(/position:\s*(fixed|absolute)/);

    const scrollRule = cssWithoutComments.match(/\.subsession-vertical-rail-scroll\s*\{[^}]*\}/)?.[0];
    expect(scrollRule).toBeTruthy();
    expect(scrollRule).toMatch(/overflow-y:\s*auto/);
    expect(scrollRule).toMatch(/overflow-x:\s*hidden/);
    expect(scrollRule).toMatch(/flex-direction:\s*column/);
    expect(scrollRule).toMatch(/gap:\s*4px/);
    expect(scrollRule).toMatch(/padding:\s*5px\s+2px\s+8px/);

    const railCardRule = cssWithoutComments.match(/\.subsession-card-rail\s*\{[^}]*\}/)?.[0];
    expect(railCardRule).toMatch(/min-height:\s*48px/);
    expect(railCardRule).toMatch(/flex-direction:\s*column/);
    expect(railCardRule).toMatch(/gap:\s*1px/);
    expect(railCardRule).toMatch(/padding:\s*4px\s+1px\s+5px/);

    const mobileBottomCardRule = cssWithoutComments.match(
      /@media\s*\(max-width:\s*640px\)\s*\{\s*\.subsession-card:not\(\.subsession-card-rail\)\s*\{[^}]*\}/,
    )?.[0];
    expect(mobileBottomCardRule).toMatch(/min-height:\s*50px/);
    expect(mobileBottomCardRule).toMatch(/gap:\s*1px/);
    expect(mobileBottomCardRule).toMatch(/padding:\s*3px\s+1px/);

    expect(cssWithoutComments).not.toMatch(/\.subsession-vertical-rail-host\s*\{[^}]*(?:136px|148px)/);
  });

  it('shows the fast-audit label on desktop and keeps the mobile control icon-only', () => {
    const desktopRule = css.match(/\.shortcut-btn-peer-audit-label\s*\{[^}]*\}/)?.[0];
    expect(desktopRule).toBeTruthy();
    expect(desktopRule).not.toMatch(/display:\s*none/);

    const mobileRule = css.match(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.shortcut-btn-peer-audit-label\s*\{[^}]*\}/)?.[0];
    expect(mobileRule).toBeTruthy();
    expect(mobileRule).toMatch(/display:\s*none/);
  });

  it('keeps remote desktop file window controls compact and horizontal', () => {
    const actionsRule = css.match(/\.remote-desktop-file-drawer \.remote-desktop-file-drawer-actions\s*\{[^}]*\}/)?.[0];
    expect(actionsRule).toMatch(/display:\s*flex/);
    const controlRule = css.match(/\.remote-desktop-file-drawer \.remote-desktop-file-control\s*\{[^}]*\}/)?.[0];
    expect(controlRule).toMatch(/width:\s*30px/);
    expect(controlRule).toMatch(/height:\s*30px/);
    expect(controlRule).toMatch(/border-radius:\s*999px/);
  });

  it('keeps the mobile remote desktop file manager viewport-bound and in document flow', () => {
    const mobileStart = css.indexOf('@media (max-width: 720px)');
    const mobileEnd = css.indexOf('@media (max-height: 520px)', mobileStart);
    const mobileBlock = mobileStart >= 0 && mobileEnd > mobileStart
      ? css.slice(mobileStart, mobileEnd)
      : '';
    expect(mobileBlock).toBeTruthy();
    const drawerRule = mobileBlock.match(/\.remote-desktop-file-drawer\s*\{[^}]*\}/)?.[0];
    expect(drawerRule).toMatch(/position:\s*fixed/);
    expect(drawerRule).toMatch(/width:\s*calc\(100dvw - 16px\)/);
    expect(drawerRule).toMatch(/display:\s*block/);
    const explorerRule = mobileBlock.match(/\.remote-desktop-file-explorer\s*\{[^}]*\}/)?.[0];
    expect(explorerRule).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    const queueRule = mobileBlock.match(/\.remote-desktop-transfer-queue\s*\{[^}]*\}/)?.[0];
    expect(queueRule).toMatch(/margin-top:\s*11px/);
  });

  it('keeps the remote desktop clipboard actions compact', () => {
    const rule = css.match(/\.remote-desktop-toolbar \.remote-desktop-clipboard-switch button\s*\{[^}]*\}/)?.[0];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/min-height:\s*30px/);
    expect(rule).toMatch(/padding:\s*4px 9px/);
    expect(rule).toMatch(/font-size:\s*11\.5px/);
  });

  it('keeps feature announcements visible and dismissible on desktop and mobile', () => {
    const announcementRule = css.match(/\.feature-announcement\s*\{[^}]*\}/)?.[0];
    expect(announcementRule).toBeTruthy();
    expect(announcementRule).toMatch(/position:\s*fixed/);
    expect(announcementRule).toMatch(/z-index:\s*10004/);
    expect(announcementRule).not.toMatch(/display:\s*none/);

    const dismissRule = css.match(/\.feature-announcement-dismiss\s*\{[^}]*\}/)?.[0];
    expect(dismissRule).toBeTruthy();
    expect(dismissRule).toMatch(/cursor:\s*pointer/);
  });

  it('keeps pinned messages as a compact titlebar counter with an overlay list', () => {
    const barRule = css.match(/\.message-pins-bar\s*\{[^}]*\}/)?.[0];
    expect(barRule).toBeTruthy();
    expect(barRule).toMatch(/display:\s*inline-flex/);
    expect(barRule).not.toMatch(/margin:/);

    const triggerRule = css.match(/\.message-pins-summary\s*\{[^}]*\}/)?.[0];
    expect(triggerRule).toBeTruthy();
    expect(triggerRule).toMatch(/height:\s*24px/);
    expect(triggerRule).toMatch(/width:\s*auto/);

    const panelRule = css.match(/\.message-pins-panel\s*\{[^}]*\}/)?.[0];
    expect(panelRule).toBeTruthy();
    expect(panelRule).toMatch(/position:\s*absolute/);
  });

  it('uses half the desktop viewport and full mobile width for pinned-message previews', () => {
    const previewRule = css.match(/\.zoom-text-dialog-message-preview\s*\{[^}]*\}/)?.[0];
    expect(previewRule).toBeTruthy();
    expect(previewRule).toMatch(/width:\s*min\(50vw,\s*calc\(100vw - 24px\)\)/);

    const mobileRule = css.match(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.zoom-text-dialog-message-preview\s*\{[^}]*\}/)?.[0];
    expect(mobileRule).toBeTruthy();
    expect(mobileRule).toMatch(/width:\s*calc\(100vw - 16px\)/);

    const mobileActionsRule = css.match(/@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.zoom-text-dialog-message-preview \.zoom-text-actions\s*\{[^}]*\}/)?.[0];
    expect(mobileActionsRule).toBeTruthy();
    expect(mobileActionsRule).toMatch(/flex-direction:\s*row/);
    expect(mobileActionsRule).toMatch(/flex-wrap:\s*nowrap/);

    const mobileButtonRule = css.match(/@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.zoom-text-dialog-message-preview \.zoom-text-btn\s*\{[^}]*\}/)?.[0];
    expect(mobileButtonRule).toBeTruthy();
    expect(mobileButtonRule).toMatch(/flex:\s*1\s+1\s+0/);
    expect(mobileButtonRule).toMatch(/width:\s*auto/);
  });

  it('keeps delegation replies readable by scrolling after ten lines instead of clipping text', () => {
    const cardRule = cssWithoutComments.match(/\.delegation-reply-card\s*\{[^}]*\}/)?.[0];
    expect(cardRule).toBeTruthy();
    expect(cardRule).toMatch(/flex:\s*0\s+0\s+auto/);

    const bodyRule = cssWithoutComments.match(/\.delegation-reply-card-body\s*\{[^}]*\}/)?.[0];
    expect(bodyRule).toBeTruthy();
    expect(bodyRule).toMatch(/font-size:\s*12px/);
    expect(bodyRule).toMatch(/line-height:\s*1\.5/);
    expect(bodyRule).toMatch(/max-height:\s*calc\(1\.5em \* 10\)/);
    expect(bodyRule).toMatch(/overflow-y:\s*auto/);
    expect(bodyRule).not.toMatch(/overscroll-behavior/);
  });

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

  it('keeps collapsed tool hover peeks above sub-session windows without covering modal overlays', () => {
    const rule = cssWithoutComments.match(/\.chat-tool-peek\s*\{[^}]*\}/)?.[0];
    expect(rule).toBeTruthy();
    const zIndex = Number(rule?.match(/z-index:\s*(\d+)/)?.[1]);
    expect(zIndex).toBeGreaterThan(7000);
    expect(zIndex).toBeLessThan(10050);
  });

  it('keeps the expanded tool fold header visible while its details scroll', () => {
    const foldRule = css.match(/\.chat-tool-block-fold\s*\{[^}]*\}/);
    expect(foldRule).not.toBeNull();
    expect(foldRule![0]).toMatch(/width:\s*100%/);
    expect(foldRule![0]).not.toMatch(/900px/);

    const expandedHeaderRule = css.match(/\.chat-tool-block-fold\.is-expanded \.chat-tool-fold-header\s*\{[^}]*\}/);
    expect(expandedHeaderRule).not.toBeNull();
    expect(expandedHeaderRule![0]).toMatch(/position:\s*sticky/);
    expect(expandedHeaderRule![0]).toMatch(/top:\s*0/);
    expect(expandedHeaderRule![0]).toMatch(/z-index:\s*3/);
    expect(expandedHeaderRule![0]).not.toMatch(/white-space:\s*nowrap/);

    const continuationRule = css.match(/\.chat-tool-fold-continuation\s*\{[^}]*\}/);
    expect(continuationRule).not.toBeNull();
    expect(continuationRule![0]).toMatch(/white-space:\s*pre-wrap/);
    expect(continuationRule![0]).toMatch(/word-break:\s*break-word/);

    const collapsedContinuationRule = css.match(/\.chat-tool-block-fold\.is-collapsed \.chat-tool-fold-continuation\s*\{[^}]*\}/);
    expect(collapsedContinuationRule).not.toBeNull();
    expect(collapsedContinuationRule![0]).toMatch(/display:\s*none/);
  });

  it('keeps collapsed tool rows horizontally scrollable without a visible scrollbar', () => {
    const collapsedRowsRule = css.match(
      /\.chat-tool-block-fold\.is-collapsed \.chat-tool-command-row,\s*\.chat-tool-block-fold\.is-collapsed \.chat-tool-result-row,\s*\.chat-tool-block-fold\.is-collapsed \.chat-tool-result-preview\s*\{[^}]*\}/,
    );
    expect(collapsedRowsRule).not.toBeNull();
    expect(collapsedRowsRule![0]).toMatch(/overflow-x:\s*auto/);
    expect(collapsedRowsRule![0]).toMatch(/scrollbar-width:\s*none/);

    const webkitScrollbarRule = css.match(
      /\.chat-tool-block-fold\.is-collapsed \.chat-tool-command-row::\-webkit-scrollbar,\s*\.chat-tool-block-fold\.is-collapsed \.chat-tool-result-row::\-webkit-scrollbar,\s*\.chat-tool-block-fold\.is-collapsed \.chat-tool-result-preview::\-webkit-scrollbar\s*\{[^}]*\}/,
    );
    expect(webkitScrollbarRule).not.toBeNull();
    expect(webkitScrollbarRule![0]).toMatch(/display:\s*none/);
    expect(webkitScrollbarRule![0]).toMatch(/height:\s*0/);
  });

  it('keeps the desktop composer target compact in the Stop toolbar and truncates long session names', () => {
    const bubbleRule = css.match(/\.controls-target-bubble\s*\{[^}]*\}/);
    expect(bubbleRule).not.toBeNull();
    expect(bubbleRule![0]).toMatch(/position:\s*relative/);
    expect(bubbleRule![0]).toMatch(/height:\s*28px/);
    expect(bubbleRule![0]).toMatch(/box-sizing:\s*border-box/);
    expect(bubbleRule![0]).not.toMatch(/bottom:/);
    expect(bubbleRule![0]).toMatch(/overflow:\s*hidden/);

    const nameRule = css.match(/\.controls-target-name\s*\{[^}]*\}/);
    expect(nameRule).not.toBeNull();
    expect(nameRule![0]).toMatch(/min-width:\s*0/);
    expect(nameRule![0]).toMatch(/text-overflow:\s*ellipsis/);
    expect(nameRule![0]).toMatch(/white-space:\s*nowrap/);
  });

  it('joins consecutive assistant text cards without blue separator lines', () => {
    const assistantRule = css.match(/\.chat-assistant\s*\{[^}]*\}/);
    const precedingRule = css.match(/\.chat-assistant:has\(\+ \.chat-assistant\)\s*\{[^}]*\}/);
    const followingRule = css.match(/\.chat-assistant \+ \.chat-assistant\s*\{[^}]*\}/);

    expect(assistantRule?.[0]).toMatch(/border:\s*0/);
    expect(precedingRule?.[0]).toMatch(/margin-bottom:\s*0/);
    expect(precedingRule?.[0]).toMatch(/border-bottom-left-radius:\s*0/);
    expect(followingRule?.[0]).toMatch(/margin-top:\s*-2px/);
    expect(followingRule?.[0]).toMatch(/border-top-left-radius:\s*0/);
  });

  it('visually distinguishes P2P direct uploads from relay uploads', () => {
    const directBadgeRule = css.match(/\.composer-upload-transport-direct\s*\{[^}]*\}/);
    const relayBadgeRule = css.match(/\.composer-upload-transport-falling_back,\s*\.composer-upload-transport-relay\s*\{[^}]*\}/);
    const directProgressRule = css.match(/\.composer-upload-row-direct \.composer-upload-progress-fill\s*\{[^}]*\}/);
    const relayProgressRule = css.match(/\.composer-upload-row-falling_back \.composer-upload-progress-fill,\s*\.composer-upload-row-relay \.composer-upload-progress-fill\s*\{[^}]*\}/);

    expect(directBadgeRule?.[0]).toMatch(/color:\s*#86efac/);
    expect(relayBadgeRule?.[0]).toMatch(/color:\s*#fcd34d/);
    expect(directProgressRule?.[0]).toMatch(/#4ade80/);
    expect(relayProgressRule?.[0]).toMatch(/#fbbf24/);
  });

  it('keeps long download rows constrained while preserving right-side metadata and actions', () => {
    const rowRule = css.match(/\.download-transfer-row\s*\{[^}]*\}/)?.[0];
    expect(rowRule).toBeTruthy();
    expect(rowRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/);
    expect(rowRule).toMatch(/min-width:\s*0/);
    expect(rowRule).toMatch(/max-width:\s*100%/);

    const headingRule = css.match(/\.download-transfer-row-heading,\s*\.download-transfer-status-line\s*\{[^}]*\}/)?.[0];
    expect(headingRule).toBeTruthy();
    expect(headingRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/);

    const leadingNameRule = css.match(/\.download-transfer-name-leading\s*\{[^}]*\}/)?.[0];
    expect(leadingNameRule).toBeTruthy();
    expect(leadingNameRule).toMatch(/text-overflow:\s*ellipsis/);

    const listRule = css.match(/\.download-transfer-list\s*\{[^}]*\}/)?.[0];
    expect(listRule).toBeTruthy();
    expect(listRule).toMatch(/overflow-x:\s*hidden/);
  });

  it('keeps the remote-desktop right-click helper touch-only', () => {
    const desktopRule = css.match(/\.remote-desktop-touch-right-button\s*\{[^}]*\}/)?.[0];
    expect(desktopRule).toBeTruthy();
    expect(desktopRule).toMatch(/display:\s*none/);

    const coarsePointerRule = css.match(
      /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.remote-desktop-touch-right-button\s*\{[^}]*\}/,
    )?.[0];
    expect(coarsePointerRule).toBeTruthy();
    expect(coarsePointerRule).toMatch(/display:\s*block/);
  });

  it('fits portrait videos by available preview height without stretching them to full width', () => {
    const videoContainerRule = css.match(/\.fb-preview-video\s*\{[^}]*\}/);
    expect(videoContainerRule).not.toBeNull();
    expect(videoContainerRule![0]).toMatch(/height:\s*100%/);
    expect(videoContainerRule![0]).toMatch(/box-sizing:\s*border-box/);

    const videoRule = css.match(/\.fb-preview-video video\s*\{[^}]*\}/);
    expect(videoRule).not.toBeNull();
    expect(videoRule![0]).toMatch(/width:\s*auto/);
    expect(videoRule![0]).toMatch(/height:\s*100%/);
    expect(videoRule![0]).toMatch(/max-width:\s*100%/);
    expect(videoRule![0]).toMatch(/max-height:\s*100%/);
    expect(videoRule![0]).toMatch(/object-fit:\s*contain/);
    expect(videoRule![0]).not.toMatch(/[;{]\s*width:\s*100%/);

    const fileBrowser = readFileSync(resolve(__dirname, '../src/components/FileBrowser.tsx'), 'utf8');
    const videoElement = fileBrowser.match(/<video[\s\S]*?>/);
    expect(videoElement).not.toBeNull();
    expect(videoElement![0]).not.toContain('style=');
  });

  it('stacks the existing Agents panel in narrow sub-session previews', () => {
    const previewSplitRule = css.match(/\.subcard-preview \.chat-view-wrap\.chat-split\s*\{[^}]*\}/);
    expect(previewSplitRule).not.toBeNull();
    expect(previewSplitRule![0]).toMatch(/flex-direction:\s*column\s*!important/);

    const previewAgentsRule = css.match(/\.subcard-preview \.chat-sdk-agents-panel\s*\{[^}]*\}/);
    expect(previewAgentsRule).not.toBeNull();
    expect(previewAgentsRule![0]).toMatch(/width:\s*100%\s*!important/);
    expect(previewAgentsRule![0]).toMatch(/min-width:\s*0/);
    expect(previewAgentsRule![0]).toMatch(/max-height:\s*min\(42%,\s*120px\)/);
    expect(previewAgentsRule![0]).toMatch(/border-top:\s*1px solid #334155/);
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

  it('active brain session tab keeps a 2px purple bottom border (consistent with other active windows)', () => {
    const activeBrainRule = css.match(/\.tab\.brain\.active\s*\{[^}]*\}/);
    expect(activeBrainRule).not.toBeNull();
    expect(activeBrainRule![0]).toMatch(/border-top-color:\s*transparent/);
    expect(activeBrainRule![0]).toMatch(/border-bottom-color:\s*#8b5cf6/);
    expect(activeBrainRule![0]).toMatch(/border-bottom-width:\s*2px/);
  });

  it('ctx live-status robot avatar stays legible without changing the compact footer layout', () => {
    const robotRule = css.match(/\.session-live-status-robot-avatar\s*\{[^}]*\}/);
    expect(robotRule).not.toBeNull();
    expect(robotRule![0]).toMatch(/width:\s*16px/);
    expect(robotRule![0]).toMatch(/height:\s*16px/);

    const scaledRobotRule = css.match(/\.session-live-status-emoji\.robot\.session-live-status-robot-avatar\s*\{[^}]*\}/);
    expect(scaledRobotRule).not.toBeNull();
    expect(scaledRobotRule![0]).toMatch(/scale\(1\.125\)/);
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

  it('active Auto supervision uses an orbiting sci-fi ring with distinct audit colors', () => {
    const activeRule = css.match(/\.shortcut-btn-auto-active::before\s*\{[^}]*\}/);
    expect(activeRule).not.toBeNull();
    expect(activeRule![0]).toMatch(/conic-gradient\(/);
    expect(activeRule![0]).toMatch(/animation:\s*shortcut-btn-auto-orbit/);

    const supervisedRule = css.match(/\.shortcut-btn-auto-supervised\s*\{[^}]*\}/);
    const auditRule = css.match(/\.shortcut-btn-auto-audit\s*\{[^}]*\}/);
    expect(supervisedRule?.[0]).toMatch(/#22d3ee/);
    expect(supervisedRule?.[0]).toMatch(/#34d399/);
    expect(auditRule?.[0]).toMatch(/#c084fc/);
    expect(auditRule?.[0]).toMatch(/#f59e0b/);

    expect(cssWithoutComments).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.shortcut-btn-auto-active::before[\s\S]*?animation:\s*none/);
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

  it('lets the terminal shortcut strip own remaining width and scroll horizontally', () => {
    const shortcutStripRule = css.match(/\.shortcuts\s*\{[^}]*\}/);
    expect(shortcutStripRule).not.toBeNull();
    expect(shortcutStripRule![0]).toMatch(/flex:\s*1/);
    expect(shortcutStripRule![0]).toMatch(/min-width:\s*0/);
    expect(shortcutStripRule![0]).toMatch(/overflow-x:\s*auto/);
    expect(css).toMatch(/\.shortcuts::-webkit-scrollbar\s*\{\s*display:\s*none/);
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
    expect(fillRule![0]).toMatch(/transition:\s*width\s+0\.58s/);
    expect(fillRule![0]).toMatch(/left\s+0\.58s/);
    expect(fillRule![0]).not.toMatch(/animation\s*:/);

    const cacheRule = css.match(/\.session-ctx-cache,\s*[\s\S]*?\.subcard-ctx-cache\s*\{[^}]*\}/);
    expect(cacheRule).not.toBeNull();
    expect(cacheRule![0]).toMatch(/#c084fc/);
    expect(cacheRule![0]).toMatch(/#a855f7/);
    expect(cacheRule![0]).toMatch(/rgba\(168,\s*85,\s*247,\s*0\.56\)/);
    expect(cacheRule![0]).toMatch(/transition:\s*width\s+0\.58s/);

    expect(css).toMatch(/\.session-usage-footer \.session-ctx-bar\.is-burning/);
    expect(css).toMatch(/\.session-ctx-burn\s*\{[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.session-ctx-burn::after\s*\{[\s\S]*?animation:\s*ctx-burn-sparks\s+0\.78s/);
    expect(css).toMatch(/\.session-ctx-burn-edge\s*\{[\s\S]*?animation:\s*ctx-burn-edge\s+1\.2s/);
  });

  it('transport stop shortcut stays left while meta header controls stay right', () => {
    const transportShortcutRule = css.match(/\.shortcuts-transport\s*\{[^}]*\}/);
    expect(transportShortcutRule).not.toBeNull();
    expect(transportShortcutRule![0]).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(transportShortcutRule![0]).toMatch(/margin-left:\s*0/);
    expect(transportShortcutRule![0]).toMatch(/padding-left:\s*0/);

    const stopButtonRule = css.match(/\.shortcut-btn-stop\s*\{[^}]*\}/);
    expect(stopButtonRule).not.toBeNull();
    expect(stopButtonRule![0]).toMatch(/width:\s*44px/);
    expect(stopButtonRule![0]).toMatch(/min-width:\s*44px/);

    const mobileTransportShortcutRule = Array.from(css.matchAll(/\.shortcuts-transport\s*\{[^}]*\}/g))
      .map((match) => match[0])
      .find((rule) => /max-width:\s*none/.test(rule));
    expect(mobileTransportShortcutRule).not.toBeNull();
    expect(mobileTransportShortcutRule!).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(mobileTransportShortcutRule!).toMatch(/min-width:\s*0/);
    expect(mobileTransportShortcutRule!).toMatch(/max-width:\s*none/);
    expect(mobileTransportShortcutRule!).toMatch(/padding-left:\s*0/);

    const mobileMetaScrollerRule = css.match(/\.shortcuts-meta-scroll\s*\{\s*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*\}/);
    expect(mobileMetaScrollerRule).not.toBeNull();
    expect(mobileMetaScrollerRule![0]).toMatch(/flex:\s*1\s+1\s+0/);
    expect(mobileMetaScrollerRule![0]).toMatch(/min-width:\s*0/);
    expect(mobileMetaScrollerRule![0]).toMatch(/overflow-y:\s*hidden/);
    expect(mobileMetaScrollerRule![0]).toMatch(/scrollbar-width:\s*none/);
    expect(css).toMatch(/\.shortcuts-meta-scroll::-webkit-scrollbar\s*\{\s*display:\s*none/);

    // The mobile scroller is the flex item that grows, so without an explicit
    // push its children pack to the left of the leftover space and the meta
    // controls stop hugging the right edge. An auto start margin restores that
    // and, unlike justify-content: flex-end, still lets an overflowing scroller
    // reach its leading items.
    expect(css).toMatch(
      /\.shortcuts-meta-scroll\s*>\s*:first-child\s*\{\s*margin-inline-start:\s*auto;\s*\}/,
    );

    const subcardStopRule = css.match(/\.subcard-stop-btn\s*\{[^}]*\}/);
    expect(subcardStopRule).not.toBeNull();
    expect(subcardStopRule![0]).toMatch(/width:\s*28px/);
    expect(subcardStopRule![0]).toMatch(/min-width:\s*28px/);
    expect(subcardStopRule![0]).toMatch(/margin-left:\s*0/);
    expect(subcardStopRule![0]).toMatch(/border-radius:\s*6px/);

    const cardComposerRule = css.match(/\.subcard \.controls-input\s*\{[^}]*\}/);
    expect(cardComposerRule).not.toBeNull();
    expect(cardComposerRule![0]).toMatch(/min-height:\s*calc\(1\.45em \+ 10px\)/);
    expect(cardComposerRule![0]).toMatch(/max-height:\s*calc\(1\.45em \+ 10px\)/);

    const expandedCardComposerRule = css.match(/\.subcard \.controls-composer-mobile-expanded \.controls-input\s*\{[^}]*\}/);
    expect(expandedCardComposerRule).not.toBeNull();
    expect(expandedCardComposerRule![0]).toMatch(/min-height:\s*100%/);
    expect(expandedCardComposerRule![0]).toMatch(/max-height:\s*none/);
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

  it('keeps daemon details as a fixed dismissible overlay on every layout', () => {
    const backdropRule = css.match(/\.daemon-details-backdrop\s*\{[^}]*\}/);
    expect(backdropRule).not.toBeNull();
    expect(backdropRule![0]).toMatch(/position:\s*fixed/);
    expect(backdropRule![0]).toMatch(/inset:\s*0/);
    expect(backdropRule![0]).toMatch(/z-index:\s*13000/);

    const panelRule = css.match(/\.daemon-details-panel\s*\{[^}]*\}/);
    expect(panelRule).not.toBeNull();
    expect(panelRule![0]).toMatch(/max-height:\s*min\(82dvh,\s*680px\)/);
    expect(panelRule![0]).toMatch(/overflow:\s*auto/);

    const triggerRule = css.match(/\.daemon-stats-trigger\s*\{[^}]*\}/);
    expect(triggerRule).not.toBeNull();
    expect(triggerRule![0]).toMatch(/appearance:\s*none/);
    expect(triggerRule![0]).toMatch(/cursor:\s*pointer/);
  });

  it('keeps full-screen mobile work surfaces above the persistent server bar', () => {
    const rootRule = css.match(/:root\s*\{[^}]*\}/);
    expect(rootRule).not.toBeNull();
    expect(rootRule![0]).toMatch(/--mobile-server-bar-z:\s*6500/);
    expect(rootRule![0]).toMatch(/--mobile-fullscreen-window-z:\s*7000/);
    expect(rootRule![0]).toMatch(/--mobile-fullscreen-preview-z:\s*7001/);

    const sidebarRule = css.match(/\.mobile-sidebar-overlay\s*\{[^}]*\}/);
    expect(sidebarRule).not.toBeNull();
    expect(sidebarRule![0]).toMatch(/z-index:\s*var\(--mobile-fullscreen-window-z\)/);

    const fileOverlayRule = Array.from(css.matchAll(/\.mobile-fb-overlay\s*\{[^}]*\}/g))
      .map((match) => match[0])
      .find((rule) => /position:\s*fixed/.test(rule));
    expect(fileOverlayRule).toBeDefined();
    expect(fileOverlayRule).toMatch(/z-index:\s*var\(--mobile-fullscreen-window-z\)/);

    const previewRule = Array.from(css.matchAll(/\.fb-body-split \.fb-preview\s*\{[^}]*\}/g))
      .map((match) => match[0])
      .find((rule) => /position:\s*fixed/.test(rule));
    expect(previewRule).toBeDefined();
    expect(previewRule).toMatch(/z-index:\s*var\(--mobile-fullscreen-preview-z\)/);
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

    const autoLauncherRule = css.match(/\.menu-dropdown-openspec-inline \.openspec-auto-launcher\s*\{[^}]*\}/);
    expect(autoLauncherRule).not.toBeNull();
    expect(autoLauncherRule![0]).toMatch(/max-height:\s*min\(58vh/);
    expect(autoLauncherRule![0]).toMatch(/overflow-y:\s*auto/);
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
    expect(barRule!).toMatch(/z-index:\s*var\(--mobile-server-bar-z\)/);

    const backdropRule = css.match(/\.mobile-server-backdrop\s*\{[^}]*\}/);
    expect(backdropRule).not.toBeNull();
    expect(backdropRule![0]).toMatch(/z-index:\s*6499/);

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

  it('mobile shell chrome does not depend solely on the narrow viewport breakpoint', () => {
    const mobileLayoutBarRule = css.match(/\.layout-mobile\s+\.mobile-server-bar\s*\{[^}]*\}/);
    expect(mobileLayoutBarRule).not.toBeNull();
    expect(mobileLayoutBarRule![0]).toMatch(/display:\s*flex/);

    const mobileLayoutToggleRule = css.match(/\.layout-mobile\s+\.mobile-sidebar-toggle\s*\{[^}]*\}/);
    expect(mobileLayoutToggleRule).not.toBeNull();
    expect(mobileLayoutToggleRule![0]).toMatch(/display:\s*block/);

    const mobileLayoutSidebarRule = css.match(/\.layout-mobile\s+\.sidebar\s*\{[^}]*\}/);
    expect(mobileLayoutSidebarRule).not.toBeNull();
    expect(mobileLayoutSidebarRule![0]).toMatch(/display:\s*none/);
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
  it('the expanded tool-activity details must not be narrower than the chip', () => {
    // User reported the expanded rows running past the right edge instead of
    // filling the width. Root cause: the details block was capped at
    // `min(100%, 760px)` while the collapsed chip is full width, so the rows
    // were laid out into a container narrower than the space available and the
    // 6px left margin pushed the remainder out of view.
    const rule = cssWithoutComments.match(/\.chat-tool-activity-details\s*\{[^}]*\}/)?.[0];
    expect(rule, '.chat-tool-activity-details rule missing').toBeTruthy();
    expect(rule).not.toMatch(/760px/);
    expect(rule).not.toMatch(/max-width/);
    // `min-width: 0` is what lets the horizontally-scrolling rows inside shrink
    // to the container instead of forcing it wider.
    expect(rule).toMatch(/min-width:\s*0/);
  });

  it('the collapsed tool-activity chip stays full width', () => {
    // It carries a variable-length tool descriptor; sizing to content made it
    // jump around as tools changed and left nothing to ellipse.
    const rule = cssWithoutComments.match(/\.chat-tool-activity\s*\{[^}]*\}/)?.[0];
    expect(rule, '.chat-tool-activity rule missing').toBeTruthy();
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/width:\s*fit-content/);
  });
  it('the collapsed tool fold must not carry a grid texture', () => {
    // User reported "多余的线" between messages twice. Root cause: the fold's
    // background stacked a 12x12 grid, whose first layer is a horizontal rule
    // every 12px. When the collapsed content is shorter than the box, the bare
    // texture reads as separator lines between the surrounding messages.
    const rule = cssWithoutComments.match(/\.chat-tool-block-fold\s*\{[^}]*\}/)?.[0];
    expect(rule, '.chat-tool-block-fold rule missing').toBeTruthy();
    // A `1px, transparent 1px` stop is what draws the repeating line.
    expect(rule).not.toMatch(/1px,\s*transparent\s*1px/);
    expect(rule).not.toMatch(/background-size:[^;]*12px/);
    // The card keeps its own gradient — this is about the texture, not the fill.
    expect(rule).toMatch(/linear-gradient\(115deg/);
  });

  // The desktop composer restack must stay inside its min-width block. The
  // mobile layout is the 640px override of the same base rules, so a rule that
  // leaks out of the media query would silently restack the phone composer too
  // -- and nothing else in the suite renders at a real viewport width to catch
  // it.
  it('keeps the desktop composer restack scoped to the desktop breakpoint', () => {
    const desktopBlock = /@media \(min-width: 641px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(desktopBlock).not.toBeNull();
    const inside = desktopBlock![1];
    expect(inside).toMatch(/\.controls\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(inside).toMatch(/\.controls-composer\s*\{[^}]*order:\s*-1/);

    // Outside the block, `.controls` must not wrap and the composer must not
    // claim its own row.
    const outside = css.replace(desktopBlock![0], '');
    expect(outside).not.toMatch(/\.controls\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(outside).not.toMatch(/\.controls-composer\s*\{[^}]*order:\s*-1/);
  });

  // Compositor-backed drag targets can fail to repaint native :hover. The
  // visual state therefore also accepts an explicit target-phase class.
  it('drives the resize highlight from an explicit composited hover surface', () => {
    const desktopBlock = /@media \(min-width: 641px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(desktopBlock).not.toBeNull();
    const inside = desktopBlock![1];

    expect(inside).toMatch(/\.controls-composer-resize-edge::after\s*\{[^}]*background/);
    expect(inside).toMatch(/\.controls-composer-resize-edge:hover::after/);
    expect(inside).toMatch(/\.controls-composer-resize-edge\.is-pointer-hovered::after/);
    expect(inside).not.toMatch(/\.controls-composer-resize-edge::after\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.resize-hover-surface\s*\{[^}]*transform:\s*translateZ\(0\)/);
  });

  it('routes remote-desktop hover through a painted HTML surface above video', () => {
    const videoRule = css.match(/\.remote-desktop-stage video\s*\{[^}]*\}/)?.[0];
    expect(videoRule, '.remote-desktop-stage video rule missing').toBeTruthy();
    expect(videoRule).toMatch(/pointer-events:\s*none/);
    const surfaceRule = css.match(/\.remote-desktop-input-surface\s*\{[^}]*\}/)?.[0];
    expect(surfaceRule, '.remote-desktop-input-surface rule missing').toBeTruthy();
    expect(surfaceRule).toMatch(/background:\s*rgb\(0 0 0 \/ 0\.1%\)/);
    expect(surfaceRule).toMatch(/pointer-events:\s*auto/);
  });

  // Transport sessions zero the toolbar's left padding, and they are the only
  // sessions that render a Stop button -- so matching `.shortcuts` alone would
  // leave the exact case this alignment exists for still misaligned.
  it('aligns the toolbar with the composer box on both shortcut variants', () => {
    const desktopBlock = /@media \(min-width: 641px\) \{([\s\S]*?)\n\}/.exec(css);
    const inside = desktopBlock![1];
    expect(inside).toMatch(/\.shortcuts,\s*\n\s*\.shortcuts-transport\s*\{[^}]*padding-left/);
  });

  it('has no composer corner-grip styles left', () => {
    expect(css).not.toMatch(/\.controls-composer-resize-handle/);
    expect(css).not.toMatch(/\.composer-height-resizing-corner/);
  });

  // An unbalanced brace does not throw and does not blank the page: the parser
  // silently swallows everything after it into the unclosed block, so rules
  // stop applying while still being present in the file and still matching by
  // selector. That failure mode cost real debugging time; assert it directly.
  it('has balanced braces', () => {
    const stripped = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
    const open = (stripped.match(/\{/g) ?? []).length;
    const close = (stripped.match(/\}/g) ?? []).length;
    expect(close - open).toBe(0);
  });
});
