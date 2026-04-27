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
import { useMemo, useState } from 'preact/hooks';
import { marked, type Token, type Tokens } from 'marked';
import { useTranslation } from 'react-i18next';

// ── Code block with copy button ────────────────────────────────────────────

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: Event) => {
    e.stopPropagation();
    if (!text) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        // fallback noop
      });
    } else {
      // fallback for non-secure contexts
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch {
        // ignore
      }
    }
  };

  return (
    <div class="chat-code-block">
      <div class="chat-code-header">
        <span class="chat-code-lang">{lang || 'text'}</span>
        <button
          type="button"
          class={`chat-code-copy-btn${copied ? ' is-copied' : ''}`}
          onClick={handleCopy}
          title={copied ? t('common.copied') : t('common.copy')}
          aria-label={copied ? t('common.copied') : t('common.copy')}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

interface Props {
  text: string;
  onPathClick?: (path: string) => void;
  onUrlClick?: (url: string) => void;
  /** Called to download a file path. Only shown for paths with extensions. */
  onDownload?: (path: string) => void;
}

/** Returns true if the path has a file extension (not a directory). */
function hasFileExtension(path: string): boolean {
  const basename = path.split(/[/\\]/).pop() ?? '';
  return /\.\w{1,10}$/.test(basename);
}

function isLikelyDomainPath(value: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(value);
}

function trimDetectedUrl(url: string): string {
  const hardStop = url.search(/[（【《「『，。；：！？⬇]/u);
  let next = hardStop >= 0 ? url.slice(0, hardStop) : url;
  while (next.length > 1 && /[.,;:!?)}\]>）】》」』，。；：！？⬇]$/u.test(next)) next = next.slice(0, -1);
  return next;
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
  inLink = false,
  onDownload?: (p: string) => void,
): h.JSX.Element[] {
  return tokens.map((token, i) => renderToken(token, i, onPathClick, onUrlClick, inLink, onDownload));
}

function renderInlineTokens(
  tokens: Token[] | undefined,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
  inLink = false,
  onDownload?: (p: string) => void,
): h.JSX.Element[] {
  if (!tokens || tokens.length === 0) return [];
  return renderTokens(tokens, onPathClick, onUrlClick, inLink, onDownload);
}

function renderToken(
  token: Token,
  key: number,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
  inLink = false,
  onDownload?: (p: string) => void,
): h.JSX.Element {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = `h${t.depth}` as keyof h.JSX.IntrinsicElements;
      return <Tag key={key} class="chat-heading">{renderInlineTokens(t.tokens, onPathClick, onUrlClick, inLink, onDownload)}</Tag>;
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      const plainEscapedParagraph = !inLink && Array.isArray(t.tokens) && t.tokens.every((child) => child.type === 'text' || child.type === 'escape');
      if (plainEscapedParagraph) {
        return <p key={key}>{splitPathsAndUrlsInternal(t.raw, onPathClick, onUrlClick, onDownload)}</p>;
      }
      return <p key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick, inLink, onDownload)}</p>;
    }

    case 'text': {
      const t = token as Tokens.Text;
      // Text tokens may have sub-tokens (e.g. from inline parsing)
      if ('tokens' in t && t.tokens && t.tokens.length > 0) {
        return <span key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick, inLink, onDownload)}</span>;
      }
      // Plain text — apply path/URL detection IF NOT already inside a link
      if (inLink) return <span key={key}>{t.raw}</span>;
      return <span key={key}>{splitPathsAndUrlsInternal(t.raw, onPathClick, onUrlClick, onDownload)}</span>;
    }

    case 'strong': {
      const t = token as Tokens.Strong;
      return <strong key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick, inLink, onDownload)}</strong>;
    }

    case 'em': {
      const t = token as Tokens.Em;
      return <em key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick, inLink, onDownload)}</em>;
    }

    case 'del': {
      const t = token as Tokens.Del;
      return <del key={key}>{renderInlineTokens(t.tokens, onPathClick, onUrlClick, inLink, onDownload)}</del>;
    }

    case 'codespan': {
      const t = token as Tokens.Codespan;
      // Detect file paths inside backtick code spans — agents commonly wrap paths in backticks
      if (onPathClick && PATH_REGEX_INLINE.test(t.text)) {
        PATH_REGEX_INLINE.lastIndex = 0;
        return <span key={key}>
          <code class="chat-inline-code chat-path-link" onClick={() => onPathClick(t.text)} title={t.text}>{t.text}</code>
          {onDownload && hasFileExtension(t.text) && <button class="chat-dl-btn" title="Download" onClick={(e: Event) => { e.stopPropagation(); onDownload(t.text); }}>⬇</button>}
        </span>;
      }
      return <code key={key} class="chat-inline-code">{t.text}</code>;
    }

    case 'code': {
      const t = token as Tokens.Code;
      return <CodeBlock key={key} lang={t.lang} text={t.text} />;
    }

    case 'link': {
      const t = token as Tokens.Link;
      if (isLocalPath(t.href)) {
        return (
          <span key={key}>
            <span
              class="chat-path-link"
              onClick={() => onPathClick?.(t.href)}
              title={t.href}
            >
              {renderInlineTokens(t.tokens, onPathClick, onUrlClick, true, onDownload)}
            </span>
            {onDownload && hasFileExtension(t.href) && (
              <button
                class="chat-dl-btn"
                title="Download"
                onClick={(e: Event) => {
                  e.stopPropagation();
                  onDownload(t.href);
                }}
              >
                ⬇
              </button>
            )}
          </span>
        );
      }
      const sanitizedHref = trimDetectedUrl(t.href);
      const inlineText = typeof (t as { text?: unknown }).text === 'string' ? String((t as { text?: unknown }).text) : '';
      const isAutoLinkLike = !inlineText || inlineText === t.href;
      return (
        <a
          key={key}
          class="chat-external-link"
          href={sanitizedHref}
          title={sanitizedHref}
          onClick={(e: Event) => {
            e.preventDefault();
            onUrlClick?.(sanitizedHref);
          }}
        >
          {isAutoLinkLike ? sanitizedHref : renderInlineTokens(t.tokens, onPathClick, onUrlClick, true, onDownload)}
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
                  {renderInlineTokens(cell.tokens, onPathClick, onUrlClick, false, onDownload)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={cell.align ? { textAlign: cell.align } : undefined}>
                    {renderInlineTokens(cell.tokens, onPathClick, onUrlClick, false, onDownload)}
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
              {renderTokens(item.tokens, onPathClick, onUrlClick, false, onDownload)}
            </li>
          ))}
        </Tag>
      );
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return <blockquote key={key} class="chat-blockquote">{renderTokens(t.tokens, onPathClick, onUrlClick, false, onDownload)}</blockquote>;
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

const URL_REGEX_INLINE = /https?:\/\/[^\s<>"\])}）】》」』，。；：！？（【《「『]+/g;
const PATH_REGEX_INLINE = /(\\\\[\w.$ -]+\\[\w.$ \\-]+|[A-Za-z]:\\(?:[\w.$ -]+\\)*[\w.$ -]+|\.{1,2}\/[\w\p{L}.\-~/]+|\/[\w\p{L}.\-~][\w\p{L}.\-~/]*|(?<![:/\w\p{L}])[a-zA-Z_~][\w\p{L}.\-~]*(?:\/[\w\p{L}.\-~]+)+)/gu;

function splitPathsAndUrlsInternal(
  text: string,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
  onDownload?: (p: string) => void,
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
    let url = trimDetectedUrl(m[0]);
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
        if (isLikelyDomainPath(path)) continue;
        if (pm.index > pathLast) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast, pm.index)}</span>);
        parts.push(
          <span key={`p${chunk.start + pm.index}`}>
            <span class="chat-path-link" onClick={() => onPathClick(path)} title={path}>{path}</span>
            {onDownload && hasFileExtension(path) && <button class="chat-dl-btn" title="Download" onClick={(e: Event) => { e.stopPropagation(); onDownload(path); }}>⬇</button>}
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

export function ChatMarkdown({ text, onPathClick, onUrlClick, onDownload }: Props) {
  const tokens = useMemo(() => marked.lexer(text), [text]);
  return (
    <div class="chat-rich-text">
      {renderTokens(tokens, onPathClick, onUrlClick, false, onDownload)}
    </div>
  );
}
