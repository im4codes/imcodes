/** Shared parsing contract for file references rendered in chat. */

export interface ChatFileReferenceMatch {
  raw: string;
  path: string;
  start: number;
  end: number;
}

const TRAILING_REFERENCE_PUNCTUATION_RE = /[.,;!?，。；！？、'"“”‘’]+$/u;
const SOURCE_LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

export function isLikelyDomainPath(value: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(value);
}

function stripUnmatchedClosingWrappers(value: string): string {
  const pairs: Array<[string, string]> = [
    ['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['【', '】'], ['《', '》'], ['「', '」'], ['『', '』'],
  ];
  let next = value;
  let changed = true;
  while (changed && next) {
    changed = false;
    for (const [open, close] of pairs) {
      if (!next.endsWith(close)) continue;
      const opens = [...next].filter((char) => char === open).length;
      const closes = [...next].filter((char) => char === close).length;
      if (closes > opens) {
        next = next.slice(0, -close.length);
        changed = true;
      }
    }
  }
  return next;
}

/** Decode a Markdown/file URL destination exactly once at the filesystem boundary. */
export function decodeMarkdownLocalPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localPathFromFileUrl(value: string): string | null {
  if (!/^file:\/\//i.test(value)) return value;
  const rest = value.slice('file://'.length);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (host && host.toLowerCase() !== 'localhost') return null;
  let pathname = slash < 0 ? '' : rest.slice(slash);
  pathname = decodeMarkdownLocalPath(pathname);
  // file:///C:/x is the canonical Windows URL spelling.
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return pathname || null;
}

/** Canonicalize a visible reference without resolving it against a filesystem. */
export function normalizeChatFileReference(input: string): string | null {
  let value = input.trim().replace(/^`+|`+$/g, '').trim();
  if (!value) return null;
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  value = value.replace(/^path\s*:\s*/i, '');
  value = value.replace(TRAILING_REFERENCE_PUNCTUATION_RE, '');
  value = stripUnmatchedClosingWrappers(value);
  value = value.replace(SOURCE_LINE_SUFFIX_RE, '');
  const fromFileUrl = localPathFromFileUrl(value);
  if (fromFileUrl === null) return null;
  value = decodeMarkdownLocalPath(fromFileUrl);
  if (!value) return null;
  // Protocol-relative URLs and UNC shares must never become automatic local
  // file actions: the latter could otherwise trigger a zero-click SMB read.
  if (/^(?:\/\/|\\\\)/.test(value)) return null;
  if (isLikelyDomainPath(value) && /[/\\]/.test(value)) return null;
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)) return null;
  return value;
}

/**
 * Return a stable spelling for a local chat path after it has been resolved
 * against a session workdir.  Chat messages commonly mix `./.hidden/file`,
 * `.hidden/file`, and redundant separators; treating those spellings as
 * different preview targets lets the floating FileBrowser issue overlapping
 * reads for the same file.  Keep the original separator family (Windows
 * callers still receive Windows paths) while folding only lexical `.`/`..`
 * segments and duplicate separators.
 */
export function canonicalizeChatFilePath(input: string): string | null {
  const normalized = normalizeChatFileReference(input);
  if (!normalized) return null;
  // Preserve the established spelling for ordinary paths (notably `./file`),
  // while giving dotfile/dot-directory references one stable lexical form.
  // This keeps existing preview/cache keys compatible and only changes the
  // hidden-path family that needs deduplication.
  if (!normalized.split(/[/\\]+/u).some((part) => part.startsWith('.') && part !== '.' && part !== '..')) {
    return normalized;
  }
  const windows = /^[A-Za-z]:[/\\]/.test(normalized) || normalized.includes('\\');
  const separator = windows ? '\\' : '/';
  const isDrive = /^[A-Za-z]:[/\\]/.test(normalized);
  const isRooted = normalized.startsWith('/') || isDrive || normalized.startsWith('~/');
  const prefix = isDrive
    ? `${normalized.slice(0, 2)}${separator}`
    : normalized.startsWith('/')
      ? separator
      : normalized.startsWith('~/')
        ? `~${separator}`
        : '';
  const body = isDrive
    ? normalized.slice(2)
    : normalized.startsWith('/')
      ? normalized.slice(1)
      : normalized.startsWith('~/')
        ? normalized.slice(2)
        : normalized;
  const parts: string[] = [];
  for (const part of body.split(/[/\\]+/u)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isRooted) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join(separator);
  if (prefix) return `${prefix}${joined}` || prefix;
  return joined || (isRooted ? prefix : normalized);
}

export function chatPathHasFileExtension(path: string): boolean {
  const normalized = normalizeChatFileReference(path);
  if (!normalized) return false;
  const basename = normalized.split(/[/\\]/).pop() ?? '';
  return /\.([\p{L}\p{N}]{1,10})$/u.test(basename);
}

export function isLocalChatPath(path: string): boolean {
  return normalizeChatFileReference(path) !== null;
}

/** Recover a Markdown destination from its exact source spelling. */
export function rawMarkdownDestination(raw: string): string | null {
  const labelStart = raw.startsWith('![') ? 1 : raw.startsWith('[') ? 0 : -1;
  if (labelStart < 0) return null;
  let bracketDepth = 1;
  let labelEnd = -1;
  for (let i = labelStart + 1; i < raw.length; i += 1) {
    if (raw[i] === '\\') { i += 1; continue; }
    if (raw[i] === '[') bracketDepth += 1;
    if (raw[i] === ']' && --bracketDepth === 0) { labelEnd = i; break; }
  }
  if (labelEnd < 0 || raw[labelEnd + 1] !== '(') return null;

  let cursor = labelEnd + 2;
  while (cursor < raw.length && /[ \t]/.test(raw[cursor])) cursor += 1;
  if (raw[cursor] === '<') {
    const start = cursor + 1;
    for (let i = start; i < raw.length; i += 1) if (raw[i] === '>') return raw.slice(start, i);
    return null;
  }

  const start = cursor;
  let parenDepth = 0;
  for (; cursor < raw.length; cursor += 1) {
    const char = raw[cursor];
    if (char === '\\') { cursor += 1; continue; }
    if (char === '(' || char === '（') { parenDepth += 1; continue; }
    if (char === ')' || char === '）') {
      if (parenDepth === 0) return raw.slice(start, cursor);
      parenDepth -= 1;
      continue;
    }
    if (parenDepth === 0 && /[ \t\n\r]/.test(char)) return raw.slice(start, cursor);
  }
  return null;
}

export function markdownLocalPath(raw: string, href: string): string | null {
  const rawPath = rawMarkdownDestination(raw);
  // Never fall back to marked's lossy href when source spelling is available.
  if (rawPath !== null) return normalizeChatFileReference(rawPath);
  return normalizeChatFileReference(href);
}

export function isAbsoluteLocalChatFilePath(destination: string): boolean {
  const normalized = normalizeChatFileReference(destination);
  if (!normalized) return false;
  const absolute = normalized.startsWith('/')
    || normalized.startsWith('~/')
    || /^[A-Za-z]:[/\\]/.test(normalized);
  return absolute && chatPathHasFileExtension(normalized);
}

interface MarkdownLinkMatch {
  destinationStart: number;
  end: number;
  value: string;
}

interface MatchingDelimiters {
  closeBracketByOpen: Map<number, number>;
  closeParenByOpen: Map<number, number>;
}

interface MonotonicCharState {
  pos: number;
  dead: boolean;
}

function findNextCharMonotonic(text: string, needle: string, from: number, state: MonotonicCharState): number {
  if (state.dead) return -1;
  if (state.pos >= from) return state.pos;
  const idx = text.indexOf(needle, from);
  if (idx < 0) {
    state.dead = true;
    return -1;
  }
  state.pos = idx;
  return idx;
}

function findNextLineEndMonotonic(
  text: string,
  from: number,
  lfState: MonotonicCharState,
  crState: MonotonicCharState,
): number {
  const lf = findNextCharMonotonic(text, '\n', from, lfState);
  const cr = findNextCharMonotonic(text, '\r', from, crState);
  if (lf < 0) return cr < 0 ? text.length : cr;
  if (cr < 0) return lf;
  return Math.min(lf, cr);
}

function buildLineParenMap(source: string): Map<number, number> {
  const closeParenByOpen = new Map<number, number>();
  if (!source.includes('](')) return closeParenByOpen;
  const parenStack: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\n' || char === '\r') {
      parenStack.length = 0;
      continue;
    }
    if (char === '\\') {
      if (parenStack.length > 0) i += 1;
      continue;
    }
    if (char === '(' || char === '（') {
      parenStack.push(i);
    } else if ((char === ')' || char === '）') && parenStack.length > 0) {
      closeParenByOpen.set(parenStack.pop()!, i);
    }
  }
  return closeParenByOpen;
}

function buildMatchingDelimiters(source: string): MatchingDelimiters {
  const closeBracketByOpen = new Map<number, number>();
  const bracketStack: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      if (bracketStack.length > 0) i += 1;
      continue;
    }
    if (char === '[') {
      bracketStack.push(i);
    } else if (char === ']' && bracketStack.length > 0) {
      closeBracketByOpen.set(bracketStack.pop()!, i);
    }
  }
  return { closeBracketByOpen, closeParenByOpen: buildLineParenMap(source) };
}

function matchUnwrappedLocalMarkdownLink(
  source: string,
  start: number,
  delimiters: MatchingDelimiters,
): MarkdownLinkMatch | null {
  const labelStart = source[start] === '!' ? start + 1 : start;
  if (source[labelStart] !== '[') return null;
  const labelEnd = delimiters.closeBracketByOpen.get(labelStart) ?? -1;
  if (labelEnd < 0 || source[labelEnd + 1] !== '(' || source[labelEnd + 2] === '<') return null;

  const destinationStart = labelEnd + 2;
  const destinationEnd = delimiters.closeParenByOpen.get(labelEnd + 1) ?? -1;
  if (destinationEnd < 0) return null;
  const destination = source.slice(destinationStart, destinationEnd);
  const normalized = normalizeChatFileReference(destination);
  if (!/[ \t]/.test(destination) || !normalized || !chatPathHasFileExtension(normalized)) return null;
  return { destinationStart, end: destinationEnd + 1, value: `${source.slice(start, destinationStart)}<${destination}>)` };
}

function transformOutsideMarkdownCode(
  source: string,
  transform: (source: string, start: number, delimiters: MatchingDelimiters) => MarkdownLinkMatch | null,
): string {
  if (!source.includes('[')) return source;
  const delimiters = buildMatchingDelimiters(source);
  let output = '';
  let cursor = 0;
  let codeDelimiter: { char: '`' | '~'; length: number } | null = null;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '`' || char === '~') {
      let runEnd = cursor + 1;
      while (source[runEnd] === char) runEnd += 1;
      const runLength = runEnd - cursor;
      if (codeDelimiter) {
        if (codeDelimiter.char === char && runLength >= codeDelimiter.length) codeDelimiter = null;
      } else if (char === '`' || runLength >= 3) {
        codeDelimiter = { char, length: runLength };
      }
      output += source.slice(cursor, runEnd);
      cursor = runEnd;
      continue;
    }
    if (!codeDelimiter && (char === '[' || (char === '!' && source[cursor + 1] === '['))) {
      const match = transform(source, cursor, delimiters);
      if (match) { output += match.value; cursor = match.end; continue; }
    }
    output += char;
    cursor += 1;
  }
  return output;
}

/** CommonMark requires destinations containing spaces to use `<...>`. */
export function normalizeLocalMarkdownDestinations(source: string): string {
  return transformOutsideMarkdownCode(source, matchUnwrappedLocalMarkdownLink);
}

/** Exact local file destinations published through Markdown links/images. */
export function extractMarkdownLocalFileDestinations(source: string): string[] {
  if (!source.includes('[')) return [];
  const normalized = normalizeLocalMarkdownDestinations(source);
  const paths = new Set<string>();
  const angleState: MonotonicCharState = { pos: -1, dead: false };
  const angleParenState: MonotonicCharState = { pos: -1, dead: false };
  const lfState: MonotonicCharState = { pos: -1, dead: false };
  const crState: MonotonicCharState = { pos: -1, dead: false };
  transformOutsideMarkdownCode(normalized, (text, start, delimiters) => {
    const labelStart = text[start] === '!' ? start + 1 : start;
    if (text[labelStart] !== '[') return null;
    const labelEnd = delimiters.closeBracketByOpen.get(labelStart) ?? -1;
    if (labelEnd < 0 || text[labelEnd + 1] !== '(') return null;
    const destinationStart = labelEnd + 2;
    let end = -1;
    if (text[destinationStart] === '<') {
      const lineEnd = findNextLineEndMonotonic(text, destinationStart, lfState, crState);
      const angleEnd = findNextCharMonotonic(text, '>', destinationStart + 1, angleState);
      if (angleEnd >= 0 && angleEnd < lineEnd) {
        const parenEnd = findNextCharMonotonic(text, ')', angleEnd + 1, angleParenState);
        if (parenEnd >= 0 && parenEnd < lineEnd) end = parenEnd;
      }
    } else {
      end = delimiters.closeParenByOpen.get(labelEnd + 1) ?? -1;
    }
    if (end < 0) return null;
    const raw = text.slice(start, end + 1);
    const path = rawMarkdownDestination(raw);
    const canonical = path === null ? null : normalizeChatFileReference(path);
    if (canonical && chatPathHasFileExtension(canonical)) paths.add(canonical);
    return { destinationStart, end: end + 1, value: raw };
  });
  return [...paths];
}

const FILE_REFERENCE_BOUNDARY = '(?=$|[\\s`,;!?，。；！？、\'"”’）】》」』]|\\.(?:\\s|$))';
const ROOTED_FILE_REFERENCE_RE = new RegExp(`(?<![:/])(?:file:\\/\\/(?:localhost)?\\/|[A-Za-z]:[/\\\\]|~[/\\\\]|\\.{1,2}[/\\\\]|\\/)[^\`\\r\\n<>"|]{0,512}?\\.[\\p{L}\\p{N}]{1,10}(?::\\d+(?::\\d+)?)?${FILE_REFERENCE_BOUNDARY}`, 'giu');
const RELATIVE_FILE_REFERENCE_RE = new RegExp(`(?<![:/\\\\\\w\\p{L}.$~()（）-])(?:[\\w\\p{L}.$~()（）-]+[/\\\\])+[\\w\\p{L}.$~()（）-]+\\.[\\p{L}\\p{N}]{1,10}(?::\\d+(?::\\d+)?)?${FILE_REFERENCE_BOUNDARY}`, 'gu');
const BARE_FILE_REFERENCE_RE = new RegExp(`(?<![:/\\w\\p{L}.$~-])[\\w\\p{L}.$~()（）-]+\\.[\\p{L}\\p{N}]{1,10}(?::\\d+(?::\\d+)?)?${FILE_REFERENCE_BOUNDARY}`, 'gu');
const COMMON_WEB_TLD_RE = /\.(?:com|net|org|io|ai|app|dev|cn|co|me|info|biz|xyz|top|site)$/i;

export function findChatFileReferencesInText(text: string): ChatFileReferenceMatch[] {
  if (!text || !text.includes('.')) return [];
  const matches: ChatFileReferenceMatch[] = [];
  const occupied: Array<[number, number]> = [];
  const collect = (regexp: RegExp) => {
    regexp.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regexp.exec(text)) !== null) {
      const raw = match[0];
      const start = match.index;
      const end = start + raw.length;
      if (occupied.some(([left, right]) => start < right && end > left)) continue;
      const path = normalizeChatFileReference(raw);
      if (!path || !chatPathHasFileExtension(path)) continue;
      if (regexp === BARE_FILE_REFERENCE_RE && COMMON_WEB_TLD_RE.test(path)) continue;
      matches.push({ raw, path, start, end });
      occupied.push([start, end]);
    }
  };
  collect(RELATIVE_FILE_REFERENCE_RE);
  collect(ROOTED_FILE_REFERENCE_RE);
  collect(BARE_FILE_REFERENCE_RE);
  return matches.sort((left, right) => left.start - right.start);
}

function maskMarkdownLinks(source: string): string {
  if (!source.includes('](')) return source;
  const closeParenByOpen = buildLineParenMap(source);
  const out: string[] = [];
  let cursor = 0;
  let openStart = -1;
  const angleState: MonotonicCharState = { pos: -1, dead: false };
  const parenState: MonotonicCharState = { pos: -1, dead: false };
  const lfState: MonotonicCharState = { pos: -1, dead: false };
  const crState: MonotonicCharState = { pos: -1, dead: false };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\n' || ch === '\r') {
      openStart = -1;
      continue;
    }
    if (ch === '[') {
      if (openStart < 0) openStart = i > 0 && source[i - 1] === '!' ? i - 1 : i;
      continue;
    }
    if (ch === ']') {
      if (openStart >= 0 && source[i + 1] === '(') {
        const destStart = i + 2;
        const lineEnd = findNextLineEndMonotonic(source, destStart, lfState, crState);
        let end = -1;
        if (source[destStart] === '<') {
          const angleEnd = findNextCharMonotonic(source, '>', destStart + 1, angleState);
          if (angleEnd >= 0 && angleEnd < lineEnd && source[angleEnd + 1] === ')') {
            end = angleEnd + 2;
          }
        }
        if (end < 0) {
          const balancedClose = closeParenByOpen.get(i + 1);
          if (balancedClose !== undefined && balancedClose < lineEnd) {
            end = balancedClose + 1;
          } else {
            const closeParen = findNextCharMonotonic(source, ')', destStart, parenState);
            if (closeParen >= 0 && closeParen < lineEnd) {
              end = closeParen + 1;
            }
          }
        }
        if (end > openStart) {
          if (openStart > cursor) out.push(source.slice(cursor, openStart));
          out.push(' '.repeat(end - openStart));
          cursor = end;
          i = end - 1;
        }
      }
      openStart = -1;
    }
  }
  if (cursor === 0) return source;
  if (cursor < source.length) out.push(source.slice(cursor));
  return out.join('');
}

/** All explicit AI-authored file references accepted by the chat renderer. */
export function extractChatFileReferences(source: string): string[] {
  const paths = new Set(extractMarkdownLocalFileDestinations(source));
  // Do not let a display label from a remote/rejected Markdown link become a
  // separate read grant. Local destinations were extracted authoritatively
  // above; mask every link/image before scanning legacy plain-text forms.
  const legacySource = maskMarkdownLinks(normalizeLocalMarkdownDestinations(source));
  for (const match of findChatFileReferencesInText(legacySource)) paths.add(match.path);
  // Complete lines preserve spaces in unwrapped old-format paths/code blocks.
  for (const line of legacySource.split(/\r?\n/)) {
    const stripped = line.replace(/^\s*```[^\s]*\s*$/, '').trim();
    const whole = findChatFileReferencesInText(stripped);
    if (whole.length === 1 && whole[0].start === 0 && whole[0].end === stripped.length) {
      paths.add(whole[0].path);
    }
  }
  return [...paths];
}
