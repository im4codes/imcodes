/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_FONT, FontPrefsDropdown } from '../../src/components/FontPrefsDropdown.js';

describe('FontPrefsDropdown', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('updates font size on pointer down so Android taps do not depend on synthetic click', () => {
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: '+' }), { pointerId: 1, pointerType: 'touch' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...prefs, size: 15 });
  });

  it('keeps click as a fallback for non-pointer environments', () => {
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getByRole('button', { name: '−' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...prefs, size: 13 });
  });

  it('always exposes bundled Cascadia Mono in the font picker', () => {
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    const cascadiaOption = screen.getByRole('option', { name: 'Cascadia Mono' }) as HTMLOptionElement;
    expect(cascadiaOption).toBeTruthy();
    expect(cascadiaOption.value).toContain('"Cascadia Mono"');
  });
});
