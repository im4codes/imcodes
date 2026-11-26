/**
 * Compile-time locale-gated default relay server parser and BCP-47 matcher.
 *
 * Used by:
 *   - web/vite.config.ts (injecting __LOCALE_DEFAULT_SERVERS__ at bundle time)
 *   - apps/pc-app/scripts/write-build-config.mjs (writing dist/build-config.json)
 *   - web/src/native.ts (runtime locale filtering for Web / Capacitor iOS & Android)
 *
 * Keeps only erasable TypeScript syntax so Node.js >=22 can import it directly.
 */

export const PRIMARY_DEFAULT_SERVER_ORIGIN = 'https://app.im.codes';
export const LOCALE_DEFAULT_SERVERS_ENV_VAR = 'IMCODES_LOCALE_DEFAULT_SERVERS';

export interface LocaleDefaultServerRule {
  url: string;
  locales: string[];
  label?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const ZH_TRADITIONAL_REGIONS = new Set(['tw', 'hk', 'mo']);
const ZH_SIMPLIFIED_REGIONS = new Set(['cn']);

export function normalizeDefaultServerOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  const hostname = parsed.hostname.toLowerCase();
  const allowed = parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname));
  if (!allowed) return null;
  const origin = parsed.origin;
  if (origin === PRIMARY_DEFAULT_SERVER_ORIGIN) return null;
  return origin;
}

function sanitizeLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  const trimmed = label.trim();
  return trimmed ? trimmed.slice(0, 80) : undefined;
}

function normalizeTagParts(tag: unknown): string[] {
  if (typeof tag !== 'string') return [];
  return tag.trim().toLowerCase().replace(/_/gu, '-').split('-').filter(Boolean);
}

function normalizeLocalesList(input: unknown): string[] {
  const rawList = typeof input === 'string'
    ? [input]
    : Array.isArray(input)
      ? input
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of rawList) {
    const parts = normalizeTagParts(item);
    if (parts.length === 0) continue;
    const tag = parts.join('-');
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function addOrMergeRule(
  byOrigin: Map<string, LocaleDefaultServerRule>,
  url: string,
  locales: readonly string[],
  label?: string,
): void {
  if (locales.length === 0) return;
  const existing = byOrigin.get(url);
  if (!existing) {
    byOrigin.set(url, {
      url,
      locales: [...locales],
      ...(label ? { label } : {}),
    });
    return;
  }
  const seenLocales = new Set(existing.locales);
  for (const loc of locales) {
    if (!seenLocales.has(loc)) {
      seenLocales.add(loc);
      existing.locales.push(loc);
    }
  }
  if (!existing.label && label) {
    existing.label = label;
  }
}

/**
 * Parse `IMCODES_LOCALE_DEFAULT_SERVERS` from JSON string or pre-parsed value.
 * Supports:
 *   - Array of objects: `[{"url":"https://cn.example.com","locales":["zh"],"label":"..."}]` (`locale` shorthand also accepted)
 *   - Map by locale:    `{"zh":"https://cn.example.com"}` or `{"zh-CN":["https://a.example.com"]}`
 */
export function parseLocaleDefaultServers(
  raw: unknown,
  opts?: { onWarning?: (message: string) => void },
): LocaleDefaultServerRule[] {
  if (raw === undefined || raw === null) return [];

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      opts?.onWarning?.(
        `Invalid ${LOCALE_DEFAULT_SERVERS_ENV_VAR} JSON (${err instanceof Error ? err.message : String(err)}); ignoring.`,
      );
      return [];
    }
  }

  const byOrigin = new Map<string, LocaleDefaultServerRule>();

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { url?: unknown; locales?: unknown; locale?: unknown; label?: unknown };
      const url = normalizeDefaultServerOrigin(entry.url);
      if (!url) continue;
      const locales = normalizeLocalesList([
        ...(Array.isArray(entry.locales) ? entry.locales : typeof entry.locales === 'string' ? [entry.locales] : []),
        ...(Array.isArray(entry.locale) ? entry.locale : typeof entry.locale === 'string' ? [entry.locale] : []),
      ]);
      const label = sanitizeLabel(entry.label);
      addOrMergeRule(byOrigin, url, locales, label);
    }
    return [...byOrigin.values()];
  }

  if (parsed && typeof parsed === 'object') {
    for (const [localeKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const locales = normalizeLocalesList(localeKey);
      if (locales.length === 0) continue;
      const urls = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
      for (const rawUrl of urls) {
        if (typeof rawUrl === 'string') {
          const url = normalizeDefaultServerOrigin(rawUrl);
          if (url) addOrMergeRule(byOrigin, url, locales);
        } else if (rawUrl && typeof rawUrl === 'object') {
          const obj = rawUrl as { url?: unknown; label?: unknown };
          const url = normalizeDefaultServerOrigin(obj.url);
          if (url) addOrMergeRule(byOrigin, url, locales, sanitizeLabel(obj.label));
        }
      }
    }
    return [...byOrigin.values()];
  }

  opts?.onWarning?.(`Unsupported ${LOCALE_DEFAULT_SERVERS_ENV_VAR} structure; expected JSON array or locale map.`);
  return [];
}

export function formatLocaleDefaultServersForBuild(
  raw: unknown,
  opts?: { onWarning?: (message: string) => void },
): LocaleDefaultServerRule[] {
  return parseLocaleDefaultServers(raw, opts);
}

function zhVariantForParts(parts: readonly string[]): 'all' | 'hans' | 'hant' | 'other' {
  const subtags = parts.slice(1);
  if (subtags.length === 0) return 'all';
  if (subtags.includes('hant')) return 'hant';
  if (subtags.includes('hans')) return 'hans';
  for (const sub of subtags) {
    if (ZH_TRADITIONAL_REGIONS.has(sub)) return 'hant';
    if (ZH_SIMPLIFIED_REGIONS.has(sub)) return 'hans';
  }
  return 'other';
}

function singleLocaleMatches(candidateParts: readonly string[], ruleParts: readonly string[]): boolean {
  if (candidateParts.length === 0 || ruleParts.length === 0) return false;
  if (candidateParts[0] !== ruleParts[0]) return false;

  if (ruleParts[0] === 'zh') {
    if (ruleParts.length === 1) return true;
    const ruleVariant = zhVariantForParts(ruleParts);
    if (ruleVariant === 'hans' || ruleVariant === 'hant') {
      return zhVariantForParts(candidateParts) === ruleVariant;
    }
  }

  if (candidateParts.length < ruleParts.length) return false;
  for (let i = 0; i < ruleParts.length; i += 1) {
    if (candidateParts[i] !== ruleParts[i]) return false;
  }
  return true;
}

export function localeMatchesRule(
  locale: string | null | undefined,
  ruleLocales: readonly string[],
): boolean {
  const candidateParts = normalizeTagParts(locale);
  if (candidateParts.length === 0) return false;
  for (const ruleTag of ruleLocales) {
    const ruleParts = normalizeTagParts(ruleTag);
    if (singleLocaleMatches(candidateParts, ruleParts)) return true;
  }
  return false;
}

export function resolveLocaleDefaultServers(
  rules: readonly LocaleDefaultServerRule[],
  locale: string | null | undefined,
): LocaleDefaultServerRule[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const seen = new Set<string>();
  const matched: LocaleDefaultServerRule[] = [];
  for (const rule of rules) {
    const url = normalizeDefaultServerOrigin(rule?.url);
    if (!url || seen.has(url)) continue;
    if (!Array.isArray(rule.locales) || !localeMatchesRule(locale, rule.locales)) continue;
    seen.add(url);
    const label = sanitizeLabel(rule.label);
    matched.push({
      url,
      locales: normalizeLocalesList(rule.locales),
      ...(label ? { label } : {}),
    });
  }
  return matched;
}
