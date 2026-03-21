/**
 * ChatMarkdown — renders markdown text as JSX using marked's lexer (token-based).
 * No dangerouslySetInnerHTML — tokens are mapped directly to Preact components.
 *
 * Preserves:
 * - Local path detection (splitPathsAndUrls → chat-path-link → FileBrowser)
 * - External URL detection (chat-external-link → confirm dialog)
 * - Code block language labels (chat-code-lang)
 * - All existing chat CSS classes
 */
import { h } from 'preact';
import { useMemo } from 'preact/hooks';
import { marked, type Token, type Tokens } from 'marked';

interface Props {
  text: string;
  onPathClick?: (path: string) => void;
  onUrlClick?: (url: string) => void;
}

// ── Token rendering ─────────────────────────────────────────────────────────

function isLocalPath(href: string): boolean {
  if (/^https?:\/\//i.test(href)) return false;
  if (/^mailto:/i.test(href)) return false;
  if (/^[a-z]+:/i.test(href)) return false; // any other scheme
  return true;
}

function renderTokens(
  tokens: Token[],
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
): h.JSX.Element[] {
  return tokens.map((token, i) => renderToken(token, i, onPathClick, onUrlClick));
}

function renderInlineTokens(
  tokens: Token[] | undefined,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
): h.JSX.Element[] {
  if (!tokens || tokens.length === 0) return [];
  return renderTokens(tokens, onPathClick, onUrlClick);
}

function renderToken(
  token: Token,
  key: number,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
): h.JSX.Element {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = `h${t.depth}` as keyof h.JSX.IntrinsicElements;
      return <Tag key={key} class="chat-heading">{renderInlineTokens(t.tokens, onPathClick, onUrlClick)}</Tag>;
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return <p key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick)}</p>;
    }

    case 'text': {
      const t = token as Tokens.Text;
      // Text tokens may have sub-tokens (e.g. from inline parsing)
      if ('tokens' in t && t.tokens && t.tokens.length > 0) {
        return <span key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick)}</span>;
      }
      // Plain text — apply path/URL detection
      return <span key={key}>{splitPathsAndUrlsInternal(t.raw, onPathClick, onUrlClick)}</span>;
    }

    case 'strong': {
      const t = token as Tokens.Strong;
      return <strong key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick)}</strong>;
    }

    case 'em': {
      const t = token as Tokens.Em;
      return <em key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick)}</em>;
    }

    case 'del': {
      const t = token as Tokens.Del;
      return <del key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick)}</del>;
    }

    case 'codespan': {
      const t = token as Tokens.Codespan;
      return <code key={key} class="chat-inline-code">{t.text}</code>;
    }

    case 'code': {
      const t = token as Tokens.Code;
      return (
        <div key={key} class="chat-code-block">
          {t.lang && <div class="chat-code-lang">{t.lang}</div>}
          <pre><code>{t.text}</code></pre>
        </div>
      );
    }

    case 'link': {
      const t = token as Tokens.Link;
      if (isLocalPath(t.href)) {
        return (
          <span
            key={key}
            class="chat-path-link"
            onClick={() => onPathClick?.(t.href)}
            title={t.href}
          >
            {renderInlineTokens(t.tokens, onPathClick, onUrlClick)}
          </span>
        );
      }
      return (
        <a
          key={key}
          class="chat-external-link"
          href={t.href}
          title={t.href}
          onClick={(e: Event) => {
            e.preventDefault();
            onUrlClick?.(t.href);
          }}
        >
          {renderInlineTokens(t.tokens, onPathClick, onUrlClick)}
        </a>
      );
    }

    case 'image': {
      const t = token as Tokens.Image;
      return <img key={key} src={t.href} alt={t.text} title={t.title ?? undefined} style={{ maxWidth: '100%' }} />;
    }

    case 'table': {
      const t = token as Tokens.Table;
      return (
        <table key={key} class="chat-table">
          <thead>
            <tr>
              {t.header.map((cell, ci) => (
                <th key={ci} style={cell.align ? { textAlign: cell.align } : undefined}>
                  {renderInlineTokens(cell.tokens, onPathClick, onUrlClick)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={cell.align ? { textAlign: cell.align } : undefined}>
                    {renderInlineTokens(cell.tokens, onPathClick, onUrlClick)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    case 'list': {
      const t = token as Tokens.List;
      const Tag = t.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key} class="chat-list">
          {t.items.map((item, li) => (
            <li key={li}>
              {item.task && <input type="checkbox" checked={item.checked} disabled style={{ marginRight: 4 }} />}
              {renderTokens(item.tokens, onPathClick, onUrlClick)}
            </li>
          ))}
        </Tag>
      );
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return <blockquote key={key} class="chat-blockquote">{renderTokens(t.tokens, onPathClick, onUrlClick)}</blockquote>;
    }

    case 'hr':
      return <hr key={key} class="chat-hr" />;

    case 'br':
      return <br key={key} />;

    case 'space':
      return <span key={key} />;

    case 'html': {
      // Strip raw HTML for security — render as plain text
      const t = token as Tokens.HTML;
      return <span key={key}>{t.raw}</span>;
    }

    case 'escape': {
      const t = token as Tokens.Escape;
      return <span key={key}>{t.text}</span>;
    }

    default:
      // Fallback: render raw text
      return <span key={key}>{(token as any).raw ?? ''}</span>;
  }
}

// ── URL/Path detection (inline within text tokens) ──────────────────────────

const URL_REGEX_INLINE = /https?:\/\/[^\s<>"\])}]+/g;
const PATH_REGEX_INLINE = /(\.{1,2}\/[\w.\-~/]+|\/[\w.\-~][\w.\-~/]*|(?<![:/\w])[a-zA-Z_~][\w.\-~]*(?:\/[\w.\-~]+)+)/g;

function splitPathsAndUrlsInternal(
  text: string,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
): h.JSX.Element[] {
  if (!onPathClick && !onUrlClick) return [<span>{text}</span>];

  const parts: h.JSX.Element[] = [];
  let last = 0;
  URL_REGEX_INLINE.lastIndex = 0;

  interface Chunk { type: 'text' | 'url'; value: string; start: number }
  const chunks: Chunk[] = [];
  let m: RegExpExecArray | null;

  while ((m = URL_REGEX_INLINE.exec(text)) !== null) {
    if (m.index > last) chunks.push({ type: 'text', value: text.slice(last, m.index), start: last });
    let url = m[0];
    while (url.length > 1 && /[.,;:!?)}\]>]$/.test(url)) url = url.slice(0, -1);
    chunks.push({ type: 'url', value: url, start: m.index });
    last = m.index + url.length;
    URL_REGEX_INLINE.lastIndex = last;
  }
  if (last < text.length) chunks.push({ type: 'text', value: text.slice(last), start: last });

  for (const chunk of chunks) {
    if (chunk.type === 'url') {
      parts.push(
        <a
          key={`u${chunk.start}`}
          class="chat-external-link"
          href={chunk.value}
          title={chunk.value}
          onClick={(e: Event) => { e.preventDefault(); onUrlClick?.(chunk.value); }}
        >
          {chunk.value}
        </a>,
      );
    } else if (onPathClick) {
      let pathLast = 0;
      PATH_REGEX_INLINE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PATH_REGEX_INLINE.exec(chunk.value)) !== null) {
        const path = pm[1];
        if (path.length < 3) continue;
        if (pm.index > pathLast) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast, pm.index)}</span>);
        parts.push(
          <span key={`p${chunk.start + pm.index}`} class="chat-path-link" onClick={() => onPathClick(path)} title={path}>
            {path}
          </span>,
        );
        pathLast = pm.index + pm[0].length;
      }
      if (pathLast < chunk.value.length) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast)}</span>);
    } else {
      parts.push(<span key={`t${chunk.start}`}>{chunk.value}</span>);
    }
  }

  return parts.length ? parts : [<span>{text}</span>];
}

// ── Public component ────────────────────────────────────────────────────────

export function ChatMarkdown({ text, onPathClick, onUrlClick }: Props) {
  const tokens = useMemo(() => marked.lexer(text), [text]);
  return (
    <div class="chat-rich-text">
      {renderTokens(tokens, onPathClick, onUrlClick)}
    </div>
  );
}
