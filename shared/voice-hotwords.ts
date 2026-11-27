/**
 * Voice hotwords normalization, budgeting, and deterministic sub-millisecond
 * post-processing shared across Web, Server, and PC App.
 */

export const VOICE_HOTWORDS_MAX_TERMS = 60;
export const VOICE_HOTWORDS_MAX_TERM_CHARS = 64;
export const VOICE_HOTWORDS_MAX_CONTEXT_CHARS = 1000;
export const VOICE_HOTWORDS_MAX_ALIASES = 60;

export const VOICE_HOTWORDS_API_PATH = '/api/voice-hotwords' as const;
export const VOICE_HOTWORDS_PREF_KEY = 'voice_hotwords_v1' as const;
export const VOICE_HOTWORDS_MAX_RAW_CHARS = 8192;
export const VOICE_HOTWORDS_MAX_ENTRIES = 200;
export const VOICE_HOTWORDS_MAX_PROJECT_KEY_CHARS = 256;
export const VOICE_HOTWORDS_MAX_PROJECTS = 100;
export const VOICE_HOTWORDS_MAX_STORAGE_BYTES = 60 * 1024;
export const VOICE_HOTWORDS_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const VOICE_HOTWORDS_CAPACITY_ERRORS = Object.freeze({
  TOO_MANY_PROJECTS: 'too_many_projects',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
} as const);

export const VOICE_HOTWORDS_MCP_TOOLS = Object.freeze({
  GET: 'voice_hotwords_get',
  SET: 'voice_hotwords_set',
} as const);
export type VoiceHotwordsMcpToolName = typeof VOICE_HOTWORDS_MCP_TOOLS[keyof typeof VOICE_HOTWORDS_MCP_TOOLS];
export const VOICE_HOTWORDS_MCP_TOOL_NAME_LIST: readonly VoiceHotwordsMcpToolName[] = Object.freeze([
  VOICE_HOTWORDS_MCP_TOOLS.GET,
  VOICE_HOTWORDS_MCP_TOOLS.SET,
]);

export type VoiceHotwordsSource = 'web' | 'mcp';

export interface VoiceHotwordsScopeState {
  raw: string;
  updatedAt: number;
  source?: VoiceHotwordsSource;
  lastWriteId?: string;
}

export interface VoiceHotwordsShareState {
  enabled: boolean;
  updatedAt: number;
  lastWriteId?: string;
}

export interface VoiceHotwordsSyncRecord {
  version: 1;
  user: VoiceHotwordsScopeState;
  projects: Record<string, VoiceHotwordsScopeState>;
  shareWithOthers: VoiceHotwordsShareState;
}

export interface VoiceHotwordsScopePatch {
  raw: string;
  mode?: 'replace' | 'merge';
  clientUpdatedAt?: number;
  baseUpdatedAt?: number;
  writeId?: string;
}

export interface VoiceHotwordsProjectPatch extends VoiceHotwordsScopePatch {
  projectKey: string;
}

export interface VoiceHotwordsSharePatch {
  enabled: boolean;
  clientUpdatedAt?: number;
  baseUpdatedAt?: number;
  writeId?: string;
}

export interface VoiceHotwordsPutRequest {
  scope?: 'user' | 'project' | 'share' | 'sync';
  raw?: string;
  entries?: string[];
  mode?: 'replace' | 'merge';
  clientUpdatedAt?: number;
  baseUpdatedAt?: number;
  writeId?: string;
  projectKey?: string;
  serverId?: string;
  projectName?: string;
  enabled?: boolean;
  user?: VoiceHotwordsScopePatch;
  project?: VoiceHotwordsProjectPatch;
  projects?: Record<string, VoiceHotwordsScopePatch>;
  shareWithOthers?: VoiceHotwordsSharePatch;
}

export interface VoiceHotwordsAppliedScopes {
  user?: boolean;
  projects?: Record<string, boolean>;
  shareWithOthers?: boolean;
}

export interface VoiceHotwordsGetResponse {
  record: VoiceHotwordsSyncRecord;
  projectKey?: string;
  project?: VoiceHotwordsScopeState;
  compiled?: CompiledVoiceHotwords;
}

export interface VoiceHotwordsPutResponse {
  ok: true;
  record: VoiceHotwordsSyncRecord;
  applied?: boolean;
  appliedScopes?: VoiceHotwordsAppliedScopes;
  projectKey?: string;
  project?: VoiceHotwordsScopeState;
  compiled?: CompiledVoiceHotwords;
}

export interface VoiceHotwordProjectRef {
  serverId?: string | null;
  projectName?: string | null;
}

export type VoiceHotwordProjectInput = string | VoiceHotwordProjectRef | null | undefined;

export interface VoiceHotwordReplacement {
  from: string;
  to: string;
}

export interface CompiledVoiceHotwords {
  terms: string[];
  asrTerms: string[];
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

  const asrTerms: string[] = [...terms];
  const seenAsrKeys = new Set<string>(seenTerms);
  let asrContextLength = contextLength;

  for (const alias of replacements) {
    if (asrTerms.length >= VOICE_HOTWORDS_MAX_TERMS) break;
    const key = termDedupeKey(alias.from);
    if (seenAsrKeys.has(key)) continue;
    const sepLen = asrTerms.length === 0 ? 0 : 2;
    if (asrContextLength + sepLen + alias.from.length > VOICE_HOTWORDS_MAX_CONTEXT_CHARS) continue;
    seenAsrKeys.add(key);
    asrTerms.push(alias.from);
    asrContextLength += sepLen + alias.from.length;
  }

  return {
    terms,
    asrTerms,
    contextText: asrTerms.join(', '),
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

const SCOPED_PROJECT_PREFIX = 'srv:';
const SCOPED_PROJECT_SEP = '::';
const ASCII_CONTROL_TEST_RE = /[\u0000-\u001F\u007F]/;
const RAW_NON_NEWLINE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

/**
 * Encode a raw `(projectName, serverId)` pair into a storage `projectKey`.
 * Whenever `serverId` is provided, it is ALWAYS bound even if `projectName`
 * starts with a `srv:...::...` literal substring.
 */
export function encodeVoiceHotwordProjectKey(
  projectName: string | null | undefined,
  serverId?: string | null,
): string | null {
  if (typeof projectName !== 'string') return null;
  const trimmedName = projectName.trim();
  if (!trimmedName) return null;
  const cleanServer = typeof serverId === 'string' ? serverId.trim() : '';
  if (!cleanServer) return trimmedName;
  return `${SCOPED_PROJECT_PREFIX}${encodeURIComponent(cleanServer)}${SCOPED_PROJECT_SEP}${trimmedName}`;
}

export function decodeVoiceHotwordProjectKey(
  rawKey: string | null | undefined,
): { serverId: string | null; projectName: string } | null {
  if (typeof rawKey !== 'string') return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(SCOPED_PROJECT_PREFIX)) {
    const sepIdx = trimmed.indexOf(SCOPED_PROJECT_SEP, SCOPED_PROJECT_PREFIX.length);
    if (sepIdx > SCOPED_PROJECT_PREFIX.length) {
      const encodedServer = trimmed.slice(SCOPED_PROJECT_PREFIX.length, sepIdx);
      const projectName = trimmed.slice(sepIdx + SCOPED_PROJECT_SEP.length).trim();
      if (projectName) {
        try {
          return { serverId: decodeURIComponent(encodedServer), projectName };
        } catch {
          return { serverId: encodedServer, projectName };
        }
      }
    }
  }
  return { serverId: null, projectName: trimmed };
}

/**
 * Normalize an already-encoded stored `projectKey` string or a `{ projectName, serverId }` reference.
 * String inputs preserve pre-encoded `srv:<encodedServer>::<projectName>` keys and legacy unscoped keys;
 * object inputs always bind `serverId` via {@link encodeVoiceHotwordProjectKey}.
 */
export function normalizeVoiceHotwordProjectKey(projectInput: VoiceHotwordProjectInput): string | null {
  if (!projectInput) return null;
  if (typeof projectInput !== 'string') {
    return encodeVoiceHotwordProjectKey(projectInput.projectName, projectInput.serverId);
  }
  const trimmed = projectInput.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(SCOPED_PROJECT_PREFIX)) {
    const sepIdx = trimmed.indexOf(SCOPED_PROJECT_SEP, SCOPED_PROJECT_PREFIX.length);
    if (sepIdx > SCOPED_PROJECT_PREFIX.length) {
      const rawServer = trimmed.slice(SCOPED_PROJECT_PREFIX.length, sepIdx);
      const innerProject = trimmed.slice(sepIdx + SCOPED_PROJECT_SEP.length).trim();
      if (!innerProject) return null;
      let decodedServer = rawServer;
      try {
        decodedServer = decodeURIComponent(rawServer);
      } catch {
        decodedServer = rawServer;
      }
      return encodeVoiceHotwordProjectKey(innerProject, decodedServer);
    }
  }
  return trimmed;
}

export function isValidVoiceHotwordProjectKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return false;
  if (trimmed.length > VOICE_HOTWORDS_MAX_PROJECT_KEY_CHARS) return false;
  if (ASCII_CONTROL_TEST_RE.test(trimmed)) return false;
  return normalizeVoiceHotwordProjectKey(trimmed) === trimmed;
}

/** Normalize line endings and strip unsafe non-newline ASCII control chars. */
export function normalizeVoiceHotwordRawText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(RAW_NON_NEWLINE_CONTROL_RE, '');
  if (!cleaned.trim()) return '';
  return cleaned;
}

function lineDedupeKey(trimmedLine: string): string | null {
  const alias = parseAliasParts(trimmedLine);
  if (alias) {
    return `alias:${termDedupeKey(alias.from)}=>${termDedupeKey(alias.to)}`;
  }
  const term = sanitizeVoiceHotwordText(trimmedLine, VOICE_HOTWORDS_MAX_TERM_CHARS);
  return term ? `term:${termDedupeKey(term)}` : null;
}

/** Append non-duplicate lines from `incomingRaw` after `existingRaw` while preserving insertion order. */
export function mergeVoiceHotwordRawText(
  existingRaw: string | null | undefined,
  incomingRaw: string | null | undefined,
): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of [existingRaw, incomingRaw]) {
    const normalized = normalizeVoiceHotwordRawText(chunk);
    if (!normalized) continue;
    for (const rawLine of normalized.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const key = lineDedupeKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out.join('\n');
}

export function createNullProtoDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function hasOwnDictKey(obj: unknown, key: string): boolean {
  return Boolean(obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key));
}

export function getOwnDictValue<T>(obj: Record<string, T> | null | undefined, key: string): T | undefined {
  return hasOwnDictKey(obj, key) ? obj![key] : undefined;
}

export function setOwnDictValue<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function deleteOwnDictKey(obj: Record<string, unknown>, key: string): void {
  if (hasOwnDictKey(obj, key)) {
    delete obj[key];
  }
}

export function entriesToVoiceHotwordRawText(entries: readonly string[]): string {
  const lines: string[] = [];
  for (const item of entries) {
    const cleaned = normalizeVoiceHotwordRawText(item)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    lines.push(...cleaned);
  }
  return lines.join('\n');
}

export function createEmptyVoiceHotwordsSyncRecord(): VoiceHotwordsSyncRecord {
  return {
    version: 1,
    user: { raw: '', updatedAt: 0 },
    projects: createNullProtoDict<VoiceHotwordsScopeState>(),
    shareWithOthers: { enabled: false, updatedAt: 0 },
  };
}

function coerceTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function coerceSource(value: unknown): VoiceHotwordsSource | undefined {
  return value === 'web' || value === 'mcp' ? value : undefined;
}

function coerceWriteId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || ASCII_CONTROL_TEST_RE.test(trimmed)) return undefined;
  return trimmed;
}

function coerceScopeState(value: unknown): VoiceHotwordsScopeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { raw: '', updatedAt: 0 };
  }
  const obj = value as Record<string, unknown>;
  const raw = normalizeVoiceHotwordRawText(obj.raw);
  const updatedAt = coerceTimestamp(obj.updatedAt);
  const source = coerceSource(obj.source);
  const lastWriteId = coerceWriteId(obj.lastWriteId);
  return {
    raw,
    updatedAt,
    ...(source ? { source } : {}),
    ...(lastWriteId ? { lastWriteId } : {}),
  };
}

export function coerceVoiceHotwordsSyncRecord(input: unknown): VoiceHotwordsSyncRecord {
  const empty = createEmptyVoiceHotwordsSyncRecord();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return empty;
  }
  const obj = input as Record<string, unknown>;
  const projects = createNullProtoDict<VoiceHotwordsScopeState>();
  if (obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects)) {
    for (const [key, val] of Object.entries(obj.projects as Record<string, unknown>)) {
      const cleanKey = normalizeVoiceHotwordProjectKey(key);
      if (!cleanKey || !isValidVoiceHotwordProjectKey(cleanKey)) continue;
      setOwnDictValue(projects, cleanKey, coerceScopeState(val));
    }
  }
  const shareObj = obj.shareWithOthers && typeof obj.shareWithOthers === 'object' && !Array.isArray(obj.shareWithOthers)
    ? obj.shareWithOthers as Record<string, unknown>
    : null;
  const shareWriteId = coerceWriteId(shareObj?.lastWriteId);
  return {
    version: 1,
    user: coerceScopeState(obj.user),
    projects,
    shareWithOthers: {
      enabled: shareObj?.enabled === true,
      updatedAt: coerceTimestamp(shareObj?.updatedAt),
      ...(shareWriteId ? { lastWriteId: shareWriteId } : {}),
    },
  };
}

/**
 * Tombstone-preserving project budget check: never evicts empty tombstones so deleted
 * projects cannot be resurrected by reconnecting offline clients; rejects new keys when full.
 */
export function canStoreVoiceHotwordProjectKey(
  projects: Record<string, VoiceHotwordsScopeState>,
  projectKey: string,
  maxProjects: number = VOICE_HOTWORDS_MAX_PROJECTS,
): boolean {
  if (hasOwnDictKey(projects, projectKey)) return true;
  return Object.keys(projects).length < maxProjects;
}

const HOTWORD_HALLUCINATION_SEP_CHAR_RE = /^[\s\p{P}\p{Z}\u2026\u2022\u00B7~`+=|<>$¥€£°^]$/u;
const PCM16_SPEECH_PEAK_THRESHOLD = 0.015;
const PCM16_SPEECH_WINDOW_RMS_THRESHOLD = 0.005;
const PCM16_SPEECH_WINDOW_RMS_SQ = PCM16_SPEECH_WINDOW_RMS_THRESHOLD * PCM16_SPEECH_WINDOW_RMS_THRESHOLD;
const HALLUCINATION_INF = 0x3fffffff;
const HALLUCINATION_ARRAY_CACHE_LIMIT = 32;

interface HallucinationTrieNode {
  children: Map<number, HallucinationTrieNode>;
  termId: number;
}

interface CompiledHallucinationMatcher {
  root: HallucinationTrieNode;
  termStrings: string[];
  termStartsAscii: Uint8Array;
  termEndsAscii: Uint8Array;
}

const compiledHallucinationCache = new WeakMap<object, CompiledHallucinationMatcher | null>();
const rawArrayHallucinationCache = new Map<string, CompiledHallucinationMatcher | null>();

function normalizeHotwordMatchText(raw: string): string {
  // Fold fullwidth ASCII/punctuation variants (e.g. ．-> ., ＩＭ -> IM) and typographic dashes/quotes.
  return raw
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\uFF61/g, '.')
    .toLowerCase();
}

function buildHallucinationMatcherFromRawList(rawList: readonly string[]): CompiledHallucinationMatcher | null {
  const seen = new Set<string>();
  const uniqueTerms: string[] = [];
  for (const raw of rawList) {
    const clean = sanitizeVoiceHotwordText(raw, VOICE_HOTWORDS_MAX_TERM_CHARS);
    if (!clean) continue;
    const normalized = normalizeHotwordMatchText(clean);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueTerms.push(normalized);
  }
  if (uniqueTerms.length === 0) return null;

  const root: HallucinationTrieNode = { children: new Map(), termId: -1 };
  const termStartsAscii = new Uint8Array(uniqueTerms.length);
  const termEndsAscii = new Uint8Array(uniqueTerms.length);

  for (let termId = 0; termId < uniqueTerms.length; termId += 1) {
    const term = uniqueTerms[termId]!;
    termStartsAscii[termId] = ASCII_ALNUM_UNDER_RE.test(term[0]!) ? 1 : 0;
    termEndsAscii[termId] = ASCII_ALNUM_UNDER_RE.test(term[term.length - 1]!) ? 1 : 0;
    let node = root;
    for (let i = 0; i < term.length; i += 1) {
      const code = term.charCodeAt(i);
      let child = node.children.get(code);
      if (!child) {
        child = { children: new Map(), termId: -1 };
        node.children.set(code, child);
      }
      node = child;
    }
    node.termId = termId;
  }

  return {
    root,
    termStrings: uniqueTerms,
    termStartsAscii,
    termEndsAscii,
  };
}

function getCompiledHallucinationMatcher(
  hotwords: Pick<CompiledVoiceHotwords, 'terms' | 'asrTerms' | 'replacements'> | readonly string[],
): CompiledHallucinationMatcher | null {
  if (!Array.isArray(hotwords)) {
    const cached = compiledHallucinationCache.get(hotwords);
    if (cached !== undefined) return cached;
    const compiled = hotwords as Pick<CompiledVoiceHotwords, 'terms' | 'asrTerms' | 'replacements'>;
    const matcher = buildHallucinationMatcherFromRawList([
      ...(compiled.terms ?? []),
      ...(compiled.asrTerms ?? []),
      ...(compiled.replacements ?? []).flatMap((r) => [r.from, r.to]),
    ]);
    compiledHallucinationCache.set(hotwords, matcher);
    return matcher;
  }

  if (hotwords.length === 0) return null;
  const cacheKey = hotwords.join('\u0000');
  const cached = rawArrayHallucinationCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const matcher = buildHallucinationMatcherFromRawList(hotwords);
  if (rawArrayHallucinationCache.size >= HALLUCINATION_ARRAY_CACHE_LIMIT) {
    const oldestKey = rawArrayHallucinationCache.keys().next().value;
    if (oldestKey !== undefined) rawArrayHallucinationCache.delete(oldestKey);
  }
  rawArrayHallucinationCache.set(cacheKey, matcher);
  return matcher;
}

/**
 * Strip generative-ASR prompt-echo hallucinations where the transcript consists
 * exclusively of configured hotwords plus whitespace/punctuation (e.g. `"IM.codes，IM.codes。IM.codes，IM.codes。"`).
 * Normal speech containing non-hotword words is never altered; a single isolated
 * hotword is stripped only when `options.silentAudio === true`.
 */
export function stripVoiceHotwordHallucination(
  text: string,
  hotwords: Pick<CompiledVoiceHotwords, 'terms' | 'asrTerms' | 'replacements'> | readonly string[] | null | undefined,
  options?: { silentAudio?: boolean },
): string {
  if (!text || !hotwords) return text;
  const matcher = getCompiledHallucinationMatcher(hotwords);
  if (!matcher) return text;

  const normText = normalizeHotwordMatchText(text);
  const n = normText.length;
  if (n === 0) return text;

  // Forward reachable-state DP over a compact Trie:
  // - `cleared[pos]`: min hotword count at start-of-string, after a separator, or after a non-ASCII-word ending.
  // - `endedAscii[pos]`: min hotword count immediately after an ASCII-word-ending hotword without separator.
  const cleared = new Int32Array(n + 1);
  const endedAscii = new Int32Array(n + 1);
  cleared.fill(HALLUCINATION_INF);
  endedAscii.fill(HALLUCINATION_INF);
  cleared[0] = 0;

  for (let pos = 0; pos < n; pos += 1) {
    const cCount = cleared[pos]!;
    const aCount = endedAscii[pos]!;
    if (cCount === HALLUCINATION_INF && aCount === HALLUCINATION_INF) continue;

    const cp = normText.codePointAt(pos)!;
    const charStr = String.fromCodePoint(cp);
    const charLen = cp > 0xffff ? 2 : 1;
    const bestAtPos = cCount < aCount ? cCount : aCount;

    if (HOTWORD_HALLUCINATION_SEP_CHAR_RE.test(charStr)) {
      const nextPos = pos + charLen;
      if (bestAtPos < cleared[nextPos]!) {
        cleared[nextPos] = bestAtPos;
      }
    }

    let node: HallucinationTrieNode | undefined = matcher.root;
    for (let p = pos; p < n; p += 1) {
      node = node.children.get(normText.charCodeAt(p));
      if (!node) break;
      const termId = node.termId;
      if (termId < 0) continue;

      const startCost = matcher.termStartsAscii[termId]! ? cCount : bestAtPos;
      if (startCost >= HALLUCINATION_INF) continue;

      const endPos = p + 1;
      const nextCost = startCost + 1;
      if (!matcher.termEndsAscii[termId]! || endPos === n) {
        if (nextCost < cleared[endPos]!) cleared[endPos] = nextCost;
      } else {
        if (nextCost < endedAscii[endPos]!) endedAscii[endPos] = nextCost;
        // Allow immediate back-to-back repetition of the exact same hotword (e.g. "IM.codesIM.codes")
        // while still blocking distinct ASCII hotwords merged into a real compound word (e.g. "worktree").
        const termStr = matcher.termStrings[termId]!;
        let repPos = endPos;
        let repCost = nextCost;
        while (repPos + termStr.length <= n && normText.startsWith(termStr, repPos)) {
          repPos += termStr.length;
          repCost += 1;
          if (repPos === n) {
            if (repCost < cleared[repPos]!) cleared[repPos] = repCost;
          } else if (repCost < endedAscii[repPos]!) {
            endedAscii[repPos] = repCost;
          }
        }
      }
    }
  }

  const minMatches = cleared[n]! < endedAscii[n]! ? cleared[n]! : endedAscii[n]!;
  if (minMatches >= HALLUCINATION_INF) return text;
  if (minMatches >= 2) return '';
  if (minMatches === 1 && options?.silentAudio === true) return '';
  return text;
}

/**
 * Lightweight silence gate for little-endian signed 16-bit mono PCM audio.
 * Returns `true` if peak amplitude `>= 0.015` or any 50ms window RMS `>= 0.005`.
 */
export function hasPcm16SpeechEnergy(
  pcmBuffer: Uint8Array,
  sampleRate: number = 16_000,
): boolean {
  if (!pcmBuffer || pcmBuffer.byteLength < 2) return false;
  const sampleCount = Math.floor(pcmBuffer.byteLength / 2);
  if (sampleCount <= 0) return false;

  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16_000;
  const windowSamples = Math.max(1, Math.round(rate * 0.05));

  let windowSumSq = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const byteOffset = i * 2;
    const raw = pcmBuffer[byteOffset]! | (pcmBuffer[byteOffset + 1]! << 8);
    const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
    const sample = signed / 32768;
    if (Math.abs(sample) >= PCM16_SPEECH_PEAK_THRESHOLD) {
      return true;
    }

    windowSumSq += sample * sample;
    if (i >= windowSamples) {
      const oldOffset = (i - windowSamples) * 2;
      const oldRaw = pcmBuffer[oldOffset]! | (pcmBuffer[oldOffset + 1]! << 8);
      const oldSigned = oldRaw >= 0x8000 ? oldRaw - 0x10000 : oldRaw;
      const oldSample = oldSigned / 32768;
      windowSumSq -= oldSample * oldSample;
      if (windowSumSq < 0) windowSumSq = 0;
    }
    if (i + 1 >= windowSamples && windowSumSq / windowSamples >= PCM16_SPEECH_WINDOW_RMS_SQ) {
      return true;
    }
  }

  if (sampleCount < windowSamples && windowSumSq / sampleCount >= PCM16_SPEECH_WINDOW_RMS_SQ) {
    return true;
  }
  return false;
}
