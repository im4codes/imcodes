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
import { splitTextByHttpUrls, trimDetectedUrl } from '../link-detection.js';
import { copyToClipboard } from '../util/clipboard.js';
import { shouldSkipRichTextEnhancement } from '../chat-render-limits.js';
import {
  isImagePreviewPath,
  isLikelyDomainPath,
  isLocalChatPath,
  renderChatPathActions,
  type ChatPathDownloadHandler,
} from '../chat-path-actions.js';
import type { ChatLocalImagePreviewLoader } from './ChatLocalImagePreview.js';

interface Props {
  text: string;
  onPathClick?: (path: string) => void;
  onUrlClick?: (url: string) => void;
  /** Called to download a file path. Only shown for paths with extensions. */
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
}

interface RenderContext {
  onPathClick?: (path: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  downloadLabel: string;
  htmlPreviewLabel: string;
}

// ── Code block with copy button ────────────────────────────────────────────

function CodeBlock({
  lang,
  text,
  onPathClick,
  onUrlClick,
  onDownload,
  onHtmlPreview,
  onImagePreview,
  downloadLabel,
  htmlPreviewLabel,
}: {
  lang?: string;
  text: string;
  onPathClick?: (path: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  downloadLabel: string;
  htmlPreviewLabel: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: Event) => {
    e.stopPropagation();
    copyToClipboard(text, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const renderContext: RenderContext = {
    onPathClick,
    onUrlClick,
    onDownload,
    onHtmlPreview,
    onImagePreview,
    downloadLabel,
    htmlPreviewLabel,
  };

  return (
    <div class="chat-code-block">
      <div class="chat-code-header">
        <div class="chat-code-titlebar">
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
      </div>
      <pre><code>{splitPathsAndUrlsInternal(text, renderContext)}</code></pre>
    </div>
  );
}

// ── Token rendering ─────────────────────────────────────────────────────────

function renderTokens(
  tokens: Token[],
  ctx: RenderContext,
  inLink = false,
): h.JSX.Element[] {
  return tokens.map((token, i) => renderToken(token, i, ctx, inLink));
}

function renderInlineTokens(
  tokens: Token[] | undefined,
  ctx: RenderContext,
  inLink = false,
): h.JSX.Element[] {
  if (!tokens || tokens.length === 0) return [];
  return renderTokens(tokens, ctx, inLink);
}

function renderToken(
  token: Token,
  key: number,
  ctx: RenderContext,
  inLink = false,
): h.JSX.Element {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = `h${t.depth}` as keyof h.JSX.IntrinsicElements;
      return <Tag key={key} class="chat-heading">{renderInlineTokens(t.tokens, ctx, inLink)}</Tag>;
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      const plainEscapedParagraph = !inLink && Array.isArray(t.tokens) && t.tokens.every((child) => child.type === 'text' || child.type === 'escape');
      if (plainEscapedParagraph) {
        return <p key={key}>{splitPathsAndUrlsInternal(t.raw, ctx)}</p>;
      }
      return <p key={key}>{renderInlineTokens(t.tokens, ctx, inLink)}</p>;
    }

    case 'text': {
      const t = token as Tokens.Text;
      // Text tokens may have sub-tokens (e.g. from inline parsing)
      if ('tokens' in t && t.tokens && t.tokens.length > 0) {
        return <span key={key}>{renderInlineTokens(t.tokens, ctx, inLink)}</span>;
      }
      // Plain text — apply path/URL detection IF NOT already inside a link
      if (inLink) return <span key={key}>{t.raw}</span>;
      return <span key={key}>{splitPathsAndUrlsInternal(t.raw, ctx)}</span>;
    }

    case 'strong': {
      const t = token as Tokens.Strong;
      return <strong key={key}>{renderInlineTokens(t.tokens, ctx, inLink)}</strong>;
    }

    case 'em': {
      const t = token as Tokens.Em;
      return <em key={key}>{renderInlineTokens(t.tokens, ctx, inLink)}</em>;
    }

    case 'del': {
      const t = token as Tokens.Del;
      return <del key={key}>{renderInlineTokens(t.tokens, ctx, inLink)}</del>;
    }

    case 'codespan': {
      const t = token as Tokens.Codespan;
      if (!inLink && splitTextByHttpUrls(t.text).some((chunk) => chunk.type === 'url')) {
        return <code key={key} class="chat-inline-code">{splitPathsAndUrlsInternal(t.text, ctx)}</code>;
      }
      // Detect file paths inside backtick code spans — agents commonly wrap paths in backticks
      PATH_REGEX_INLINE.lastIndex = 0;
      if ((ctx.onPathClick || ctx.onImagePreview) && PATH_REGEX_INLINE.test(t.text)) {
        PATH_REGEX_INLINE.lastIndex = 0;
        return renderChatPathActions({
          key,
          path: t.text,
          code: true,
          onPathClick: ctx.onPathClick,
          onDownload: ctx.onDownload,
          onHtmlPreview: ctx.onHtmlPreview,
          onImagePreview: ctx.onImagePreview,
          downloadLabel: ctx.downloadLabel,
          htmlPreviewLabel: ctx.htmlPreviewLabel,
        });
      }
      return <code key={key} class="chat-inline-code">{t.text}</code>;
    }

    case 'code': {
      const t = token as Tokens.Code;
      return (
        <CodeBlock
          key={key}
          lang={t.lang}
          text={t.text}
          onPathClick={ctx.onPathClick}
          onUrlClick={ctx.onUrlClick}
          onDownload={ctx.onDownload}
          onHtmlPreview={ctx.onHtmlPreview}
          onImagePreview={ctx.onImagePreview}
          downloadLabel={ctx.downloadLabel}
          htmlPreviewLabel={ctx.htmlPreviewLabel}
        />
      );
    }

    case 'link': {
      const t = token as Tokens.Link;
      if (isLocalChatPath(t.href)) {
        return renderChatPathActions({
          key,
          path: t.href,
          content: renderInlineTokens(t.tokens, ctx, true),
          onPathClick: ctx.onPathClick,
          onDownload: ctx.onDownload,
          onHtmlPreview: ctx.onHtmlPreview,
          onImagePreview: ctx.onImagePreview,
          downloadLabel: ctx.downloadLabel,
          htmlPreviewLabel: ctx.htmlPreviewLabel,
        });
      }
      const sanitizedHref = trimDetectedUrl(t.href);
      const inlineText = typeof (t as { text?: unknown }).text === 'string' ? String((t as { text?: unknown }).text) : '';
      const isAutoLinkLike = !inlineText || inlineText === t.href;
      const trailingText = isAutoLinkLike && inlineText.startsWith(sanitizedHref)
        ? inlineText.slice(sanitizedHref.length)
        : '';
      const linkText = isAutoLinkLike ? sanitizedHref : renderInlineTokens(t.tokens, ctx, true);
      const link = (
        <a
          class="chat-external-link"
          href={sanitizedHref}
          title={sanitizedHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: Event) => {
            if (!ctx.onUrlClick) return;
            e.preventDefault();
            ctx.onUrlClick(sanitizedHref);
          }}
        >
          {linkText}
        </a>
      );
      if (trailingText) {
        return <span key={key}>{link}<span>{trailingText}</span></span>;
      }
      return (
        <a
          key={key}
          class="chat-external-link"
          href={sanitizedHref}
          title={sanitizedHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: Event) => {
            if (!ctx.onUrlClick) return;
            e.preventDefault();
            ctx.onUrlClick(sanitizedHref);
          }}
        >
          {linkText}
        </a>
      );
    }

    case 'image': {
      const t = token as Tokens.Image;
      if (isLocalChatPath(t.href) && isImagePreviewPath(t.href)) {
        return renderChatPathActions({
          key,
          path: t.href,
          content: t.text || t.href,
          onPathClick: ctx.onPathClick,
          onDownload: ctx.onDownload,
          onHtmlPreview: ctx.onHtmlPreview,
          onImagePreview: ctx.onImagePreview,
          downloadLabel: ctx.downloadLabel,
          htmlPreviewLabel: ctx.htmlPreviewLabel,
        });
      }
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
                  {renderInlineTokens(cell.tokens, ctx, false)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={cell.align ? { textAlign: cell.align } : undefined}>
                    {renderInlineTokens(cell.tokens, ctx, false)}
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
              {renderTokens(item.tokens, ctx, false)}
            </li>
          ))}
        </Tag>
      );
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return <blockquote key={key} class="chat-blockquote">{renderTokens(t.tokens, ctx, false)}</blockquote>;
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

const PATH_REGEX_INLINE = /(\\\\[\w.$ -]+\\[\w.$ \\-]+|[A-Za-z]:\\(?:[\w.$ -]+\\)*[\w.$ -]+|\.{1,2}\/[\w\p{L}.\-~/]+|\/[\w\p{L}.\-~][\w\p{L}.\-~/]*|(?<![:/\w\p{L}])[a-zA-Z_~][\w\p{L}.\-~]*(?:\/[\w\p{L}.\-~]+)+)/gu;

function splitPathsAndUrlsInternal(
  text: string,
  ctx: RenderContext,
): h.JSX.Element[] {
  if (!ctx.onPathClick && !ctx.onUrlClick && !ctx.onImagePreview) return [<span>{text}</span>];

  const parts: h.JSX.Element[] = [];
  const chunks = splitTextByHttpUrls(text);

  for (const chunk of chunks) {
    if (chunk.type === 'url') {
      parts.push(
        <a
          key={`u${chunk.start}`}
          class="chat-external-link"
          href={chunk.value}
          title={chunk.value}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: Event) => {
            if (!ctx.onUrlClick) return;
            e.preventDefault();
            ctx.onUrlClick(chunk.value);
          }}
        >
          {chunk.value}
        </a>,
      );
    } else if (ctx.onPathClick || ctx.onImagePreview) {
      let pathLast = 0;
      PATH_REGEX_INLINE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PATH_REGEX_INLINE.exec(chunk.value)) !== null) {
        const path = pm[1];
        if (path.length < 3) continue;
        if (isLikelyDomainPath(path)) continue;
        if (pm.index > pathLast) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast, pm.index)}</span>);
        parts.push(
          renderChatPathActions({
            key: `p${chunk.start + pm.index}`,
            path,
            onPathClick: ctx.onPathClick,
            onDownload: ctx.onDownload,
            onHtmlPreview: ctx.onHtmlPreview,
            onImagePreview: ctx.onImagePreview,
            downloadLabel: ctx.downloadLabel,
            htmlPreviewLabel: ctx.htmlPreviewLabel,
          }),
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

export function ChatMarkdown({ text, onPathClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview }: Props) {
  const { t } = useTranslation();
  const skipRichTextEnhancement = shouldSkipRichTextEnhancement(text);
  const tokens = useMemo(() => (
    skipRichTextEnhancement ? [] : marked.lexer(text)
  ), [skipRichTextEnhancement, text]);
  const renderContext = useMemo<RenderContext>(() => ({
    onPathClick,
    onUrlClick,
    onDownload,
    onHtmlPreview,
    onImagePreview,
    downloadLabel: t('upload.download_file'),
    htmlPreviewLabel: t('chat.html_preview', 'Render HTML'),
  }), [onPathClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, t]);

  if (skipRichTextEnhancement) {
    return (
      <div class="chat-rich-text">
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div class="chat-rich-text">
      {renderTokens(tokens, renderContext, false)}
    </div>
  );
}
