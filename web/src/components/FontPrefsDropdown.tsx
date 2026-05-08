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
  /** Display name shown in the dropdown — typography terms or brand names. */
  name: string;
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
  { id: 'jetbrains-mono', name: 'JetBrains Mono', cssValue: `"JetBrains Mono", "JetBrains Mono NL", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace` },
  // Generic categories — always available
  { id: 'system', name: 'System', cssValue: 'system-ui' },
  { id: 'sans', name: 'Sans', cssValue: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ${CJK_FALLBACK}, "Helvetica Neue", Arial, sans-serif` },
  { id: 'serif', name: 'Serif', cssValue: `Georgia, "Times New Roman", "Songti SC", "STSong", "SimSun", ${CJK_FALLBACK}, serif` },
  { id: 'mono', name: 'Mono', cssValue: `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", ${CJK_FALLBACK}, monospace` },
  { id: 'rounded', name: 'Rounded', cssValue: `"SF Pro Rounded", -apple-system, "Nunito", ${CJK_FALLBACK}, system-ui, sans-serif` },
  // Other programmer mono — only shown if detected on this machine
  { id: 'fira-code', name: 'Fira Code', cssValue: `"Fira Code", "Fira Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Fira Code' },
  { id: 'cascadia', name: 'Cascadia Code', cssValue: `"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Cascadia Code' },
  { id: 'source-code-pro', name: 'Source Code Pro', cssValue: `"Source Code Pro", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Source Code Pro' },
  { id: 'ibm-plex-mono', name: 'IBM Plex Mono', cssValue: `"IBM Plex Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'IBM Plex Mono' },
  { id: 'hack', name: 'Hack', cssValue: `Hack, ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Hack' },
  { id: 'iosevka', name: 'Iosevka', cssValue: `Iosevka, ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Iosevka' },
  { id: 'inconsolata', name: 'Inconsolata', cssValue: `Inconsolata, ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Inconsolata' },
  { id: 'roboto-mono', name: 'Roboto Mono', cssValue: `"Roboto Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Roboto Mono' },
  { id: 'ubuntu-mono', name: 'Ubuntu Mono', cssValue: `"Ubuntu Mono", ui-monospace, Menlo, Consolas, ${CJK_FALLBACK}, monospace`, detectFamily: 'Ubuntu Mono' },
  { id: 'menlo', name: 'Menlo', cssValue: `Menlo, ui-monospace, ${CJK_FALLBACK}, monospace`, detectFamily: 'Menlo' },
  { id: 'consolas', name: 'Consolas', cssValue: `Consolas, ui-monospace, ${CJK_FALLBACK}, monospace`, detectFamily: 'Consolas' },
  { id: 'sf-mono', name: 'SF Mono', cssValue: `"SF Mono", ui-monospace, ${CJK_FALLBACK}, monospace`, detectFamily: 'SF Mono' },
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

/** Sentinel value for the "load local fonts" entry inside the <select>. */
const SENTINEL_LOAD_LOCAL = '__load_local__';

/**
 * Extract the primary (first quoted) family from a CSS font-family stack
 * for display purposes when the stored value doesn't match any preset.
 */
function extractPrimaryFamily(css: string): string {
  const m = css.match(/^\s*"?([^",]+?)"?\s*(?:,|$)/);
  return m ? m[1].trim() : css;
}

export function FontPrefsDropdown({ prefs, onChange, variant = 'default' }: Props) {
  const [open, setOpen] = useState(false);
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
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
    // Anchor to the trigger's left edge — the trigger sits on the left side
    // of the chat title bar, so a left-anchored popover stays on screen and
    // reads naturally left-to-right on both desktop and mobile.
    left: 0,
    zIndex: 80,
    width: 220,
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  } as const;

  const sizeRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  } as const;

  const selectWrapStyle = {
    position: 'relative' as const,
    width: '100%',
  } as const;

  const selectStyle = {
    width: '100%',
    // Right padding leaves room for the custom ▾ chevron. The native
    // arrow is suppressed via `appearance: none` (and the vendor
    // prefixes for older Safari / Firefox) so the only arrow visible
    // is the one we draw, guaranteeing the dropdown affordance reads
    // the same on every browser and OS.
    padding: '6px 26px 6px 8px',
    background: '#0f172a',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 13,
    // Render the select itself in the currently-chosen font so the user
    // gets an immediate preview of their selection as the menu collapses.
    fontFamily: prefs.family,
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
    MozAppearance: 'none' as const,
  } as const;

  const chevronStyle = {
    position: 'absolute' as const,
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none' as const,
    color: '#94a3b8',
    fontSize: 10,
    fontFamily: 'system-ui',
    lineHeight: 1,
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

  const loadLocalFonts = async () => {
    if (!localFontsSupported) {
      setLocalFonts({ kind: 'unsupported' });
      return;
    }
    if (localFonts.kind !== 'idle') return;
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
  };

  // Resolve the select's bound value to a known option's cssValue when the
  // stored prefs.family differs slightly (e.g., older saves migrated by
  // ensureCJKFallback). Falls back to the stored value so the orphan
  // <option> can still hold the selection.
  const selectValue = useMemo(() => {
    const primary = extractPrimaryFamily(prefs.family);
    const match = visibleOptions.find((o) => extractPrimaryFamily(o.cssValue) === primary);
    if (match) return match.cssValue;
    if (localFonts.kind === 'ready') {
      const local = localFonts.families.find((f) => f === primary);
      if (local) return localFamilyToCssValue(local);
    }
    return prefs.family;
  }, [prefs.family, visibleOptions, localFonts]);

  const isOrphan = useMemo(() => {
    return !visibleOptions.some((o) => o.cssValue === selectValue)
      && !(localFonts.kind === 'ready' && localFonts.families.some((f) => localFamilyToCssValue(f) === selectValue));
  }, [selectValue, visibleOptions, localFonts]);

  const handleSelectChange = (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === SENTINEL_LOAD_LOCAL) {
      void loadLocalFonts();
      return;
    }
    pickFamily(v);
  };

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
        <div style={popStyle} role="dialog" aria-label="font">
          {/* Row 1 — size adjuster (− current +). Always first so the most
              common adjustment is the closest to the trigger. */}
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
          {/* Row 2 — native <select> showing font names. Native selects
              give us free scrolling, OS-native pickers on mobile (which
              are touch-optimized), and built-in keyboard navigation —
              far more usable than the previous wrap-grid of "Aa" tiles
              once the preset list grew past a handful of entries.
              Wrapped so the custom ▾ chevron sits on the right edge as
              an unmistakable dropdown affordance. */}
          <div style={selectWrapStyle}>
          <select
            value={selectValue}
            onChange={handleSelectChange}
            style={selectStyle}
            aria-label="font family"
          >
            {visibleOptions.map((opt) => (
              <option key={opt.id} value={opt.cssValue} style={{ fontFamily: opt.cssValue }}>
                {opt.name}
              </option>
            ))}
            {/* Stored value isn't a known preset or local family — surface
                it explicitly so the select stays "controlled" and the
                user can still see what they have selected. */}
            {isOrphan && (
              <option value={selectValue} style={{ fontFamily: selectValue }}>
                {extractPrimaryFamily(selectValue)}
              </option>
            )}
            {/* Local-font enumeration is opt-in: the user must pick the
                "…" entry to trigger the browser permission prompt. We
                avoid prompting on mount so casual users aren't surprised. */}
            {localFontsSupported && localFonts.kind === 'idle' && (
              // Picking this entry invokes queryLocalFonts (separate
              // permission prompt). The label is intentionally just an
              // ellipsis — language-neutral and consistent with the
              // icon-only aesthetic of the rest of the control.
              <option value={SENTINEL_LOAD_LOCAL}>…</option>
            )}
            {localFonts.kind === 'loading' && (
              <option disabled>…</option>
            )}
            {(localFonts.kind === 'unsupported' || localFonts.kind === 'denied') && (
              <option disabled>⚠</option>
            )}
            {localFonts.kind === 'ready' && localFonts.families.length > 0 && (
              <optgroup label="…">
                {localFonts.families.map((family) => {
                  const cv = localFamilyToCssValue(family);
                  return (
                    <option key={family} value={cv} style={{ fontFamily: cv }}>
                      {family}
                    </option>
                  );
                })}
              </optgroup>
            )}
          </select>
          {/* Custom dropdown chevron — `pointer-events: none` so taps fall
              through to the underlying <select>, opening the native picker
              on mobile and the dropdown on desktop. */}
          <span style={chevronStyle} aria-hidden="true">▾</span>
          </div>
        </div>
      )}
    </div>
  );
}
