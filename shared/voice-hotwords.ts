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
const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;
const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_/@:-]/;
const ASCII_RIGHT_BOUNDARY_RE = /[A-Za-z0-9_/@-]/;
const ASCII_ALNUM_UNDER_RE = /[A-Za-z0-9_]/;
const URL_CANDIDATE_RE = /(?:https?|wss?|ftp):\/\/[^\s<>"`\u3000]+/gi;
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

function parseAliasParts(line: string): { from: string; to: string } | null {
  const fatIdx = line.indexOf('=>');
  const thinIdx = line.indexOf('->');
  const idx =
    fatIdx >= 0 && thinIdx >= 0
      ? Math.min(fatIdx, thinIdx)
      : Math.max(fatIdx, thinIdx);
  if (idx <= 0) return null;
  const from = sanitizeVoiceHotwordText(line.slice(0, idx), VOICE_HOTWORDS_MAX_TERM_CHARS);
  const to = sanitizeVoiceHotwordText(line.slice(idx + 2), VOICE_HOTWORDS_MAX_TERM_CHARS);
  if (!from || !to) return null;
  return { from, to };
}

function parseVoiceHotwordLines(raw: string | null | undefined): { entries: ParsedHotwordEntry[] } {
  if (typeof raw !== 'string' || !raw) {
    return { entries: [] };
  }
  const entries: ParsedHotwordEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const alias = parseAliasParts(trimmedLine);
    if (alias) {
      entries.push({ kind: 'alias', from: alias.from, to: alias.to });
      continue;
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
  const projectProtectedKeys = new Set<string>();
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

  // Pre-collect all project canonical terms and targets so a later project line or global alias
  // can never overwrite a project canonical spelling via key collision.
  for (const entry of projectEntries) {
    if (entry.kind === 'term') {
      projectProtectedKeys.add(termDedupeKey(entry.term));
    } else {
      projectProtectedKeys.add(termDedupeKey(entry.from));
      projectProtectedKeys.add(termDedupeKey(entry.to));
    }
  }

  for (const entry of projectEntries) {
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

  for (const entry of globalEntries) {
    if (entry.kind === 'term') {
      pushTerm(entry.term);
      continue;
    }
    const aliasKey = termDedupeKey(entry.from);
    if (seenAliases.has(aliasKey) || projectProtectedKeys.has(aliasKey)) continue;
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

const URL_NON_QUOTE_TRAILING_PUNCT_RE = /^[.,;:!?"\u3002\uff0c\u3001\uff1b\uff1a\uff01\uff1f\u201d\u2019\u300b\u300d\u300f\u3011]$/;

function trimMatchedUrlEnd(url: string, wrappedInSingleQuote: boolean): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let unmatchedClose: Set<number> | null = null;
  for (let i = 0; i < url.length; i += 1) {
    const ch = url[i]!;
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      else (unmatchedClose ??= new Set()).add(i);
    } else if (ch === '[') {
      bracketDepth += 1;
    } else if (ch === ']') {
      if (bracketDepth > 0) bracketDepth -= 1;
      else (unmatchedClose ??= new Set()).add(i);
    }
  }

  let end = url.length;
  let pendingSingleQuoteTrim = wrappedInSingleQuote;
  while (end > 0) {
    const idx = end - 1;
    const ch = url[idx]!;
    if (URL_NON_QUOTE_TRAILING_PUNCT_RE.test(ch)) {
      end -= 1;
      continue;
    }
    if (ch === "'" && pendingSingleQuoteTrim) {
      pendingSingleQuoteTrim = false;
      end -= 1;
      continue;
    }
    if ((ch === ')' || ch === ']') && unmatchedClose?.has(idx)) {
      end -= 1;
      continue;
    }
    break;
  }
  return end;
}

function collectUrlSpans(text: string, out: Array<[number, number]>): void {
  if (!text.includes('://')) return;
  URL_CANDIDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_CANDIDATE_RE.exec(text)) !== null) {
    const wrappedInSingleQuote = m.index > 0 && text[m.index - 1] === "'";
    const trimmedLen = trimMatchedUrlEnd(m[0], wrappedInSingleQuote);
    if (trimmedLen > 0) {
      out.push([m.index, m.index + trimmedLen]);
    }
  }
}

function isAtLineFenceStart(text: string, pos: number): boolean {
  let i = pos;
  let spaces = 0;
  while (i > 0 && text[i - 1] !== '\n' && text[i - 1] !== '\r') {
    if (text[i - 1] !== ' ') return false;
    spaces += 1;
    if (spaces > 3) return false;
    i -= 1;
  }
  return true;
}

function isTrailingLineSpaceOnly(text: string, pos: number): boolean {
  for (let i = pos; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '\r') return true;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function collectTildeFenceSpans(text: string, out: Array<[number, number]>): void {
  if (!text.includes('~~~')) return;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '~' && isAtLineFenceStart(text, i)) {
      let len = 0;
      while (i + len < text.length && text[i + len] === '~') len += 1;
      if (len >= 3) {
        const lineEnd = text.indexOf('\n', i + len);
        if (lineEnd === -1) {
          out.push([i, text.length]);
          break;
        }
        let cursor = lineEnd + 1;
        let closedEnd = text.length;
        while (cursor < text.length) {
          const nextNl = text.indexOf('\n', cursor);
          const rowEnd = nextNl === -1 ? text.length : nextNl;
          let p = cursor;
          let sp = 0;
          while (p < rowEnd && text[p] === ' ' && sp < 3) {
            p += 1;
            sp += 1;
          }
          let closeLen = 0;
          while (p + closeLen < rowEnd && text[p + closeLen] === '~') closeLen += 1;
          if (closeLen >= len && isTrailingLineSpaceOnly(text, p + closeLen)) {
            closedEnd = rowEnd;
            break;
          }
          if (nextNl === -1) break;
          cursor = nextNl + 1;
        }
        out.push([i, closedEnd]);
        i = closedEnd;
        continue;
      }
      i += len;
      continue;
    }
    i += 1;
  }
}

function collectBacktickSpans(text: string, out: Array<[number, number]>): void {
  if (!text.includes('`')) return;
  const runs: Array<{ start: number; len: number; lineStart: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const start = i;
      while (i < text.length && text[i] === '`') i += 1;
      runs.push({ start, len: i - start, lineStart: isAtLineFenceStart(text, start) });
    } else {
      i += 1;
    }
  }
  if (runs.length === 0) return;

  // Pre-index run indices by length so inline code matching stays strictly O(N).
  const indicesByLen = new Map<number, number[]>();
  for (let idx = 0; idx < runs.length; idx += 1) {
    const len = runs[idx]!.len;
    const arr = indicesByLen.get(len);
    if (arr) arr.push(idx);
    else indicesByLen.set(len, [idx]);
  }
  const cursorByLen = new Map<number, number>();

  let r = 0;
  while (r < runs.length) {
    const open = runs[r]!;
    if (open.len >= 3 && open.lineStart) {
      let closeIdx = -1;
      for (let j = r + 1; j < runs.length; j += 1) {
        const cand = runs[j]!;
        if (cand.lineStart && cand.len >= open.len && isTrailingLineSpaceOnly(text, cand.start + cand.len)) {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx !== -1) {
        const close = runs[closeIdx]!;
        out.push([open.start, close.start + close.len]);
        r = closeIdx + 1;
        continue;
      }
      out.push([open.start, text.length]);
      break;
    }

    const list = indicesByLen.get(open.len);
    let ptr = cursorByLen.get(open.len) ?? 0;
    while (list && ptr < list.length && list[ptr]! <= r) {
      ptr += 1;
    }
    cursorByLen.set(open.len, ptr);
    if (list && ptr < list.length) {
      const closeIdx = list[ptr]!;
      const close = runs[closeIdx]!;
      out.push([open.start, close.start + close.len]);
      cursorByLen.set(open.len, ptr + 1);
      r = closeIdx + 1;
      continue;
    }

    r += 1;
  }
}

function collectProtectedSpans(text: string): Array<[number, number]> | null {
  const hasUrl = text.includes('://');
  const hasTicks = text.includes('`');
  const hasTilde = text.includes('~~~');
  if (!hasUrl && !hasTicks && !hasTilde) return null;

  const raw: Array<[number, number]> = [];
  if (hasTicks) collectBacktickSpans(text, raw);
  if (hasTilde) collectTildeFenceSpans(text, raw);
  if (hasUrl) collectUrlSpans(text, raw);
  if (raw.length === 0) return null;

  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [raw[0]!];
  for (let i = 1; i < raw.length; i += 1) {
    const [s, e] = raw[i]!;
    const last = merged[merged.length - 1]!;
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function isInsideProtectedSpan(spans: readonly [number, number][] | null, offset: number, length: number): boolean {
  if (!spans) return false;
  const end = offset + length;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, spanEnd] = spans[mid]!;
    if (end <= start) {
      hi = mid - 1;
    } else if (offset >= spanEnd) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Deterministic sub-millisecond post-processing using compiled project/global hotwords.
 * Applies explicit aliases and ASCII word-boundary case normalization in a single regex pass
 * without modifying fenced/inline code, full URLs, or compound code identifiers.
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

  const protectedSpans = collectProtectedSpans(text);
  matcher.regex.lastIndex = 0;

  return text.replace(matcher.regex, (matched, offset: number, fullText: string) => {
    if (isInsideProtectedSpan(protectedSpans, offset, matched.length)) {
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
