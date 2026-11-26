import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LocaleDefaultServerRule {
  url: string;
  locales: string[];
  label?: string;
}

export interface PcAppBuildConfig {
  localeDefaultServers: LocaleDefaultServerRule[];
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUILD_CONFIG_PATH = resolve(THIS_DIR, '..', 'build-config.json');
const PRIMARY_DEFAULT_SERVER_ORIGIN = 'https://app.im.codes';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const ZH_TRADITIONAL_REGIONS = new Set(['tw', 'hk', 'mo']);
const ZH_SIMPLIFIED_REGIONS = new Set(['cn']);

let cachedDefaultConfig: PcAppBuildConfig | null = null;

function normalizeOrigin(raw: unknown): string | null {
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
  if (parsed.origin === PRIMARY_DEFAULT_SERVER_ORIGIN) return null;
  return parsed.origin;
}

function normalizeTagParts(tag: unknown): string[] {
  if (typeof tag !== 'string') return [];
  return tag.trim().toLowerCase().replace(/_/gu, '-').split('-').filter(Boolean);
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

function sanitizeBuildConfigRules(rawRules: unknown): LocaleDefaultServerRule[] {
  if (!Array.isArray(rawRules)) return [];
  const seen = new Set<string>();
  const out: LocaleDefaultServerRule[] = [];
  for (const item of rawRules) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { url?: unknown; locales?: unknown; label?: unknown };
    const url = normalizeOrigin(rec.url);
    if (!url || seen.has(url)) continue;
    const locales = Array.isArray(rec.locales)
      ? rec.locales
        .map((entry) => normalizeTagParts(entry).join('-'))
        .filter(Boolean)
      : [];
    if (locales.length === 0) continue;
    seen.add(url);
    const label = typeof rec.label === 'string' && rec.label.trim()
      ? rec.label.trim().slice(0, 80)
      : undefined;
    out.push({
      url,
      locales: [...new Set(locales)],
      ...(label ? { label } : {}),
    });
  }
  return out;
}

export function loadPcAppBuildConfig(filePathOverride?: string): PcAppBuildConfig {
  if (!filePathOverride && cachedDefaultConfig) {
    return cachedDefaultConfig;
  }
  const targetPath = filePathOverride ?? DEFAULT_BUILD_CONFIG_PATH;
  let config: PcAppBuildConfig = { localeDefaultServers: [] };
  try {
    if (existsSync(targetPath)) {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as { localeDefaultServers?: unknown };
      if (parsed && typeof parsed === 'object') {
        config = { localeDefaultServers: sanitizeBuildConfigRules(parsed.localeDefaultServers) };
      }
    }
  } catch {
    config = { localeDefaultServers: [] };
  }
  if (!filePathOverride) {
    cachedDefaultConfig = config;
  }
  return config;
}

export function resetPcAppBuildConfigCacheForTests(): void {
  cachedDefaultConfig = null;
}

export function resolveLocaleDefaultServersForPcApp(
  rules: readonly LocaleDefaultServerRule[],
  locale: string | null | undefined,
): LocaleDefaultServerRule[] {
  const seen = new Set<string>();
  const matched: LocaleDefaultServerRule[] = [];
  for (const rule of rules) {
    const url = normalizeOrigin(rule?.url);
    if (!url || seen.has(url)) continue;
    if (!Array.isArray(rule.locales) || !localeMatchesRule(locale, rule.locales)) continue;
    seen.add(url);
    matched.push({
      url,
      locales: [...rule.locales],
      ...(rule.label ? { label: rule.label } : {}),
    });
  }
  return matched;
}
