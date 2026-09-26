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

function matchUnwrappedLocalMarkdownLink(source: string, start: number): MarkdownLinkMatch | null {
  const labelStart = source[start] === '!' ? start + 1 : start;
  if (source[labelStart] !== '[') return null;
  let labelDepth = 1;
  let labelEnd = -1;
  for (let i = labelStart + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === '[') labelDepth += 1;
    if (source[i] === ']' && --labelDepth === 0) { labelEnd = i; break; }
  }
  if (labelEnd < 0 || source[labelEnd + 1] !== '(' || source[labelEnd + 2] === '<') return null;

  const destinationStart = labelEnd + 2;
  let depth = 0;
  let destinationEnd = -1;
  for (let i = destinationStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '\n' || char === '\r') return null;
    if (char === '(' || char === '（') { depth += 1; continue; }
    if (char === ')' || char === '）') {
      if (depth === 0) { destinationEnd = i; break; }
      depth -= 1;
    }
  }
  if (destinationEnd < 0) return null;
  const destination = source.slice(destinationStart, destinationEnd);
  const normalized = normalizeChatFileReference(destination);
  if (!/[ \t]/.test(destination) || !normalized || !chatPathHasFileExtension(normalized)) return null;
  return { destinationStart, end: destinationEnd + 1, value: `${source.slice(start, destinationStart)}<${destination}>)` };
}

function transformOutsideMarkdownCode(
  source: string,
  transform: (source: string, start: number) => MarkdownLinkMatch | null,
): string {
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
      const match = transform(source, cursor);
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
  const normalized = normalizeLocalMarkdownDestinations(source);
  const paths = new Set<string>();
  transformOutsideMarkdownCode(normalized, (text, start) => {
    const labelStart = text[start] === '!' ? start + 1 : start;
    let depth = 1;
    let labelEnd = -1;
    for (let i = labelStart + 1; i < text.length; i += 1) {
      if (text[i] === '\\') { i += 1; continue; }
      if (text[i] === '[') depth += 1;
      if (text[i] === ']' && --depth === 0) { labelEnd = i; break; }
    }
    if (labelEnd < 0 || text[labelEnd + 1] !== '(') return null;
    const destinationStart = labelEnd + 2;
    let end = -1;
    if (text[destinationStart] === '<') {
      const angleEnd = text.indexOf('>', destinationStart + 1);
      if (angleEnd >= 0) end = text.indexOf(')', angleEnd + 1);
    } else {
      let parenDepth = 0;
      for (let i = destinationStart; i < text.length; i += 1) {
        if (text[i] === '\\') { i += 1; continue; }
        if (text[i] === '(' || text[i] === '（') parenDepth += 1;
        else if ((text[i] === ')' || text[i] === '）') && parenDepth-- === 0) { end = i; break; }
        if (text[i] === '\n' || text[i] === '\r') break;
      }
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
const ROOTED_FILE_REFERENCE_RE = new RegExp(`(?<![:/])(?:file:\\/\\/(?:localhost)?\\/|[A-Za-z]:[/\\\\]|~[/\\\\]|\\.{1,2}[/\\\\]|\\/)[^\`\\r\\n<>"|]*?\\.[\\p{L}\\p{N}]{1,10}(?::\\d+(?::\\d+)?)?${FILE_REFERENCE_BOUNDARY}`, 'giu');
const RELATIVE_FILE_REFERENCE_RE = new RegExp(`(?<![:/\\\\\\w\\p{L}.$~()（）-])(?:[\\w\\p{L}.$~()（）-]+[/\\\\])+[\\w\\p{L}.$~()（）-]+\\.[\\p{L}\\p{N}]{1,10}(?::\\d+(?::\\d+)?)?${FILE_REFERENCE_BOUNDARY}`, 'gu');
const BARE_FILE_REFERENCE_RE = new RegExp(`(?<![:/\\w\\p{L}])[\\w\\p{L}.$~()（）-]+\\.[\\p{L}\\p{N}]{1,10}(?::\\d+(?::\\d+)?)?${FILE_REFERENCE_BOUNDARY}`, 'gu');
const COMMON_WEB_TLD_RE = /\.(?:com|net|org|io|ai|app|dev|cn|co|me|info|biz|xyz|top|site)$/i;

export function findChatFileReferencesInText(text: string): ChatFileReferenceMatch[] {
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

/** All explicit AI-authored file references accepted by the chat renderer. */
export function extractChatFileReferences(source: string): string[] {
  const paths = new Set(extractMarkdownLocalFileDestinations(source));
  // Do not let a display label from a remote/rejected Markdown link become a
  // separate read grant. Local destinations were extracted authoritatively
  // above; mask every link/image before scanning legacy plain-text forms.
  const legacySource = normalizeLocalMarkdownDestinations(source).replace(
    /!?\[[^\]\r\n]*\]\((?:<[^>\r\n]*>|[^\r\n)]*)\)/g,
    (raw) => ' '.repeat(raw.length),
  );
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
