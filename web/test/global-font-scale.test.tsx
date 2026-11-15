/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGlobalFontDelta,
  CHAT_FONT_SIZE_VAR,
  clampGlobalFontDelta,
  DEFAULT_GLOBAL_FONT_DELTA,
  formatGlobalFontDelta,
  GLOBAL_FONT_DELTA_STORAGE_KEY,
  GLOBAL_FONT_DELTA_VAR,
  installGlobalFontVnodeHook,
  MAX_GLOBAL_FONT_DELTA,
  MIN_GLOBAL_FONT_DELTA,
  readGlobalFontDelta,
  scaledCssFontPx,
  transformCssFontSizes,
  useGlobalFontDelta,
  writeGlobalFontDelta,
} from '../src/global-font.js';
import {
  DEFAULT_CHAT_FONT,
  FontPrefsDropdown,
  useFontPrefs,
} from '../src/components/FontPrefsDropdown.js';

const i18nMock = vi.hoisted(() => ({
  translations: {} as Record<string, string>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => i18nMock.translations[key] ?? options?.defaultValue ?? key,
  }),
}));

const termMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    cols: number;
    rows: number;
    buffer: { active: { viewportY: number; baseY: number; length: number } };
  }>,
  fitCalls: 0,
}));

vi.mock('xterm', () => {
  class MockTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
    loadAddon = vi.fn();
    open = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    write = vi.fn((_data: unknown, cb?: () => void) => cb?.());
    scrollToBottom = vi.fn();
    clear = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();

    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      termMockState.instances.push(this);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn(() => {
      termMockState.fitCalls += 1;
    });
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/addon-web-links', () => {
  class MockWebLinksAddon {
    dispose = vi.fn();
  }
  return { WebLinksAddon: MockWebLinksAddon };
});

import { TerminalView } from '../src/components/TerminalView.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';

describe('global font scaling', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty(GLOBAL_FONT_DELTA_VAR);
    document.documentElement.className = '';
    i18nMock.translations = {};
    termMockState.instances = [];
    termMockState.fitCalls = 0;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.style.removeProperty(GLOBAL_FONT_DELTA_VAR);
    document.documentElement.className = '';
    vi.restoreAllMocks();
  });

  it('defaults to 0, formats +/- signs clearly, and clamps within bounds', () => {
    expect(DEFAULT_GLOBAL_FONT_DELTA).toBe(0);
    expect(readGlobalFontDelta()).toBe(0);
    expect(formatGlobalFontDelta(0)).toBe('0');
    expect(formatGlobalFontDelta(1)).toBe('+1');
    expect(formatGlobalFontDelta(5)).toBe('+5');
    expect(formatGlobalFontDelta(-1)).toBe('-1');
    expect(formatGlobalFontDelta(-4)).toBe('-4');

    expect(clampGlobalFontDelta(Number.NaN)).toBe(0);
    expect(clampGlobalFontDelta(-0)).toBe(0);
    expect(clampGlobalFontDelta(1.6)).toBe(2);
    expect(clampGlobalFontDelta(-99)).toBe(MIN_GLOBAL_FONT_DELTA);
    expect(clampGlobalFontDelta(99)).toBe(MAX_GLOBAL_FONT_DELTA);
  });

  it('persists delta, updates --imcodes-global-font-delta on root, and broadcasts across components and tabs', () => {
    function Reader({ id }: { id: string }) {
      const [delta, setDelta] = useGlobalFontDelta();
      return (
        <div data-testid={id}>
          <output>{formatGlobalFontDelta(delta)}</output>
          <button type="button" onClick={() => setDelta((prev) => prev + 1)}>inc-{id}</button>
        </div>
      );
    }

    render(<>
      <Reader id="a" />
      <Reader id="b" />
    </>);

    expect(screen.getByTestId('a').querySelector('output')?.textContent).toBe('0');
    expect(screen.getByTestId('b').querySelector('output')?.textContent).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'inc-a' }));
    expect(screen.getByTestId('a').querySelector('output')?.textContent).toBe('+1');
    expect(screen.getByTestId('b').querySelector('output')?.textContent).toBe('+1');
    expect(localStorage.getItem(GLOBAL_FONT_DELTA_STORAGE_KEY)).toBe('1');
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('1px');

    localStorage.setItem(GLOBAL_FONT_DELTA_STORAGE_KEY, '-2');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: GLOBAL_FONT_DELTA_STORAGE_KEY, newValue: '-2' }));
    });
    expect(screen.getByTestId('a').querySelector('output')?.textContent).toBe('-2');
    expect(screen.getByTestId('b').querySelector('output')?.textContent).toBe('-2');
    applyGlobalFontDelta(readGlobalFontDelta());
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('-2px');
  });

  it('handles storage errors safely when writing delta', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const next = writeGlobalFontDelta(3);
    expect(next).toBe(3);
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('3px');
    spy.mockRestore();
  });

  it('transforms CSS px and rem font-size declarations globally without breaking em/inherit/comments/clamp', () => {
    const input = `
      /* font-size: 14px and 0.75rem inside comment must stay */
      .sidebar-header { font-size: 12px; }
      .tab { font-size: 13.5px !important; }
      .heading-em { font-size: 1.25em; }
      .label-rem { font-size: 0.78rem; }
      .label-short-rem { font-size: .75rem; }
      .inherit-node { font-size: inherit; }
      .watermark { font-size: clamp(42px, 6.2vw, 76px); }
      .native-chat { font-size: var(--imcodes-chat-font-size, 16px); }
      .already { font-size: max(8px, calc(14px + var(--imcodes-global-font-delta, 0px))); }
    `;
    const output = transformCssFontSizes(input);

    expect(output).toContain('/* font-size: 14px and 0.75rem inside comment must stay */');
    expect(output).toContain('.sidebar-header { font-size: max(8px, calc(12px + var(--imcodes-global-font-delta, 0px))); }');
    expect(output).toContain('.tab { font-size: max(8px, calc(13.5px + var(--imcodes-global-font-delta, 0px))) !important; }');
    expect(output).toContain('.heading-em { font-size: 1.25em; }');
    expect(output).toContain('.label-rem { font-size: max(8px, calc(0.78rem + var(--imcodes-global-font-delta, 0px))); }');
    expect(output).toContain('.label-short-rem { font-size: max(8px, calc(.75rem + var(--imcodes-global-font-delta, 0px))); }');
    expect(output).toContain('.inherit-node { font-size: inherit; }');
    expect(output).toContain('.watermark { font-size: clamp(max(8px, calc(42px + var(--imcodes-global-font-delta, 0px))), calc(6.2vw + var(--imcodes-global-font-delta, 0px)), max(8px, calc(76px + var(--imcodes-global-font-delta, 0px)))); }');
    expect(output).toContain('.native-chat { font-size: var(--imcodes-chat-font-size, max(8px, calc(16px + var(--imcodes-global-font-delta, 0px)))); }');
    expect(output).toContain('.already { font-size: max(8px, calc(14px + var(--imcodes-global-font-delta, 0px))); }');
  });

  it('transforms all rem and px selectors in src/styles.css including cron labels and reflects +/-1 root delta', () => {
    const rawStyles = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    const transformed = transformCssFontSizes(rawStyles);

    expect(transformed).toMatch(/\.chat-cron-run-chip\s*\{[^}]*font-size:\s*max\(8px,\s*calc\(0\.75rem \+ var\(--imcodes-global-font-delta, 0px\)\)\)/);
    expect(transformed).toMatch(/\.chat-cron-run-detail-row\s*\{[^}]*font-size:\s*[^;]*max\(8px,\s*calc\(0\.78rem \+ var\(--imcodes-global-font-delta, 0px\)\)\)/);
    expect(transformed).toMatch(/\.chat-cron-run-contract\s*\{[^}]*font-size:\s*max\(8px,\s*calc\(0\.75rem \+ var\(--imcodes-global-font-delta, 0px\)\)\)/);
    expect(transformed).toMatch(/\.chat-cron-run-task-label\s*\{[^}]*font-size:\s*max\(8px,\s*calc\(0\.78rem \+ var\(--imcodes-global-font-delta, 0px\)\)\)/);

    // Every non-em, non-inherit font-size in styles.css must carry either --imcodes-global-font-delta or --imcodes-chat-font-size
    const unscaledAbsoluteDeclarations: string[] = [];
    for (const match of transformed.matchAll(/font-size\s*:\s*([^;{}]+)/gi)) {
      const value = match[1].trim();
      if (/(?:\d|\.)em\b|inherit/i.test(value)) continue;
      if (!value.includes(GLOBAL_FONT_DELTA_VAR) && !value.includes(CHAT_FONT_SIZE_VAR)) {
        unscaledAbsoluteDeclarations.push(value);
      }
    }
    expect(unscaledAbsoluteDeclarations).toEqual([]);

    writeGlobalFontDelta(1);
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('1px');
    writeGlobalFontDelta(-1);
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('-1px');
  });

  it('scales inline numeric, px, and rem Preact styles via vnode hook without mutating shared style objects or em units', () => {
    installGlobalFontVnodeHook();

    const sharedFrozenStyle = Object.freeze({ fontSize: 12, color: '#cbd5e1' });
    render(
      <div>
        <span data-testid="num" style={sharedFrozenStyle}>A</span>
        <span data-testid="px" style={{ fontSize: '15px' }}>B</span>
        <span data-testid="rem" style={{ fontSize: '0.78rem' }}>R</span>
        <span data-testid="em" style={{ fontSize: '0.75em' }}>C</span>
        <span data-testid="chat" style={{ fontSize: scaledCssFontPx(14) }}>D</span>
        <span data-testid="str" style="color:red;font-size:11px">E</span>
        <span data-testid="str-rem" style="font-size:.75rem">G</span>
        <svg><text data-testid="svg-text" fontSize="10">F</text></svg>
      </div>,
    );

    expect(sharedFrozenStyle.fontSize).toBe(12);
    expect(screen.getByTestId('num').getAttribute('style')).toContain('max(8px, calc(12px + var(--imcodes-global-font-delta, 0px)))');
    expect(screen.getByTestId('px').getAttribute('style')).toContain('max(8px, calc(15px + var(--imcodes-global-font-delta, 0px)))');
    expect(screen.getByTestId('rem').getAttribute('style')).toContain('max(8px, calc(0.78rem + var(--imcodes-global-font-delta, 0px)))');
    expect(screen.getByTestId('em').getAttribute('style')).toContain('0.75em');
    expect(screen.getByTestId('chat').getAttribute('style')).toContain('max(8px, calc(14px + var(--imcodes-global-font-delta, 0px)))');
    expect(screen.getByTestId('str').getAttribute('style')).toContain('max(8px, calc(11px + var(--imcodes-global-font-delta, 0px)))');
    expect(screen.getByTestId('str-rem').getAttribute('style')).toContain('max(8px, calc(.75rem + var(--imcodes-global-font-delta, 0px)))');
    expect(screen.getByTestId('svg-text').getAttribute('font-size')).toBe('10');
  });

  it('exposes Global Font Size (+1/-1 from 0) alongside Chat Font Size in FontPrefsDropdown and syncs with SettingsPage', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    i18nMock.translations = {
      'chat.font.globalSizeLabel': '全局字体大小',
      'chat.font.chatSizeLabel': '聊天字体大小',
      'chat.font.globalDecrease': '减小全局字体大小',
      'chat.font.globalIncrease': '增大全局字体大小',
      'chat.font.globalReset': '重置',
    };

    function Harness() {
      const [prefs, updatePrefs] = useFontPrefs('chat', DEFAULT_CHAT_FONT);
      return (
        <>
          <FontPrefsDropdown prefs={prefs} onChange={updatePrefs} />
          <SettingsPage
            displayName="K"
            username="k"
            hasPassword={true}
            onBack={() => {}}
            onDisplayNameChanged={() => {}}
            onUserAuthUpdated={() => {}}
          />
        </>
      );
    }

    render(<Harness />);

    expect(screen.getByTestId('settings-global-font-delta-readout').textContent).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));

    expect(screen.getAllByText('全局字体大小')).toHaveLength(2);
    expect(screen.getByText('聊天字体大小')).toBeTruthy();
    expect(screen.getByTestId('global-font-delta-readout').textContent).toBe('0');
    expect(screen.getByTestId('chat-font-size-readout').textContent).toBe('14');

    const incButtons = screen.getAllByRole('button', { name: '增大全局字体大小' });
    const decButtons = screen.getAllByRole('button', { name: '减小全局字体大小' });

    fireEvent.click(incButtons[0]);
    fireEvent.click(incButtons[0]);
    expect(screen.getByTestId('global-font-delta-readout').textContent).toBe('+2');
    expect(screen.getByTestId('settings-global-font-delta-readout').textContent).toBe('+2');
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('2px');

    // Chat font size still increments independently (+).
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    expect(screen.getByTestId('chat-font-size-readout').textContent).toBe('15');

    // Decrementing from SettingsPage updates FontPrefsDropdown immediately and goes negative.
    fireEvent.click(decButtons[1]);
    fireEvent.click(decButtons[1]);
    fireEvent.click(decButtons[1]);
    expect(screen.getByTestId('global-font-delta-readout').textContent).toBe('-1');
    expect(screen.getByTestId('settings-global-font-delta-readout').textContent).toBe('-1');
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('-1px');

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(screen.getByTestId('global-font-delta-readout').textContent).toBe('0');
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('0px');
  });

  it('clamps Global Font Size controls in FontPrefsDropdown at MIN and MAX bounds', () => {
    localStorage.setItem(GLOBAL_FONT_DELTA_STORAGE_KEY, String(MAX_GLOBAL_FONT_DELTA));
    const onChange = vi.fn();
    render(<FontPrefsDropdown prefs={DEFAULT_CHAT_FONT} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));

    const inc = screen.getByRole('button', { name: 'Increase global font size' }) as HTMLButtonElement;
    const dec = screen.getByRole('button', { name: 'Decrease global font size' }) as HTMLButtonElement;
    expect(screen.getByTestId('global-font-delta-readout').textContent).toBe(`+${MAX_GLOBAL_FONT_DELTA}`);
    expect(inc.disabled).toBe(true);
    expect(dec.disabled).toBe(false);

    cleanup();
    localStorage.setItem(GLOBAL_FONT_DELTA_STORAGE_KEY, String(MIN_GLOBAL_FONT_DELTA));
    render(<FontPrefsDropdown prefs={DEFAULT_CHAT_FONT} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    const incMin = screen.getByRole('button', { name: 'Increase global font size' }) as HTMLButtonElement;
    const decMin = screen.getByRole('button', { name: 'Decrease global font size' }) as HTMLButtonElement;
    expect(screen.getByTestId('global-font-delta-readout').textContent).toBe(String(MIN_GLOBAL_FONT_DELTA));
    expect(decMin.disabled).toBe(true);
    expect(incMin.disabled).toBe(false);
  });

  it('does not override ChatView font preferences with hardcoded native-ios-mac / android px rules', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    expect(css).toContain(`font-size: var(${CHAT_FONT_SIZE_VAR}, 16px);`);
    expect(css).toContain(`font-size: max(8px, calc(var(${CHAT_FONT_SIZE_VAR}, 16px) - 1px));`);
    expect(css).toContain(`font-size: max(8px, calc(var(${CHAT_FONT_SIZE_VAR}, 16px) - 3px));`);
    expect(css).toContain(`font-size: var(${CHAT_FONT_SIZE_VAR}, 13.5px);`);

    const appDelegate = readFileSync(resolve(__dirname, '../ios/App/App/AppDelegate.swift'), 'utf8');
    expect(appDelegate).toContain('configuredWebViewId');
    expect(appDelegate).toContain('refreshMacPageZoomAndHostSignal');
    expect(appDelegate).toContain('isMacDesktopHost');
  });

  it('updates TerminalView xterm fontSize and calls fit() live when global font delta changes', async () => {
    const origResizeObserver = globalThis.ResizeObserver;
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: MockResizeObserver,
    });

    try {
      function TermHarness() {
        const [, setDelta] = useGlobalFontDelta();
        return (
          <div>
            <button type="button" onClick={() => setDelta((d) => d + 1)}>step-up</button>
            <button type="button" onClick={() => setDelta((d) => d - 1)}>step-down</button>
            <TerminalView sessionName="deck_test" ws={null} active={true} />
          </div>
        );
      }

      render(<TermHarness />);
      await waitFor(() => expect(termMockState.instances.length).toBe(1));
      const term = termMockState.instances[0]!;
      expect(term.options.fontSize).toBe(13);

      const beforeFit = termMockState.fitCalls;
      fireEvent.click(screen.getByRole('button', { name: 'step-up' }));
      await waitFor(() => expect(term.options.fontSize).toBe(14));
      expect(termMockState.fitCalls).toBeGreaterThan(beforeFit);

      fireEvent.click(screen.getByRole('button', { name: 'step-down' }));
      fireEvent.click(screen.getByRole('button', { name: 'step-down' }));
      await waitFor(() => expect(term.options.fontSize).toBe(12));
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: origResizeObserver,
      });
    }
  });
});
