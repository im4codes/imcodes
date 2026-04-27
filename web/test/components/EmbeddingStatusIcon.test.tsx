/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, render, screen } from '@testing-library/preact';
import { EmbeddingStatusIcon } from '../../src/components/EmbeddingStatusIcon.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

afterEach(() => cleanup());

describe('EmbeddingStatusIcon', () => {
  it('renders a dim "unknown" icon when status is null', () => {
    render(h(EmbeddingStatusIcon, { status: null }));
    const icon = screen.getByTitle(/unknown/i);
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('data-state')).toBe('unknown');
  });

  it('renders the green "ready" icon when state is ready', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'ready', reason: null } }));
    const icon = screen.getByTitle(/ready/i);
    expect(icon.getAttribute('data-state')).toBe('ready');
    // Style attribute carries the green color so manual visual review
    // matches the contract documented in the component.
    expect(icon.getAttribute('style') ?? '').toContain('rgb(74, 222, 128)');
  });

  it('renders the yellow "fallback" icon and includes the local failure reason in the tooltip', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'fallback', reason: 'ERR_DLOPEN_FAILED' } }));
    const icon = screen.getByTitle(/server fallback/i);
    expect(icon.getAttribute('data-state')).toBe('fallback');
    // The reason code is appended in parentheses so operators can grep
    // daemon.log without first decoding the localized text.
    expect(icon.getAttribute('title') ?? '').toContain('(ERR_DLOPEN_FAILED)');
  });

  it('renders the red "unavailable" icon when both local and server fallback are dead', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'unavailable', reason: 'MODULE_NOT_FOUND' } }));
    const icon = screen.getByTitle(/unavailable/i);
    expect(icon.getAttribute('data-state')).toBe('unavailable');
    expect(icon.getAttribute('title') ?? '').toContain('(MODULE_NOT_FOUND)');
  });

  it('renders the dim "idle" icon and does NOT include a reason-code suffix', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'idle', reason: null } }));
    const icon = screen.getByTitle(/idle/i);
    expect(icon.getAttribute('data-state')).toBe('idle');
    // The component only appends `(REASON_CODE)` when reason is non-null;
    // reason codes are uppercase with underscores, so a regex on that
    // pattern is the right invariant. Plain English parens (like
    // "(not yet used)") in the locale text are fine.
    expect(icon.getAttribute('title') ?? '').not.toMatch(/\([A-Z_]+\)/);
  });

  it('renders a "loading" icon when state is loading', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'loading', reason: null } }));
    const icon = screen.getByTitle(/loading/i);
    expect(icon.getAttribute('data-state')).toBe('loading');
  });

  it('compact mode applies a smaller font size to match the mobile toolbar glyphs', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'ready', reason: null }, compact: true }));
    const icon = screen.getByTitle(/ready/i);
    expect(icon.getAttribute('style') ?? '').toContain('font-size: 0.75em');
  });

  it('default (non-compact) mode uses the larger glyph size', () => {
    render(h(EmbeddingStatusIcon, { status: { state: 'ready', reason: null } }));
    const icon = screen.getByTitle(/ready/i);
    expect(icon.getAttribute('style') ?? '').toContain('font-size: 0.85em');
  });
});
