/**
 * dom-to-text — convert a DOM node tree to formatted plain text that mirrors
 * what the user sees on screen.
 *
 * Why this exists: the chat view renders assistant messages as marked-tokenized
 * Preact components (paragraphs, lists, code blocks, etc.). Native APIs are
 * lossy when the user wants to copy that content out:
 *
 *   - `Element.textContent` concatenates every descendant text node with no
 *     separator, so `<p>foo</p><p>bar</p>` becomes "foobar" — paragraph and
 *     list boundaries are gone.
 *   - `Selection.toString()` is implementation-defined; browsers disagree on
 *     whether block elements introduce newlines, and on iOS the result is
 *     often the same flattened text as `textContent`.
 *
 * This helper walks the DOM and emits explicit newlines for block-level
 * elements (`<p>`, `<li>`, `<h1-6>`, `<blockquote>`, `<tr>`, …), expands `<br>`,
 * preserves `<pre>` content verbatim, prefixes list items, and indents
 * blockquotes. The output is then normalised to collapse runs of blank lines.
 *
 * Used by ChatView for both the long-press context menu (over a whole event)
 * and the desktop selection menu (over a `Range.cloneContents()` fragment).
 */

/** Class names whose subtree should be omitted from the output. UI chrome
 *  that the user is not trying to copy (timestamps, copy buttons, download
 *  arrows, …). Lives here rather than as parameter so that every call site
 *  agrees on what counts as "noise". */
const IGNORED_CLASSES: ReadonlySet<string> = new Set([
  'chat-bubble-time',
  'chat-code-copy-btn',
  'chat-dl-btn',
  'chat-code-lang',
  'chat-code-titlebar',
  'chat-code-header',
  'chat-user-status',
  'chat-user-status-pending',
  'chat-user-status-failed',
  'chat-user-status-icon',
  'chat-user-retry-btn',
  'chat-sel-menu',
]);

/** Tag names that introduce a vertical boundary (newline before + after).
 *  `<pre>`, `<li>`, `<ul>`, `<ol>`, `<blockquote>`, `<table>`, `<tr>` are
 *  handled separately because they need extra structure (verbatim text,
 *  bullets, cell separators, etc.). */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'NAV', 'ASIDE', 'FIGURE', 'FIGCAPTION',
  'DL', 'DT', 'DD',
]);

interface WalkContext {
  /** Active list type, if we are inside an `<ul>` or `<ol>`. */
  listType?: 'ul' | 'ol';
  /** 1-based index of the current `<li>` inside its parent list. */
  listIndex?: number;
}

function hasIgnoredClass(el: Element): boolean {
  for (const cls of IGNORED_CLASSES) {
    if (el.classList.contains(cls)) return true;
  }
  return false;
}

/** Prefix every line of `text` with "> " for blockquote rendering. Empty
 *  lines get a bare "> " so the quote block reads as one continuous unit
 *  when pasted into other markdown-aware tools. */
function indentBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

function walk(node: Node, out: string[], ctx: WalkContext): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  if (hasIgnoredClass(el)) return;

  const tag = el.tagName;

  if (tag === 'BR') { out.push('\n'); return; }
  if (tag === 'HR') { out.push('\n---\n'); return; }
  if (tag === 'IMG') {
    const alt = (el as HTMLImageElement).alt;
    if (alt) out.push(alt);
    return;
  }
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;

  if (tag === 'PRE') {
    // Preserve preformatted text verbatim. If the <pre> wraps a single <code>
    // element (the common markdown shape) use its textContent — otherwise
    // fall back to the <pre>'s own textContent.
    const child = el.firstElementChild;
    const source = child && child.tagName === 'CODE' ? child : el;
    out.push('\n');
    out.push(source.textContent ?? '');
    out.push('\n');
    return;
  }

  if (tag === 'BLOCKQUOTE') {
    const sub: string[] = [];
    for (const child of Array.from(el.childNodes)) walk(child, sub, ctx);
    const text = sub.join('').replace(/^\n+|\n+$/g, '');
    out.push('\n');
    out.push(indentBlockquote(text));
    out.push('\n');
    return;
  }

  if (tag === 'UL' || tag === 'OL') {
    const listType = tag === 'OL' ? 'ol' : 'ul';
    out.push('\n');
    let idx = 1;
    for (const child of Array.from(el.childNodes)) {
      if ((child as Element).nodeType === 1 && (child as Element).tagName === 'LI') {
        walk(child, out, { listType, listIndex: idx });
        idx += 1;
      } else {
        walk(child, out, ctx);
      }
    }
    out.push('\n');
    return;
  }

  if (tag === 'LI') {
    const prefix = ctx.listType === 'ol' ? `${ctx.listIndex ?? 1}. ` : '- ';
    out.push(prefix);
    // Children of <li> inherit no list context — nested lists set their own.
    for (const child of Array.from(el.childNodes)) walk(child, out, {});
    out.push('\n');
    return;
  }

  if (tag === 'TABLE') {
    out.push('\n');
    for (const child of Array.from(el.childNodes)) walk(child, out, ctx);
    out.push('\n');
    return;
  }

  if (tag === 'TR') {
    const cells: string[] = [];
    for (const cell of Array.from(el.children)) {
      if (cell.tagName === 'TD' || cell.tagName === 'TH') {
        const cellOut: string[] = [];
        for (const child of Array.from(cell.childNodes)) walk(child, cellOut, ctx);
        cells.push(cellOut.join('').replace(/\s+/g, ' ').trim());
      }
    }
    out.push(cells.join('\t'));
    out.push('\n');
    return;
  }

  if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
    for (const child of Array.from(el.childNodes)) walk(child, out, ctx);
    return;
  }

  const isBlock = BLOCK_TAGS.has(tag);
  if (isBlock) out.push('\n');
  for (const child of Array.from(el.childNodes)) walk(child, out, ctx);
  if (isBlock) out.push('\n');
}

// Module-level regex literals so we don't recompile on every call. The
// walker output is generally short (one chat bubble), but `normalize` is
// in the gesture-response path and the cost is trivial to avoid.
const RE_CRLF = /\r\n/g;
const RE_TRAILING_WS = /[ \t]+\n/g;
const RE_BLANK_RUN = /\n{3,}/g;
const RE_EDGE_WS = /^\s+|\s+$/g;

/** Collapse trailing whitespace on each line, fold runs of blank lines to
 *  at most one blank line, and trim leading/trailing whitespace overall. */
function normalize(text: string): string {
  return text
    .replace(RE_CRLF, '\n')
    .replace(RE_TRAILING_WS, '\n')
    .replace(RE_BLANK_RUN, '\n\n')
    .replace(RE_EDGE_WS, '');
}

/**
 * Walk a DOM node (or DocumentFragment from `Range.cloneContents()`) and
 * return a plain-text rendering that preserves block-level newlines, list
 * bullets, blockquote indentation, and `<pre>` content.
 */
export function domNodeToPlainText(node: Node): string {
  const out: string[] = [];
  walk(node, out, {});
  return normalize(out.join(''));
}

/**
 * Convert the active selection into plain text using the same rules as
 * `domNodeToPlainText`. Returns an empty string if the selection is empty
 * or collapsed.
 */
export function selectionToPlainText(sel: Selection | null): string {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const fragment = sel.getRangeAt(0).cloneContents();
  return domNodeToPlainText(fragment);
}
