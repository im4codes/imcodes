/**
 * Voice hotwords normalization, budgeting, and deterministic sub-millisecond
 * post-processing shared across Web, Server, and PC App.
 */

export const VOICE_HOTWORDS_MAX_TERMS = 60;
export const VOICE_HOTWORDS_MAX_TERM_CHARS = 64;
export const VOICE_HOTWORDS_MAX_CONTEXT_CHARS = 1000;
export const VOICE_HOTWORDS_MAX_ALIASES = 60;

export interface VoiceHotwordReplacement {
  from: string;
  to: string;
}

export interface CompiledVoiceHotwords {
  terms: string[];
  contextText: string;
  replacements: VoiceHotwordReplacement[];
}

export interface MergeVoiceHotwordsInput {
  projectRaw?: string | null;
  globalRaw?: string | null;
}

interface InternalRule {
  from: string;
  to: string;
  asciiBoundary: boolean;
  keyLower: string;
}

interface CompiledMatcher {
  regex: RegExp | null;
  rulesByLower: Map<string, InternalRule[]>;
}

const ASCII_CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const WHITESPACE_RUN_RE = /\s+/g;
const ALIAS_LINE_RE = /^(.+?)\s*(?:=>|->)\s*(.+)$/;
const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;
const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_/@:-]/;
const ASCII_RIGHT_BOUNDARY_RE = /[A-Za-z0-9_/@-]/;
const ASCII_ALNUM_UNDER_RE = /[A-Za-z0-9_]/;
const URL_SPAN_RE = /https?:\/\/[^\s"'<>()[\]]+/gi;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

const matcherCache = new WeakMap<object, CompiledMatcher>();

function escapeRegExp(literal: string): string {
  return literal.replace(REGEX_META_RE, '\\$&');
}

function isAsciiHotwordToken(value: string): boolean {
  return ASCII_PRINTABLE_RE.test(value);
}

function termDedupeKey(term: string): string {
  return isAsciiHotwordToken(term) ? term.toLowerCase() : term;
}

/** Strip ASCII control characters, collapse whitespace runs, trim, and bound to `maxChars`. */
export function sanitizeVoiceHotwordText(
  raw: unknown,
  maxChars: number = VOICE_HOTWORDS_MAX_TERM_CHARS,
): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(ASCII_CONTROL_RE, ' ')
    .replace(WHITESPACE_RUN_RE, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trim();
}

/** Parse multi-line hotwords text supporting plain terms and `misheard => target` / `->` aliases. */
export function parseVoiceHotwordsInput(raw: string | null | undefined): {
  terms: string[];
  replacements: VoiceHotwordReplacement[];
} {
  const { entries } = parseVoiceHotwordLines(raw);
  const terms: string[] = [];
  const replacements: VoiceHotwordReplacement[] = [];

  for (const entry of entries) {
    if (entry.kind === 'alias') {
      terms.push(entry.to);
      if (entry.from !== entry.to) {
        replacements.push({ from: entry.from, to: entry.to });
      }
    } else {
      terms.push(entry.term);
    }
  }

  return { terms, replacements };
}

type ParsedHotwordEntry =
  | { kind: 'term'; term: string }
  | { kind: 'alias'; from: string; to: string };

function parseVoiceHotwordLines(raw: string | null | undefined): { entries: ParsedHotwordEntry[] } {
  if (typeof raw !== 'string' || !raw) {
    return { entries: [] };
  }
  const entries: ParsedHotwordEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const aliasMatch = ALIAS_LINE_RE.exec(trimmedLine);
    if (aliasMatch) {
      const from = sanitizeVoiceHotwordText(aliasMatch[1], VOICE_HOTWORDS_MAX_TERM_CHARS);
      const to = sanitizeVoiceHotwordText(aliasMatch[2], VOICE_HOTWORDS_MAX_TERM_CHARS);
      if (from && to) {
        entries.push({ kind: 'alias', from, to });
        continue;
      }
    }

    const term = sanitizeVoiceHotwordText(trimmedLine, VOICE_HOTWORDS_MAX_TERM_CHARS);
    if (term) {
      entries.push({ kind: 'term', term });
    }
  }
  return { entries };
}

/** Join terms within both max term count and max total context character budget. */
export function formatVoiceHotwordsContext(
  terms: readonly string[],
  maxChars: number = VOICE_HOTWORDS_MAX_CONTEXT_CHARS,
  maxTerms: number = VOICE_HOTWORDS_MAX_TERMS,
): string {
  if (!Array.isArray(terms) || terms.length === 0) return '';
  const kept: string[] = [];
  let totalLen = 0;

  for (const rawTerm of terms) {
    if (kept.length >= maxTerms) break;
    const term = sanitizeVoiceHotwordText(rawTerm, VOICE_HOTWORDS_MAX_TERM_CHARS);
    if (!term) continue;
    const sepLen = kept.length === 0 ? 0 : 2; // ', '
    if (totalLen + sepLen + term.length > maxChars) break;
    kept.push(term);
    totalLen += sepLen + term.length;
  }

  return kept.join(', ');
}

/** Validate and normalize an incoming wire `hotwords` array for `voice.session.start`. */
export function sanitizeRemoteVoiceHotwords(
  raw: unknown,
): { ok: true; hotwords: string[] | undefined } | { ok: false; message: string } {
  if (raw === undefined) {
    return { ok: true, hotwords: undefined };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'Invalid hotwords' };
  }

  const out: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, message: 'Invalid hotwords' };
    }
    if (out.length >= VOICE_HOTWORDS_MAX_TERMS) continue;
    const clean = sanitizeVoiceHotwordText(item, VOICE_HOTWORDS_MAX_TERM_CHARS);
    if (!clean) continue;
    const key = termDedupeKey(clean);
    if (seen.has(key)) continue;
    const sepLen = out.length === 0 ? 0 : 2;
    if (totalChars + sepLen + clean.length > VOICE_HOTWORDS_MAX_CONTEXT_CHARS) continue;
    seen.add(key);
    out.push(clean);
    totalChars += sepLen + clean.length;
  }

  return { ok: true, hotwords: out.length > 0 ? out : undefined };
}

/** Merge project-scoped (priority) and global hotwords, deduplicated and capped to budgets. */
export function mergeVoiceHotwords(input: MergeVoiceHotwordsInput): CompiledVoiceHotwords {
  const projectEntries = parseVoiceHotwordLines(input.projectRaw).entries;
  const globalEntries = parseVoiceHotwordLines(input.globalRaw).entries;

  const terms: string[] = [];
  const seenTerms = new Set<string>();
  const replacements: VoiceHotwordReplacement[] = [];
  const seenAliases = new Set<string>();
  let contextLength = 0;

  const pushTerm = (rawTerm: string) => {
    if (terms.length >= VOICE_HOTWORDS_MAX_TERMS) return;
    const key = termDedupeKey(rawTerm);
    if (seenTerms.has(key)) return;
    const sepLen = terms.length === 0 ? 0 : 2;
    if (contextLength + sepLen + rawTerm.length > VOICE_HOTWORDS_MAX_CONTEXT_CHARS) return;
    seenTerms.add(key);
    terms.push(rawTerm);
    contextLength += sepLen + rawTerm.length;
  };

  for (const entry of [...projectEntries, ...globalEntries]) {
    if (entry.kind === 'term') {
      pushTerm(entry.term);
      continue;
    }
    const aliasKey = termDedupeKey(entry.from);
    if (seenAliases.has(aliasKey)) continue;
    seenAliases.add(aliasKey);
    pushTerm(entry.to);
    if (entry.from !== entry.to && replacements.length < VOICE_HOTWORDS_MAX_ALIASES) {
      replacements.push({ from: entry.from, to: entry.to });
    }
  }

  return {
    terms,
    contextText: terms.join(', '),
    replacements,
  };
}

function buildCompiledMatcher(compiled: Pick<CompiledVoiceHotwords, 'terms' | 'replacements'>): CompiledMatcher {
  const cached = matcherCache.get(compiled);
  if (cached) return cached;

  const rules: InternalRule[] = [];
  const coveredFromKeys = new Set<string>();

  for (const alias of compiled.replacements ?? []) {
    const from = sanitizeVoiceHotwordText(alias.from, VOICE_HOTWORDS_MAX_TERM_CHARS);
    const to = sanitizeVoiceHotwordText(alias.to, VOICE_HOTWORDS_MAX_TERM_CHARS);
    if (!from || !to) continue;
    const keyLower = from.toLowerCase();
    const asciiBoundary = isAsciiHotwordToken(from);
    coveredFromKeys.add(asciiBoundary ? keyLower : from);
    rules.push({ from, to, asciiBoundary, keyLower });
  }

  for (const rawTerm of compiled.terms ?? []) {
    const term = sanitizeVoiceHotwordText(rawTerm, VOICE_HOTWORDS_MAX_TERM_CHARS);
    if (!term || !isAsciiHotwordToken(term) || !/[A-Za-z]/.test(term)) continue;
    const keyLower = term.toLowerCase();
    if (coveredFromKeys.has(keyLower)) continue;
    coveredFromKeys.add(keyLower);
    rules.push({ from: term, to: term, asciiBoundary: true, keyLower });
  }

  if (rules.length === 0) {
    const empty: CompiledMatcher = { regex: null, rulesByLower: new Map() };
    matcherCache.set(compiled, empty);
    return empty;
  }

  // Sort longest pattern first so multi-word aliases win over single-word prefixes.
  rules.sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from));

  const rulesByLower = new Map<string, InternalRule[]>();
  const uniquePatterns: string[] = [];
  const seenPattern = new Set<string>();

  for (const rule of rules) {
    const list = rulesByLower.get(rule.keyLower);
    if (list) {
      list.push(rule);
    } else {
      rulesByLower.set(rule.keyLower, [rule]);
    }
    if (!seenPattern.has(rule.keyLower)) {
      seenPattern.add(rule.keyLower);
      uniquePatterns.push(escapeRegExp(rule.from));
    }
  }

  const regex = new RegExp(`(?:${uniquePatterns.join('|')})`, 'gi');
  const matcher: CompiledMatcher = { regex, rulesByLower };
  matcherCache.set(compiled, matcher);
  return matcher;
}

function passesAsciiBoundary(text: string, offset: number, length: number): boolean {
  const prev = offset > 0 ? text[offset - 1]! : '';
  const prevPrev = offset > 1 ? text[offset - 2]! : '';
  const end = offset + length;
  const next = end < text.length ? text[end]! : '';
  const nextNext = end + 1 < text.length ? text[end + 1]! : '';

  if (prev && ASCII_WORD_CHAR_RE.test(prev)) return false;
  if (prev === '.' && prevPrev && ASCII_ALNUM_UNDER_RE.test(prevPrev)) return false;
  if (next && ASCII_RIGHT_BOUNDARY_RE.test(next)) return false;
  if (next === '.' && nextNext && ASCII_ALNUM_UNDER_RE.test(nextNext)) return false;
  return true;
}

function collectUrlSpans(text: string): Array<[number, number]> | null {
  if (!text.includes('://')) return null;
  const spans: Array<[number, number]> = [];
  URL_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_SPAN_RE.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans.length > 0 ? spans : null;
}

function isInsideUrlSpan(spans: readonly [number, number][] | null, offset: number, length: number): boolean {
  if (!spans) return false;
  const end = offset + length;
  for (const [start, spanEnd] of spans) {
    if (offset < spanEnd && end > start) return true;
  }
  return false;
}

/**
 * Deterministic sub-millisecond post-processing using compiled project/global hotwords.
 * Applies explicit aliases and ASCII word-boundary case normalization in a single regex pass
 * without modifying URLs or compound code identifiers.
 */
export function applyVoiceHotwordPostProcess(
  text: string,
  compiled: Pick<CompiledVoiceHotwords, 'terms' | 'replacements'> | null | undefined,
): string {
  if (!text || !compiled) return text;
  if ((compiled.terms?.length ?? 0) === 0 && (compiled.replacements?.length ?? 0) === 0) {
    return text;
  }

  const matcher = buildCompiledMatcher(compiled);
  if (!matcher.regex) return text;

  const urlSpans = collectUrlSpans(text);
  matcher.regex.lastIndex = 0;

  return text.replace(matcher.regex, (matched, offset: number, fullText: string) => {
    if (isInsideUrlSpan(urlSpans, offset, matched.length)) {
      return matched;
    }
    const candidates = matcher.rulesByLower.get(matched.toLowerCase());
    if (!candidates || candidates.length === 0) return matched;

    for (const rule of candidates) {
      if (rule.asciiBoundary) {
        if (!passesAsciiBoundary(fullText, offset, matched.length)) continue;
        return matched === rule.to ? matched : rule.to;
      }
      if (matched === rule.from) {
        return rule.to;
      }
    }
    return matched;
  });
}
