/**
 * FontPrefsDropdown — icon-only chat font customization control.
 *
 * Trigger: a small "Aa" button. Popover shows
 *   • a wrapping grid of font sample buttons (each rendered in its own family)
 *   • a "…" button that triggers the Local Font Access API for the full
 *     installed-font list when the browser supports it
 *   • a − / + size adjuster
 *
 * No text labels. Changes are real-time and broadcast across the page so
 * every <ChatView> instance updates simultaneously (custom-event bus +
 * `storage` event for cross-tab). Preferences are persisted per-machine
 * via localStorage under `imcodes_fontPrefs:<scope>`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

export interface FontPrefs {
  family: string;
  size: number;
}

const STORAGE_PREFIX = 'imcodes_fontPrefs:';
/** Same-tab broadcast event name — `storage` event only fires cross-tab. */
const FONT_PREFS_EVENT = 'imcodes:fontPrefsChanged';

/**
 * CJK fallback stack appended to monospace presets. Latin-only programmer
 * fonts (JetBrains Mono, Fira Code, etc.) don't ship CJK glyphs, so the
 * browser does per-glyph fallback to whichever family later in the stack
 * supports the character. Listing the common system CJK fonts explicitly
 * gives consistent rendering across macOS / Windows / Linux / iOS / Android
 * instead of relying on the browser's last-resort default which can be
 * jarringly different per OS.
 */
const CJK_FALLBACK = [
  '"PingFang SC"',          // macOS / iOS — Simplified Chinese
  '"PingFang TC"',          // macOS / iOS — Traditional Chinese
  '"Microsoft YaHei"',      // Windows — Simplified Chinese
  '"Microsoft JhengHei"',   // Windows — Traditional Chinese
  '"Hiragino Sans GB"',     // macOS — Simplified Chinese (older)
  '"Hiragino Sans"',        // macOS — Japanese
  '"Yu Gothic"',            // Windows — Japanese
  '"Apple SD Gothic Neo"',  // macOS / iOS — Korean
  '"Malgun Gothic"',        // Windows — Korean
  '"Noto Sans CJK SC"',     // Linux / Android — Simplified Chinese
  '"Source Han Sans SC"',   // Linux alternate
].join(', ');

/**
 * Default chat font. JetBrains Mono is bundled as a webfont (see
 * `web/src/main.tsx`) so it is always available regardless of the user's
 * installed system fonts. CJK characters fall back through the
 * `CJK_FALLBACK` stack, then the last-resort `monospace`.
 */
export const DEFAULT_CHAT_FONT: FontPrefs = {
  family: `"JetBrains Mono", "JetBrains Mono NL", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`,
  size: 14,
};

const MIN_SIZE = 10;
const MAX_SIZE = 24;

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CHAT_FONT.size;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(n)));
}

/**
 * Forward-compat: the first version of this component shipped preset
 * stacks WITHOUT explicit CJK fallback, so users who picked a font in
 * those builds have a Latin-only stack saved in localStorage. Without
 * fallback, Chinese / Japanese / Korean characters land on the browser's
 * last-resort font, which differs jarringly across OSes. This helper
 * auto-injects the shared CJK_FALLBACK into any stored family that
 * doesn't already contain a CJK marker, so an old save silently upgrades
 * on the next page load.
 *
 * Idempotent: stacks that already include "PingFang" (added by us in
 * every preset of the new build) are returned unchanged.
 */
function ensureCJKFallback(family: string): string {
  if (family === 'system-ui') return family; // browser handles CJK natively
  if (family.includes('PingFang')) return family; // already migrated
  // Insert just before the trailing generic family (monospace / sans-serif /
  // serif / cursive / fantasy) so the cascade order stays valid.
  const match = family.match(/^(.+?),\s*(monospace|sans-serif|serif|cursive|fantasy)\s*$/i);
  if (match) return `${match[1]}, ${CJK_FALLBACK}, ${match[2]}`;
  return `${family}, ${CJK_FALLBACK}`;
}

export function readFontPrefs(scope: string, defaults: FontPrefs): FontPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_PREFIX + scope) : null;
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<FontPrefs>;
    const rawFamily = typeof parsed.family === 'string' && parsed.family.length > 0 ? parsed.family : defaults.family;
    return {
      family: ensureCJKFallback(rawFamily),
      size: typeof parsed.size === 'number' ? clampSize(parsed.size) : defaults.size,
    };
  } catch {
    return defaults;
  }
}

/**
 * Subscribe to font preference changes for `scope`. Returns the current
 * prefs and an `update` callback. All instances mounted in the same tab
 * (and across tabs via the native `storage` event) re-read from
 * localStorage when any one of them calls `update`, so a single chat
 * window's font change applies to every open chat window simultaneously.
 */
export function useFontPrefs(scope: string, defaults: FontPrefs): [FontPrefs, (next: FontPrefs) => void] {
  const [prefs, setPrefs] = useState<FontPrefs>(() => readFontPrefs(scope, defaults));
  // Hold defaults in a ref so the listener effect is stable across renders
  // even if the caller passes a freshly-allocated default object each time.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  useEffect(() => {
    const refresh = () => setPrefs(readFontPrefs(scope, defaultsRef.current));
    const onSameTab = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (!detail || detail.scope === scope) refresh();
    };
    const onCrossTab = (e: StorageEvent) => {
      if (e.key === STORAGE_PREFIX + scope) refresh();
    };
    window.addEventListener(FONT_PREFS_EVENT, onSameTab as EventListener);
    window.addEventListener('storage', onCrossTab);
    return () => {
      window.removeEventListener(FONT_PREFS_EVENT, onSameTab as EventListener);
      window.removeEventListener('storage', onCrossTab);
    };
  }, [scope]);

  const update = useCallback((next: FontPrefs) => {
    const safe: FontPrefs = { family: next.family, size: clampSize(next.size) };
    setPrefs(safe);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(safe));
      }
    } catch { /* localStorage unavailable (private mode, quota) — ignore */ }
    try {
      window.dispatchEvent(new CustomEvent(FONT_PREFS_EVENT, { detail: { scope } }));
    } catch { /* CustomEvent unavailable in some test envs — ignore */ }
  }, [scope]);

  return [prefs, update];
}

interface FontFamilyOption {
  id: string;
  /** CSS `font-family` stack persisted to localStorage. */
  cssValue: string;
  /**
   * Primary family to detection-test before showing this preset. Falsy → always
   * show (the generic categories like 'system-ui' or our base sans/serif/mono
   * stacks always render to *something*).
   */
  detectFamily?: string;
}

/**
 * Curated cross-platform font stacks — no bundled web fonts.
 *
 * Categories first (always shown), then well-known programmer-friendly
 * monospace families that we only show when actually installed on this
 * machine (avoids dead buttons that all render in the same fallback). Each
 * stack ends with a sensible generic family.
 *
 * Programmer mono families chosen for ubiquity:
 *   JetBrains Mono, Fira Code, Cascadia Code, Source Code Pro,
 *   IBM Plex Mono, Hack, Iosevka, Inconsolata, Roboto Mono, Ubuntu Mono,
 *   Menlo (mac default), Consolas (Windows default), SF Mono.
 */
const FAMILY_OPTIONS: readonly FontFamilyOption[] = [
  // JetBrains Mono — bundled webfont, default. Always shown.
  { id: 'jetbrains-mono', cssValue: `"JetBrains Mono", "JetBrains Mono NL", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace` },
  // Generic categories — always available
  { id: 'system', cssValue: 'system-ui' },
  { id: 'sans', cssValue: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ${CJK_FALLBACK}, "Helvetica Neue", Arial, sans-serif` },
  { id: 'serif', cssValue: `Georgia, "Times New Roman", "Songti SC", "STSong", "SimSun", ${CJK_FALLBACK}, serif` },
  { id: 'mono', cssValue: `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", ${CJK_FALLBACK}, monospace` },
  { id: 'rounded', cssValue: `"SF Pro Rounded", -apple-system, "Nunito", ${CJK_FALLBACK}, system-ui, sans-serif` },
  // Other programmer mono — only shown if detected on this machine
  { id: 'fira-code', cssValue: `"Fira Code", "Fira Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Fira Code' },
  { id: 'cascadia', cssValue: `"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Cascadia Code' },
  { id: 'source-code-pro', cssValue: `"Source Code Pro", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Source Code Pro' },
  { id: 'ibm-plex-mono', cssValue: `"IBM Plex Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'IBM Plex Mono' },
  { id: 'hack', cssValue: `Hack, ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Hack' },
  { id: 'iosevka', cssValue: `Iosevka, ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Iosevka' },
  { id: 'inconsolata', cssValue: `Inconsolata, ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Inconsolata' },
  { id: 'roboto-mono', cssValue: `"Roboto Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Roboto Mono' },
  { id: 'ubuntu-mono', cssValue: `"Ubuntu Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Ubuntu Mono' },
  { id: 'menlo', cssValue: `Menlo, ui-monospace, ${CJK_FALLBACK}, monospace`, detectFamily: 'Menlo' },
  { id: 'consolas', cssValue: `Consolas, ui-monospace, ${CJK_FALLBACK}, monospace`, detectFamily: 'Consolas' },
  { id: 'sf-mono', cssValue: `"SF Mono", ui-monospace, ${CJK_FALLBACK}, monospace`, detectFamily: 'SF Mono' },
];

/**
 * Detect whether a specific font family is installed via the `document.fonts`
 * FontFaceSet API. Returns true if the resolved font matches the requested
 * family rather than falling back to a generic. Works in all evergreen
 * browsers; SSR-safe (returns false when `document` is unavailable).
 */
function isFontInstalled(family: string): boolean {
  try {
    if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.check !== 'function') {
      return false;
    }
    return document.fonts.check(`12px "${family}"`);
  } catch {
    return false;
  }
}

/**
 * Build a CSS font-family value for an arbitrary local family name. The
 * picked font sits at the front; CJK fallback keeps Chinese / Japanese /
 * Korean text readable when the user picks a Latin-only family.
 */
function localFamilyToCssValue(family: string): string {
  return `"${family}", ${CJK_FALLBACK}, system-ui`;
}

interface Props {
  prefs: FontPrefs;
  onChange: (next: FontPrefs) => void;
  /** 'compact' shrinks the trigger to fit dense title bars. */
  variant?: 'default' | 'compact';
}

type LocalFontsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'ready'; families: string[] };

export function FontPrefsDropdown({ prefs, onChange, variant = 'default' }: Props) {
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [query, setQuery] = useState('');
  const [localFonts, setLocalFonts] = useState<LocalFontsState>({ kind: 'idle' });
  const wrapRef = useRef<HTMLDivElement>(null);

  // Filter the curated preset list down to families actually installed on
  // this machine. Generic stacks (no detectFamily) are always shown.
  const visibleOptions = useMemo(() => {
    return FAMILY_OPTIONS.filter((opt) => !opt.detectFamily || isFontInstalled(opt.detectFamily));
    // Re-evaluate when the popover opens so newly-loaded webfonts are picked up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const localFontsSupported = useMemo(() => typeof window !== 'undefined' && 'queryLocalFonts' in window, []);

  // Close on outside click / Escape. Only attached while open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setShowMore(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showMore) setShowMore(false);
        else setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, showMore]);

  const compact = variant === 'compact';
  const btnSize = compact ? 22 : 26;

  const triggerStyle = {
    width: btnSize,
    height: btnSize,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: open ? '#334155' : 'transparent',
    border: `1px solid ${open ? '#475569' : 'transparent'}`,
    borderRadius: 6,
    color: '#cbd5e1',
    cursor: 'pointer',
    fontSize: compact ? 11 : 12,
    fontWeight: 600,
    fontFamily: 'system-ui',
    lineHeight: 1,
    padding: 0,
    transition: 'background 0.12s, border-color 0.12s',
    flexShrink: 0,
  } as const;

  const popStyle = {
    position: 'absolute' as const,
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 80,
    width: 252,
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  } as const;

  const familyGridStyle = {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
  } as const;

  const familyBtnStyle = (selected: boolean, cssValue: string) => ({
    width: 30,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: selected ? '#1d4ed8' : '#0f172a',
    border: `1px solid ${selected ? '#3b82f6' : '#334155'}`,
    borderRadius: 6,
    color: selected ? '#fff' : '#e2e8f0',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1,
    padding: 0,
    fontFamily: cssValue,
    transition: 'background 0.1s, border-color 0.1s',
  } as const);

  const moreBtnStyle = (active: boolean) => ({
    width: 30,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: active ? '#1d4ed8' : '#0f172a',
    border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
    borderRadius: 6,
    color: active ? '#fff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 700,
    fontFamily: 'system-ui',
    lineHeight: 1,
    padding: 0,
  } as const);

  const sizeRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  } as const;

  const sizeBtnStyle = (disabled: boolean) => ({
    width: 30,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f172a',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 16,
    fontFamily: 'system-ui',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    padding: 0,
    lineHeight: 1,
  } as const);

  const sizeReadoutStyle = {
    minWidth: 36,
    textAlign: 'center' as const,
    fontVariantNumeric: 'tabular-nums' as const,
    fontSize: 12,
    fontFamily: 'system-ui',
    color: '#cbd5e1',
  } as const;

  const setSize = (delta: number) => {
    const next = clampSize(prefs.size + delta);
    if (next !== prefs.size) onChange({ ...prefs, size: next });
  };

  const pickFamily = (cssValue: string) => {
    if (cssValue !== prefs.family) onChange({ ...prefs, family: cssValue });
  };

  const onMoreClick = async () => {
    setShowMore((v) => !v);
    if (!localFontsSupported) {
      setLocalFonts({ kind: 'unsupported' });
      return;
    }
    if (localFonts.kind === 'idle') {
      setLocalFonts({ kind: 'loading' });
      try {
        // Local Font Access API — Chromium-only at time of writing.
        const data: Array<{ family: string }> = await (window as unknown as { queryLocalFonts: () => Promise<Array<{ family: string }>> }).queryLocalFonts();
        const families = Array.from(new Set(data.map((f) => f.family))).filter(Boolean).sort((a, b) => a.localeCompare(b));
        setLocalFonts({ kind: 'ready', families });
      } catch {
        // User dismissed permission prompt or denied access.
        setLocalFonts({ kind: 'denied' });
      }
    }
  };

  const filteredFamilies = useMemo(() => {
    if (localFonts.kind !== 'ready') return [];
    const q = query.trim().toLowerCase();
    if (!q) return localFonts.families;
    return localFonts.families.filter((f) => f.toLowerCase().includes(q));
  }, [localFonts, query]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label="Aa"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        style={triggerStyle}
      >
        Aa
      </button>
      {open && (
        <div style={popStyle} role="dialog" aria-label="Aa">
          <div style={familyGridStyle}>
            {visibleOptions.map((opt) => {
              const selected = prefs.family === opt.cssValue;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => pickFamily(opt.cssValue)}
                  style={familyBtnStyle(selected, opt.cssValue)}
                  aria-pressed={selected}
                  aria-label={opt.id}
                  title={opt.detectFamily ?? opt.id}
                >
                  Aa
                </button>
              );
            })}
            <button
              type="button"
              onClick={onMoreClick}
              style={moreBtnStyle(showMore)}
              aria-pressed={showMore}
              aria-label="more"
              title="more"
            >
              …
            </button>
          </div>
          {showMore && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                borderTop: '1px solid #334155',
                paddingTop: 8,
              }}
            >
              {localFonts.kind === 'ready' && (
                <input
                  type="text"
                  value={query}
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                  placeholder="🔍"
                  aria-label="search"
                  style={{
                    width: '100%',
                    padding: '5px 8px',
                    background: '#0f172a',
                    color: '#e2e8f0',
                    border: '1px solid #334155',
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: 'system-ui',
                    boxSizing: 'border-box',
                  }}
                />
              )}
              {localFonts.kind === 'loading' && (
                <div style={{ textAlign: 'center', color: '#64748b', fontSize: 18, padding: 12, fontFamily: 'system-ui' }}>…</div>
              )}
              {(localFonts.kind === 'unsupported' || localFonts.kind === 'denied') && (
                <div
                  style={{ textAlign: 'center', color: '#64748b', fontSize: 18, padding: 12, fontFamily: 'system-ui' }}
                  aria-label={localFonts.kind === 'unsupported' ? 'browser does not support local fonts' : 'permission denied'}
                  title={localFonts.kind === 'unsupported' ? 'queryLocalFonts is not supported in this browser' : 'Permission to enumerate local fonts was denied'}
                >
                  ⚠
                </div>
              )}
              {localFonts.kind === 'ready' && (
                <div
                  style={{
                    maxHeight: 220,
                    overflowY: 'auto',
                    border: '1px solid #334155',
                    borderRadius: 6,
                    background: '#0f172a',
                  }}
                >
                  {filteredFamilies.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#64748b', fontSize: 18, padding: 12 }}>∅</div>
                  ) : (
                    filteredFamilies.map((family) => {
                      const cssValue = localFamilyToCssValue(family);
                      const selected = prefs.family === cssValue;
                      return (
                        <button
                          key={family}
                          type="button"
                          onClick={() => pickFamily(cssValue)}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '6px 10px',
                            background: selected ? '#1d4ed8' : 'transparent',
                            border: 'none',
                            borderBottom: '1px solid #1e293b',
                            color: selected ? '#fff' : '#e2e8f0',
                            cursor: 'pointer',
                            fontSize: 13,
                            fontFamily: cssValue,
                            textAlign: 'left',
                            lineHeight: 1.3,
                          }}
                          aria-pressed={selected}
                          title={family}
                        >
                          {family}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
          <div style={sizeRowStyle}>
            <button
              type="button"
              onClick={() => setSize(-1)}
              disabled={prefs.size <= MIN_SIZE}
              aria-label="−"
              style={sizeBtnStyle(prefs.size <= MIN_SIZE)}
            >
              −
            </button>
            <div style={sizeReadoutStyle}>{prefs.size}</div>
            <button
              type="button"
              onClick={() => setSize(1)}
              disabled={prefs.size >= MAX_SIZE}
              aria-label="+"
              style={sizeBtnStyle(prefs.size >= MAX_SIZE)}
            >
              +
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
