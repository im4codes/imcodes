/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_FONT, FontPrefsDropdown, readFontPrefs, useFontPrefs } from '../../src/components/FontPrefsDropdown.js';

describe('FontPrefsDropdown', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
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

  it('lets the CJK fallback be selected separately from the code font', () => {
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getByRole('tab', { name: 'CJK' }));

    const yaheiOption = screen.getByRole('option', { name: 'Microsoft YaHei' }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('CJK font'), { target: { value: yaheiOption.value } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({
      size: 14,
      cjkFamily: yaheiOption.value,
    });
    expect(onChange.mock.calls[0][0].family).toContain('"JetBrains Mono"');
    expect(onChange.mock.calls[0][0].family).toContain('"Microsoft YaHei"');
  });

  it('persists the selected CJK fallback when using stored font prefs', () => {
    const scope = 'font-test';
    function Harness() {
      const [prefs, update] = useFontPrefs(scope, DEFAULT_CHAT_FONT);
      return <FontPrefsDropdown prefs={prefs} onChange={update} />;
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getByRole('tab', { name: 'CJK' }));
    const yaheiOption = screen.getByRole('option', { name: 'Microsoft YaHei' }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('CJK font'), { target: { value: yaheiOption.value } });

    const stored = JSON.parse(localStorage.getItem(`imcodes_fontPrefs:${scope}`) ?? '{}') as { cjkFamily?: string; family?: string };
    expect(stored.cjkFamily).toContain('"Microsoft YaHei"');
    expect(stored.family).toContain('"Microsoft YaHei"');
    expect(stored.family?.indexOf('"Microsoft YaHei"')).toBeLessThan(stored.family?.indexOf('"PingFang SC"') ?? Number.MAX_SAFE_INTEGER);
  });

  it('recovers CJK selection from previously saved family stacks without cjkFamily', () => {
    localStorage.setItem('imcodes_fontPrefs:legacy-cjk', JSON.stringify({
      family: `"JetBrains Mono", "JetBrains Mono NL", ui-monospace, Menlo, Consolas, "Microsoft YaHei", "PingFang SC", monospace`,
      size: 14,
    }));

    const prefs = readFontPrefs('legacy-cjk', DEFAULT_CHAT_FONT);

    expect(prefs.cjkFamily?.startsWith('"Microsoft YaHei"')).toBe(true);
    expect(prefs.family).toContain('"Microsoft YaHei"');
  });

  it('replaces an existing CJK fallback in stored family stacks', () => {
    const scope = 'replace-cjk';
    function Harness() {
      const [prefs, update] = useFontPrefs(scope, DEFAULT_CHAT_FONT);
      return <FontPrefsDropdown prefs={prefs} onChange={update} />;
    }

    localStorage.setItem(`imcodes_fontPrefs:${scope}`, JSON.stringify({
      family: `"Custom Mono", "Microsoft YaHei", "PingFang SC", monospace`,
      cjkFamily: `"Microsoft YaHei", "PingFang SC"`,
      size: 14,
    }));
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getByRole('tab', { name: 'CJK' }));
    const simsunOption = screen.getByRole('option', { name: 'SimSun' }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('CJK font'), { target: { value: simsunOption.value } });

    const stored = JSON.parse(localStorage.getItem(`imcodes_fontPrefs:${scope}`) ?? '{}') as { cjkFamily?: string; family?: string };
    expect(stored.cjkFamily?.startsWith('"SimSun"')).toBe(true);
    expect(stored.family?.indexOf('"SimSun"')).toBeLessThan(stored.family?.indexOf('"PingFang SC"') ?? Number.MAX_SAFE_INTEGER);
    expect(stored.family?.indexOf('"Microsoft YaHei"')).toBeGreaterThan(stored.family?.indexOf('"SimSun"') ?? Number.MAX_SAFE_INTEGER);
  });
});
