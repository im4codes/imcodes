/**
 * FontPrefsDropdown — icon-only chat font customization control.
 *
 * Trigger: a small "Aa" button. Popover shows
 *   • a Code / CJK segmented switch for independent font selection
 *   • a "…" button that triggers the Local Font Access API for the full
 *     installed-font list when the browser supports it
 *   • a − / + size adjuster
 *
 * Changes are real-time and broadcast across the page so every <ChatView>
 * instance updates simultaneously (custom-event bus +
 * `storage` event for cross-tab). Preferences are persisted per-machine
 * via localStorage under `imcodes_fontPrefs:<scope>`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

export interface FontPrefs {
  family: string;
  cjkFamily?: string;
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

const DEFAULT_CJK_FAMILY = CJK_FALLBACK;

function cjkStack(primary: string): string {
  return `"${primary}", ${CJK_FALLBACK}`;
}

const GENERIC_FONT_FAMILIES = new Set(['monospace', 'sans-serif', 'serif', 'cursive', 'fantasy', 'system-ui', 'ui-monospace']);
const CJK_FONT_FAMILIES = new Set([
  'pingfang sc',
  'pingfang tc',
  'microsoft yahei',
  'microsoft jhenghei',
  'hiragino sans gb',
  'hiragino sans',
  'yu gothic',
  'apple sd gothic neo',
  'malgun gothic',
  'noto sans cjk sc',
  'source han sans sc',
  'sarasa mono sc',
  'lxgw wenkai',
  'songti sc',
  'simsun',
]);

interface CJKFamilyOption {
  id: string;
  name: string;
  cssValue: string;
}

const CJK_OPTIONS: readonly CJKFamilyOption[] = [
  { id: 'system-cjk', name: 'System CJK', cssValue: DEFAULT_CJK_FAMILY },
  { id: 'pingfang-sc', name: 'PingFang SC', cssValue: cjkStack('PingFang SC') },
  { id: 'microsoft-yahei', name: 'Microsoft YaHei', cssValue: cjkStack('Microsoft YaHei') },
  { id: 'noto-sans-cjk-sc', name: 'Noto Sans CJK SC', cssValue: cjkStack('Noto Sans CJK SC') },
  { id: 'source-han-sans-sc', name: 'Source Han Sans SC', cssValue: cjkStack('Source Han Sans SC') },
  { id: 'sarasa-mono-sc', name: 'Sarasa Mono SC', cssValue: cjkStack('Sarasa Mono SC') },
  { id: 'lxgw-wenkai', name: 'LXGW WenKai', cssValue: cjkStack('LXGW WenKai') },
  { id: 'songti-sc', name: 'Songti SC', cssValue: cjkStack('Songti SC') },
  { id: 'simsun', name: 'SimSun', cssValue: cjkStack('SimSun') },
];

/**
 * Default chat font. JetBrains Mono is bundled as a webfont (see
 * `web/src/main.tsx`) so it is always available regardless of the user's
 * installed system fonts. CJK characters fall back through the
 * `CJK_FALLBACK` stack, then the last-resort `monospace`.
 */
export const DEFAULT_CHAT_FONT: FontPrefs = {
  family: `"JetBrains Mono", "JetBrains Mono NL", ui-monospace, Menlo, Consolas, ${DEFAULT_CJK_FAMILY}, monospace`,
  cjkFamily: DEFAULT_CJK_FAMILY,
  size: 14,
};

const MIN_SIZE = 10;
const MAX_SIZE = 24;

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CHAT_FONT.size;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(n)));
}

function splitFontFamilyStack(family: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of family) {
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      current += ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      current += ch;
      continue;
    }
    if (ch === ',' && !quote) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function normalizeFontFamilyName(part: string): string {
  return part.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function stripKnownCJKFamilies(family: string): string {
  return splitFontFamilyStack(family)
    .filter((part) => !CJK_FONT_FAMILIES.has(normalizeFontFamilyName(part)))
    .join(', ');
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
 * Idempotent: any CJK fallback that we previously inserted is stripped
 * first, then the currently selected CJK stack is inserted again. This
 * keeps later CJK changes effective instead of leaving the first fallback
 * stuck in front forever.
 */
function buildFontFamily(baseFamily: string, cjkFamily = DEFAULT_CJK_FAMILY): string {
  const parts = splitFontFamilyStack(stripKnownCJKFamilies(baseFamily));
  if (parts.length === 0) return `${cjkFamily}, monospace`;
  const last = parts[parts.length - 1];
  if (parts.length === 1 && last && GENERIC_FONT_FAMILIES.has(normalizeFontFamilyName(last))) {
    return `${last}, ${cjkFamily}`;
  }
  if (last && GENERIC_FONT_FAMILIES.has(normalizeFontFamilyName(last))) {
    return [...parts.slice(0, -1), cjkFamily, last].join(', ');
  }
  return [...parts, cjkFamily].join(', ');
}

function ensureCJKFallback(family: string, cjkFamily = DEFAULT_CJK_FAMILY): string {
  return buildFontFamily(family, cjkFamily);
}

function inferCJKFamily(family: string): string | undefined {
  let best: { index: number; cssValue: string } | undefined;
  for (const opt of CJK_OPTIONS) {
    if (opt.id === 'system-cjk') continue;
    const index = family.indexOf(`"${opt.name}"`);
    if (index < 0) continue;
    if (!best || index < best.index) best = { index, cssValue: opt.cssValue };
  }
  return best?.cssValue;
}

export function readFontPrefs(scope: string, defaults: FontPrefs): FontPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_PREFIX + scope) : null;
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<FontPrefs>;
    const rawFamily = typeof parsed.family === 'string' && parsed.family.length > 0 ? parsed.family : defaults.family;
    const cjkFamily = typeof parsed.cjkFamily === 'string' && parsed.cjkFamily.length > 0
      ? parsed.cjkFamily
      : inferCJKFamily(rawFamily) ?? defaults.cjkFamily ?? DEFAULT_CJK_FAMILY;
    return {
      family: ensureCJKFallback(rawFamily, cjkFamily),
      cjkFamily,
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
    const cjkFamily = next.cjkFamily ?? inferCJKFamily(next.family) ?? defaultsRef.current.cjkFamily ?? DEFAULT_CJK_FAMILY;
    const safe: FontPrefs = { family: next.family, cjkFamily, size: clampSize(next.size) };
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
 * Curated cross-platform code/Latin font stacks.
 *
 * Categories first (always shown), then well-known programmer-friendly
 * monospace families that we only show when actually installed on this
 * machine (avoids dead buttons that all render in the same fallback). Each
 * stack ends with a sensible generic family.
 *
 * Programmer mono families chosen for ubiquity:
 *   JetBrains Mono, Cascadia Mono, Fira Code, Cascadia Code, Source Code Pro,
 *   IBM Plex Mono, Hack, Iosevka, Inconsolata, Roboto Mono, Ubuntu Mono,
 *   Menlo (mac default), Consolas (Windows default), SF Mono.
 */
const FAMILY_OPTIONS: readonly FontFamilyOption[] = [
  // JetBrains Mono — bundled webfont, default. Always shown.
  { id: 'jetbrains-mono', name: 'JetBrains Mono', cssValue: `"JetBrains Mono", "JetBrains Mono NL", ui-monospace, Menlo, Consolas, monospace` },
  // Cascadia Mono — bundled webfont. Always shown.
  { id: 'cascadia-mono', name: 'Cascadia Mono', cssValue: `"Cascadia Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace` },
  // Generic categories — always available
  { id: 'system', name: 'System', cssValue: 'system-ui' },
  { id: 'sans', name: 'Sans', cssValue: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` },
  { id: 'serif', name: 'Serif', cssValue: `Georgia, "Times New Roman", serif` },
  { id: 'mono', name: 'Mono', cssValue: `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` },
  { id: 'rounded', name: 'Rounded', cssValue: `"SF Pro Rounded", -apple-system, "Nunito", system-ui, sans-serif` },
  // Other programmer mono — only shown if detected on this machine
  { id: 'fira-code', name: 'Fira Code', cssValue: `"Fira Code", "Fira Mono", ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Fira Code' },
  { id: 'cascadia', name: 'Cascadia Code', cssValue: `"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Cascadia Code' },
  { id: 'source-code-pro', name: 'Source Code Pro', cssValue: `"Source Code Pro", ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Source Code Pro' },
  { id: 'ibm-plex-mono', name: 'IBM Plex Mono', cssValue: `"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'IBM Plex Mono' },
  { id: 'hack', name: 'Hack', cssValue: `Hack, ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Hack' },
  { id: 'iosevka', name: 'Iosevka', cssValue: `Iosevka, ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Iosevka' },
  { id: 'inconsolata', name: 'Inconsolata', cssValue: `Inconsolata, ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Inconsolata' },
  { id: 'roboto-mono', name: 'Roboto Mono', cssValue: `"Roboto Mono", ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Roboto Mono' },
  { id: 'ubuntu-mono', name: 'Ubuntu Mono', cssValue: `"Ubuntu Mono", ui-monospace, Menlo, Consolas, monospace`, detectFamily: 'Ubuntu Mono' },
  { id: 'menlo', name: 'Menlo', cssValue: `Menlo, ui-monospace, monospace`, detectFamily: 'Menlo' },
  { id: 'consolas', name: 'Consolas', cssValue: `Consolas, ui-monospace, monospace`, detectFamily: 'Consolas' },
  { id: 'sf-mono', name: 'SF Mono', cssValue: `"SF Mono", ui-monospace, monospace`, detectFamily: 'SF Mono' },
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
  return `"${family}", system-ui`;
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

type FontTab = 'code' | 'cjk';

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
  const [activeTab, setActiveTab] = useState<FontTab>('code');
  const [localFonts, setLocalFonts] = useState<LocalFontsState>({ kind: 'idle' });
  const wrapRef = useRef<HTMLDivElement>(null);
  const suppressNextSizeClickRef = useRef(false);
  const lastSelectEventRef = useRef('');

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

  const tabRowStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 4,
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 7,
    padding: 3,
  } as const;

  const tabButtonStyle = (active: boolean) => ({
    height: 24,
    border: 'none',
    borderRadius: 5,
    background: active ? '#334155' : 'transparent',
    color: active ? '#f8fafc' : '#94a3b8',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'system-ui',
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
  } as const);

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
    fontFamily: activeTab === 'code' ? prefs.family : `${prefs.cjkFamily ?? DEFAULT_CJK_FAMILY}, system-ui, sans-serif`,
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

  const previewStyle = {
    padding: '5px 7px',
    background: '#0f172a',
    color: '#cbd5e1',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.35,
    fontFamily: prefs.family,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as const;

  const setSize = useCallback((delta: number) => {
    const next = clampSize(prefs.size + delta);
    if (next !== prefs.size) onChange({ ...prefs, size: next });
  }, [onChange, prefs]);

  const handleSizePointerDown = useCallback((delta: number) => (e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    suppressNextSizeClickRef.current = true;
    setSize(delta);
    window.setTimeout(() => { suppressNextSizeClickRef.current = false; }, 0);
  }, [setSize]);

  const handleSizeClick = useCallback((delta: number) => (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (suppressNextSizeClickRef.current) return;
    setSize(delta);
  }, [setSize]);

  const handleSizeKeyDown = useCallback((delta: number) => (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    setSize(delta);
  }, [setSize]);

  const pickCodeFamily = (cssValue: string) => {
    const cjkFamily = prefs.cjkFamily ?? DEFAULT_CJK_FAMILY;
    const nextFamily = buildFontFamily(cssValue, cjkFamily);
    if (nextFamily !== prefs.family) onChange({ ...prefs, family: nextFamily, cjkFamily });
  };

  const pickCJKFamily = (cssValue: string) => {
    const nextFamily = buildFontFamily(codeSelectValue, cssValue);
    if (nextFamily !== prefs.family || cssValue !== prefs.cjkFamily) {
      onChange({ ...prefs, family: nextFamily, cjkFamily: cssValue });
    }
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
  const codeSelectValue = useMemo(() => {
    const primary = extractPrimaryFamily(prefs.family);
    const match = visibleOptions.find((o) => extractPrimaryFamily(o.cssValue) === primary);
    if (match) return match.cssValue;
    if (localFonts.kind === 'ready') {
      const local = localFonts.families.find((f) => f === primary);
      if (local) return localFamilyToCssValue(local);
    }
    return prefs.family;
  }, [prefs.family, visibleOptions, localFonts]);

  const codeIsOrphan = useMemo(() => {
    return !visibleOptions.some((o) => o.cssValue === codeSelectValue)
      && !(localFonts.kind === 'ready' && localFonts.families.some((f) => localFamilyToCssValue(f) === codeSelectValue));
  }, [codeSelectValue, visibleOptions, localFonts]);

  const cjkSelectValue = prefs.cjkFamily ?? DEFAULT_CJK_FAMILY;
  const cjkIsOrphan = useMemo(() => {
    return !CJK_OPTIONS.some((o) => o.cssValue === cjkSelectValue);
  }, [cjkSelectValue]);

  const handleSelectChange = (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    const eventKey = `${activeTab}:${v}`;
    if (lastSelectEventRef.current === eventKey) return;
    lastSelectEventRef.current = eventKey;
    window.setTimeout(() => {
      if (lastSelectEventRef.current === eventKey) lastSelectEventRef.current = '';
    }, 0);
    if (activeTab === 'cjk') {
      pickCJKFamily(v);
      return;
    }
    if (v === SENTINEL_LOAD_LOCAL) {
      void loadLocalFonts();
      return;
    }
    pickCodeFamily(v);
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
              onPointerDown={handleSizePointerDown(-1)}
              onClick={handleSizeClick(-1)}
              onKeyDown={handleSizeKeyDown(-1)}
              disabled={prefs.size <= MIN_SIZE}
              aria-label="−"
              style={sizeBtnStyle(prefs.size <= MIN_SIZE)}
            >
              −
            </button>
            <div style={sizeReadoutStyle}>{prefs.size}</div>
            <button
              type="button"
              onPointerDown={handleSizePointerDown(1)}
              onClick={handleSizeClick(1)}
              onKeyDown={handleSizeKeyDown(1)}
              disabled={prefs.size >= MAX_SIZE}
              aria-label="+"
              style={sizeBtnStyle(prefs.size >= MAX_SIZE)}
            >
              +
            </button>
          </div>
          <div style={tabRowStyle} role="tablist" aria-label="font type">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'code'}
              onClick={() => setActiveTab('code')}
              style={tabButtonStyle(activeTab === 'code')}
            >
              Code
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'cjk'}
              onClick={() => setActiveTab('cjk')}
              style={tabButtonStyle(activeTab === 'cjk')}
            >
              CJK
            </button>
          </div>
          {/* Row 3 — native <select> showing font names. Native selects
              give us free scrolling, OS-native pickers on mobile (which
              are touch-optimized), and built-in keyboard navigation —
              far more usable than the previous wrap-grid of "Aa" tiles
              once the preset list grew past a handful of entries.
              Wrapped so the custom ▾ chevron sits on the right edge as
              an unmistakable dropdown affordance. */}
          <div style={selectWrapStyle}>
          <select
            value={activeTab === 'code' ? codeSelectValue : cjkSelectValue}
            onInput={handleSelectChange}
            onChange={handleSelectChange}
            style={selectStyle}
            aria-label={activeTab === 'code' ? 'font family' : 'CJK font'}
          >
            {activeTab === 'code' ? (
              <>
                {visibleOptions.map((opt) => (
                  <option key={opt.id} value={opt.cssValue} style={{ fontFamily: buildFontFamily(opt.cssValue, cjkSelectValue) }}>
                    {opt.name}
                  </option>
                ))}
                {/* Stored value isn't a known preset or local family — surface
                    it explicitly so the select stays "controlled" and the
                    user can still see what they have selected. */}
                {codeIsOrphan && (
                  <option value={codeSelectValue} style={{ fontFamily: buildFontFamily(codeSelectValue, cjkSelectValue) }}>
                    {extractPrimaryFamily(codeSelectValue)}
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
                        <option key={family} value={cv} style={{ fontFamily: buildFontFamily(cv, cjkSelectValue) }}>
                          {family}
                        </option>
                      );
                    })}
                  </optgroup>
                )}
              </>
            ) : (
              <>
                {CJK_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.cssValue} style={{ fontFamily: `${opt.cssValue}, system-ui, sans-serif` }}>
                    {opt.name}
                  </option>
                ))}
                {cjkIsOrphan && (
                  <option value={cjkSelectValue} style={{ fontFamily: `${cjkSelectValue}, system-ui, sans-serif` }}>
                    {extractPrimaryFamily(cjkSelectValue)}
                  </option>
                )}
              </>
            )}
          </select>
          {/* Custom dropdown chevron — `pointer-events: none` so taps fall
              through to the underlying <select>, opening the native picker
              on mobile and the dropdown on desktop. */}
          <span style={chevronStyle} aria-hidden="true">▾</span>
          </div>
          <div style={previewStyle}>Aa 123 const text = "你好世界";</div>
        </div>
      )}
    </div>
  );
}
