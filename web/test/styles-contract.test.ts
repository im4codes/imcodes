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
});
