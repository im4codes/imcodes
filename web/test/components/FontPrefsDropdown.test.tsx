/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGlobalFontPrefs,
  DEFAULT_CHAT_FONT,
  FontPrefsDropdown,
  GLOBAL_CJK_FONT_FAMILY_VAR,
  GLOBAL_FONT_FAMILY_VAR,
  readFontPrefs,
  useFontPrefs,
} from '../../src/components/FontPrefsDropdown.js';

const i18nMock = vi.hoisted(() => ({
  translations: {} as Record<string, string>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => i18nMock.translations[key] ?? options?.defaultValue ?? key,
  }),
}));

const DEFAULT_TRANSLATIONS: Record<string, string> = {
  'chat.font.dialogLabel': 'font',
  'chat.font.typeLabel': 'font type',
  'chat.font.codeTab': 'Code',
  'chat.font.cjkTab': 'CJK',
  'chat.font.familyLabel': 'font family',
  'chat.font.cjkFamilyLabel': 'CJK font',
  'chat.font.allBuiltInCjk': 'All built-in CJK fonts',
};

describe('FontPrefsDropdown', () => {
  beforeEach(() => {
    i18nMock.translations = { ...DEFAULT_TRANSLATIONS };
  });

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

  it('keeps non-system CJK fonts out of the built-in selector', () => {
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getByRole('tab', { name: 'CJK' }));

    expect(screen.queryByRole('option', { name: 'LXGW WenKai' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Sarasa Mono SC' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Noto Sans CJK SC' })).toBeNull();
  });

  it('can expand from platform CJK fonts to all Mac and Windows built-ins', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    try {
      render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

      fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
      fireEvent.click(screen.getByRole('tab', { name: 'CJK' }));

      expect(screen.getByRole('option', { name: 'PingFang SC' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'Microsoft YaHei' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'All built-in CJK fonts' }));

      expect(screen.getByRole('option', { name: 'Microsoft YaHei' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'FangSong' })).toBeTruthy();
    } finally {
      Object.defineProperty(window.navigator, 'platform', { value: originalPlatform, configurable: true });
    }
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

  it('localizes the CJK tab, select label, and known Chinese font names without changing CSS values', () => {
    i18nMock.translations = {
      ...DEFAULT_TRANSLATIONS,
      'chat.font.cjkTab': '中文',
      'chat.font.cjkFamilyLabel': '中文字体',
      'chat.font.allBuiltInCjk': '全部系统内置中文字体',
      'chat.font.cjkFamilies.microsoft-yahei': '微软雅黑',
    };
    const onChange = vi.fn();
    const prefs = { ...DEFAULT_CHAT_FONT, size: 14 };

    render(<FontPrefsDropdown prefs={prefs} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getByRole('tab', { name: '中文' }));

    const yaheiOption = screen.getByRole('option', { name: '微软雅黑' }) as HTMLOptionElement;
    expect(yaheiOption.value).toContain('"Microsoft YaHei"');
    fireEvent.change(screen.getByLabelText('中文字体'), { target: { value: yaheiOption.value } });
    expect(onChange.mock.calls[0][0].family).toContain('"Microsoft YaHei"');
  });

  it('applies font preferences to global app CSS variables', () => {
    const root = document.createElement('div');

    applyGlobalFontPrefs({
      family: '"Cascadia Mono", monospace',
      cjkFamily: '"Microsoft YaHei", sans-serif',
      size: 15,
    }, root);

    expect(root.style.getPropertyValue(GLOBAL_FONT_FAMILY_VAR)).toBe('"Cascadia Mono", monospace');
    expect(root.style.getPropertyValue(GLOBAL_CJK_FONT_FAMILY_VAR)).toBe('"Microsoft YaHei", sans-serif');
  });
});
