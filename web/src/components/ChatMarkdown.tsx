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
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Marked, Tokenizer, type Token, type Tokens } from 'marked';
import { useTranslation } from 'react-i18next';
import {
  chatPathHasFileExtension,
  findChatFileReferencesInText,
  markdownLocalPath,
  normalizeChatFileReference,
  normalizeLocalMarkdownDestinations,
} from '@shared/chat-local-path.js';
import { splitTextByHttpUrls, trimDetectedUrl } from '../link-detection.js';
import { copyToClipboard } from '../util/clipboard.js';
import { shouldSkipRichTextEnhancement } from '../chat-render-limits.js';
import { repairStreamingMarkdown, STREAMING_MARKDOWN_REFRESH_MS } from '../streaming-markdown.js';
import {
  renderChatPathActions,
  renderCloudDocAction,
  renderRemoteDesktopAction,
  isImagePreviewPath,
  splitTextWithCloudDocsAndUrls,
  type ChatPathDownloadHandler,
} from '../chat-path-actions.js';
import {
  extractCloudDocIdToken,
  findPairedCloudDocIdInTrailingText,
  parseCloudDocQuoteTag,
} from '../cloud-docs-reference.js';
import {
  REMOTE_DESKTOP_CITATION_PREFIX,
  parseRemoteDesktopCitationTag,
} from '@shared/remote-desktop-reference.js';
import type { ChatLocalImagePreviewLoader } from './ChatLocalImagePreview.js';
import {
  ChatLoopbackLink,
  type ChatLocalWebPreviewOpenHandler,
} from './ChatLoopbackLink.js';

interface Props {
  text: string;
  /** Stable event id used with the content revision to cache parsed tokens. */
  cacheKey?: string;
  /** Streaming blocks re-parse at most 10Hz (always rendered as Markdown); finalized blocks update immediately. */
  streaming?: boolean;
  onPathClick?: (path: string) => void;
  onCloudDocClick?: (docId: string) => void;
  onRemoteDesktopClick?: (targetId: string) => void;
  onUrlClick?: (url: string) => void;
  /** Called to download a file path. Only shown for paths with extensions. */
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  onOpenLocalWebPreview?: ChatLocalWebPreviewOpenHandler;
}

interface RenderContext {
  onPathClick?: (path: string) => void;
  onCloudDocClick?: (docId: string) => void;
  onRemoteDesktopClick?: (targetId: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  onOpenLocalWebPreview?: ChatLocalWebPreviewOpenHandler;
  downloadLabel: string;
  htmlPreviewLabel: string;
  trailingCloudDocId?: string | null;
}

// ── Code block with copy button ────────────────────────────────────────────

function CodeBlock({
  lang,
  text,
  onPathClick,
  onCloudDocClick,
  onRemoteDesktopClick,
  onUrlClick,
  onDownload,
  onHtmlPreview,
  onImagePreview,
  onOpenLocalWebPreview,
  downloadLabel,
  htmlPreviewLabel,
}: {
  lang?: string;
  text: string;
  onPathClick?: (path: string) => void;
  onCloudDocClick?: (docId: string) => void;
  onRemoteDesktopClick?: (targetId: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  onOpenLocalWebPreview?: ChatLocalWebPreviewOpenHandler;
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
    onCloudDocClick,
    onRemoteDesktopClick,
    onUrlClick,
    onDownload,
    onHtmlPreview,
    onImagePreview,
    onOpenLocalWebPreview,
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

const INLINE_CLOUD_DOC_PAIRABLE_TYPES = new Set(['codespan', 'text', 'strong', 'em', 'del']);

function trailingRawTextAfterToken(tokens: Token[], index: number): string {
  let raw = '';
  for (let i = index + 1; i < tokens.length && raw.length < 140; i += 1) {
    raw += String((tokens[i] as { raw?: string }).raw ?? '');
  }
  return raw;
}

function renderTokens(
  tokens: Token[],
  ctx: RenderContext,
  inLink = false,
  propagateTrailingDoc = false,
): h.JSX.Element[] {
  const baseCtx = ctx.trailingCloudDocId ? { ...ctx, trailingCloudDocId: undefined } : ctx;
  return tokens.map((token, i) => {
    const inheritedTrailing = propagateTrailingDoc && i === tokens.length - 1
      ? (ctx.trailingCloudDocId ?? null)
      : null;
    const lookaheadDocId = !inLink && INLINE_CLOUD_DOC_PAIRABLE_TYPES.has(token.type)
      ? findPairedCloudDocIdInTrailingText(trailingRawTextAfterToken(tokens, i))
      : null;
    const trailingCloudDocId = lookaheadDocId ?? inheritedTrailing;
    const tokenCtx = trailingCloudDocId ? { ...baseCtx, trailingCloudDocId } : baseCtx;
    return renderToken(token, i, tokenCtx, inLink);
  });
}

function renderInlineTokens(
  tokens: Token[] | undefined,
  ctx: RenderContext,
  inLink = false,
  propagateTrailingDoc = false,
): h.JSX.Element[] {
  if (!tokens || tokens.length === 0) return [];
  return renderTokens(tokens, ctx, inLink, propagateTrailingDoc);
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
        return <span key={key}>{renderInlineTokens(t.tokens, ctx, inLink, !!ctx.trailingCloudDocId)}</span>;
      }
      // Plain text — apply path/URL detection IF NOT already inside a link
      if (inLink) return <span key={key}>{t.raw}</span>;
      return <span key={key}>{splitPathsAndUrlsInternal(t.raw, ctx)}</span>;
    }

    case 'strong': {
      const t = token as Tokens.Strong;
      return <strong key={key}>{renderInlineTokens(t.tokens, ctx, inLink, !!ctx.trailingCloudDocId)}</strong>;
    }

    case 'em': {
      const t = token as Tokens.Em;
      return <em key={key}>{renderInlineTokens(t.tokens, ctx, inLink, !!ctx.trailingCloudDocId)}</em>;
    }

    case 'del': {
      const t = token as Tokens.Del;
      return <del key={key}>{renderInlineTokens(t.tokens, ctx, inLink, !!ctx.trailingCloudDocId)}</del>;
    }

    case 'codespan': {
      const t = token as Tokens.Codespan;
      if (!inLink) {
        const quoteTag = parseCloudDocQuoteTag(t.text);
        if (quoteTag) {
          return renderCloudDocAction({
            key,
            docId: quoteTag.docId,
            content: quoteTag.name,
            kind: 'quote',
            onCloudDocClick: ctx.onCloudDocClick,
          });
        }
        const rdTag = parseRemoteDesktopCitationTag(t.text);
        if (rdTag) {
          return renderRemoteDesktopAction({
            key,
            targetId: rdTag.targetId,
            content: rdTag.name,
            onRemoteDesktopClick: ctx.onRemoteDesktopClick,
          });
        }
        const cloudDocIdToken = extractCloudDocIdToken(t.text);
        if (cloudDocIdToken) {
          return renderCloudDocAction({
            key,
            docId: cloudDocIdToken.docId,
            content: t.text,
            kind: 'id',
            code: true,
            onCloudDocClick: ctx.onCloudDocClick,
          });
        }
      }
      if (!inLink && splitTextByHttpUrls(t.text).some((chunk) => chunk.type === 'url')) {
        return <code key={key} class="chat-inline-code">{splitPathsAndUrlsInternal(t.text, { ...ctx, trailingCloudDocId: undefined })}</code>;
      }
      // Detect complete file references inside backtick code spans — agents
      // commonly use this old output format, including source `path:line`.
      const codePath = normalizeChatFileReference(t.text);
      if (codePath && chatPathHasFileExtension(codePath)) {
        if (!inLink && ctx.trailingCloudDocId) {
          return renderCloudDocAction({
            key,
            docId: ctx.trailingCloudDocId,
            content: t.text,
            kind: 'paired_file',
            code: true,
            onCloudDocClick: ctx.onCloudDocClick,
          });
        }
        if (ctx.onPathClick || ctx.onImagePreview) {
          return renderChatPathActions({
            key,
            path: codePath,
            content: t.text,
            code: true,
            onPathClick: ctx.onPathClick,
            onDownload: ctx.onDownload,
            onHtmlPreview: ctx.onHtmlPreview,
            onImagePreview: ctx.onImagePreview,
            downloadLabel: ctx.downloadLabel,
            htmlPreviewLabel: ctx.htmlPreviewLabel,
          });
        }
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
          onCloudDocClick={ctx.onCloudDocClick}
          onRemoteDesktopClick={ctx.onRemoteDesktopClick}
          onUrlClick={ctx.onUrlClick}
          onDownload={ctx.onDownload}
          onHtmlPreview={ctx.onHtmlPreview}
          onImagePreview={ctx.onImagePreview}
          onOpenLocalWebPreview={ctx.onOpenLocalWebPreview}
          downloadLabel={ctx.downloadLabel}
          htmlPreviewLabel={ctx.htmlPreviewLabel}
        />
      );
    }

    case 'link': {
      const t = token as Tokens.Link;
      const cloudHref = !inLink ? extractCloudDocIdToken(t.href) : null;
      if (cloudHref) {
        return renderCloudDocAction({
          key,
          docId: cloudHref.docId,
          content: renderInlineTokens(t.tokens, ctx, true),
          kind: 'id',
          onCloudDocClick: ctx.onCloudDocClick,
        });
      }
      const path = markdownLocalPath(t.raw, t.href);
      if (path !== null) {
        return renderChatPathActions({
          key,
          path,
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
        <ChatLoopbackLink
          href={sanitizedHref}
          onOpenLocalWebPreview={ctx.onOpenLocalWebPreview}
          onUrlClick={ctx.onUrlClick}
        >
          {linkText}
        </ChatLoopbackLink>
      );
      if (trailingText) {
        return <span key={key}>{link}<span>{trailingText}</span></span>;
      }
      return (
        <ChatLoopbackLink
          key={key}
          href={sanitizedHref}
          onOpenLocalWebPreview={ctx.onOpenLocalWebPreview}
          onUrlClick={ctx.onUrlClick}
        >
          {linkText}
        </ChatLoopbackLink>
      );
    }

    case 'image': {
      const t = token as Tokens.Image;
      const path = markdownLocalPath(t.raw, t.href);
      if (path !== null && isImagePreviewPath(path)) {
        return renderChatPathActions({
          key,
          path,
          content: t.text || path,
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

function splitPathsAndUrlsInternal(
  text: string,
  ctx: RenderContext,
): h.JSX.Element[] {
  const hasCloudDocText = text.includes('cdoc_') || text.includes('[CloudDoc:');
  const hasRemoteDesktopText = text.includes(REMOTE_DESKTOP_CITATION_PREFIX);
  if (
    !ctx.onPathClick
    && !ctx.onUrlClick
    && !ctx.onImagePreview
    && !ctx.onOpenLocalWebPreview
    && !ctx.onCloudDocClick
    && !ctx.onRemoteDesktopClick
    && !ctx.trailingCloudDocId
    && !hasCloudDocText
    && !hasRemoteDesktopText
  ) {
    return [<span>{text}</span>];
  }

  // A complete path occupying the text/code line has an unambiguous boundary,
  // so preserve spaces and Unicode instead of letting the inline regex stop at
  // the first space. Prose containing a path still follows the conservative
  // token scanner below.
  if (!hasCloudDocText && !hasRemoteDesktopText) {
    const standaloneRaw = text.trim();
    const standaloneMatches = findChatFileReferencesInText(standaloneRaw);
    const standaloneMatch = standaloneMatches.length === 1
      && standaloneMatches[0].start === 0
      && standaloneMatches[0].end === standaloneRaw.length
      ? standaloneMatches[0]
      : null;
    const standalonePath = standaloneMatch?.path ?? null;
    if (standalonePath) {
      const leadingLength = text.indexOf(standaloneRaw);
      const trailingStart = leadingLength + standaloneRaw.length;
      const actionEl = ctx.trailingCloudDocId
        ? renderCloudDocAction({
            key: 'standalone-cloud-doc',
            docId: ctx.trailingCloudDocId,
            content: standaloneRaw,
            kind: 'paired_file',
            onCloudDocClick: ctx.onCloudDocClick,
          })
        : renderChatPathActions({
            key: 'standalone-path',
            path: standalonePath,
            content: standaloneRaw,
            onPathClick: ctx.onPathClick,
            onDownload: ctx.onDownload,
            onHtmlPreview: ctx.onHtmlPreview,
            onImagePreview: ctx.onImagePreview,
            downloadLabel: ctx.downloadLabel,
            htmlPreviewLabel: ctx.htmlPreviewLabel,
          });
      return [
        ...(leadingLength > 0 ? [<span key="standalone-leading">{text.slice(0, leadingLength)}</span>] : []),
        actionEl,
        ...(trailingStart < text.length ? [<span key="standalone-trailing">{text.slice(trailingStart)}</span>] : []),
      ];
    }
  }

  return splitTextWithCloudDocsAndUrls(text, {
    onCloudDocClick: ctx.onCloudDocClick,
    onRemoteDesktopClick: ctx.onRemoteDesktopClick,
    onUrlClick: ctx.onUrlClick,
    onOpenLocalWebPreview: ctx.onOpenLocalWebPreview,
    renderPlainText: (chunkText, baseOffset) => {
      const canPairTrailingFile = Boolean(ctx.trailingCloudDocId) && baseOffset + chunkText.length === text.length;
      if (!ctx.onPathClick && !ctx.onImagePreview && !canPairTrailingFile) {
        return [<span key={`t${baseOffset}`}>{chunkText}</span>];
      }
      const parts: h.JSX.Element[] = [];
      let pathLast = 0;
      const trimmedChunkLen = chunkText.trimEnd().length;
      for (const match of findChatFileReferencesInText(chunkText)) {
        const { path } = match;
        if (match.start > pathLast) {
          parts.push(<span key={`t${baseOffset + pathLast}`}>{chunkText.slice(pathLast, match.start)}</span>);
        }
        if (canPairTrailingFile && ctx.trailingCloudDocId && match.end === trimmedChunkLen) {
          parts.push(
            renderCloudDocAction({
              key: `cd${baseOffset + match.start}`,
              docId: ctx.trailingCloudDocId,
              content: match.raw,
              kind: 'paired_file',
              onCloudDocClick: ctx.onCloudDocClick,
            }),
          );
        } else if (ctx.onPathClick || ctx.onImagePreview) {
          parts.push(
            renderChatPathActions({
              key: `p${baseOffset + match.start}`,
              path,
              content: match.raw,
              onPathClick: ctx.onPathClick,
              onDownload: ctx.onDownload,
              onHtmlPreview: ctx.onHtmlPreview,
              onImagePreview: ctx.onImagePreview,
              downloadLabel: ctx.downloadLabel,
              htmlPreviewLabel: ctx.htmlPreviewLabel,
            }),
          );
        } else {
          parts.push(<span key={`t${baseOffset + match.start}`}>{match.raw}</span>);
        }
        pathLast = match.end;
      }
      if (pathLast < chunkText.length) {
        parts.push(<span key={`t${baseOffset + pathLast}`}>{chunkText.slice(pathLast)}</span>);
      }
      return parts.length ? parts : [<span key={`t${baseOffset}`}>{chunkText}</span>];
    },
  });
}

// ── Public component ────────────────────────────────────────────────────────

interface CachedTokens {
  text: string;
  tokens: Token[];
}

const markdownTokenCache = new Map<string, CachedTokens>();
const MARKDOWN_CACHE_LIMIT = 512;

function markdownRevision(text: string): string {
  // Fast deterministic content revision; event ids remain the primary key.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

export function __resetChatMarkdownCacheForTests(): void {
  markdownTokenCache.clear();
}

export function __getChatMarkdownCacheSizeForTests(): number {
  return markdownTokenCache.size;
}

// Bound quadratic inline emphasis/strikethrough backtracking in marked when a
// message contains thousands of unclosed `*`, `_`, or `~` delimiters (e.g. globs
// or raw logs under the 20k markdown limit). Once the failed-scan budget for a
// single parse pass is exhausted, remaining unclosed delimiters degrade cleanly to
// plain text instead of wedging the main thread.
const MAX_FAILED_INLINE_SCAN_CHARS = 120_000;
let activeFailedInlineScanBudget = { remaining: MAX_FAILED_INLINE_SCAN_CHARS };
const chatMarkdownLexer = new Marked({
  breaks: true,
  gfm: true,
  tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      if (activeFailedInlineScanBudget.remaining <= 0) return undefined;
      const token = Tokenizer.prototype.emStrong.call(this, src, maskedSrc, prevChar);
      if (!token) activeFailedInlineScanBudget.remaining -= maskedSrc.length;
      return token;
    },
    del(src, maskedSrc, prevChar) {
      if (activeFailedInlineScanBudget.remaining <= 0) return undefined;
      const token = Tokenizer.prototype.del.call(this, src, maskedSrc, prevChar);
      if (!token) activeFailedInlineScanBudget.remaining -= maskedSrc.length;
      return token;
    },
  },
});

function parseMarkdownTokens(text: string, cacheKey?: string): Token[] {
  const normalized = normalizeLocalMarkdownDestinations(text);
  const key = cacheKey ? `${cacheKey}:${markdownRevision(normalized)}` : `text:${markdownRevision(normalized)}`;
  const hit = markdownTokenCache.get(key);
  if (hit && hit.text === normalized) {
    markdownTokenCache.delete(key);
    markdownTokenCache.set(key, hit);
    return hit.tokens;
  }
  const previousBudget = activeFailedInlineScanBudget;
  activeFailedInlineScanBudget = { remaining: MAX_FAILED_INLINE_SCAN_CHARS };
  let tokens: Token[];
  try {
    tokens = chatMarkdownLexer.lexer(normalized);
  } finally {
    activeFailedInlineScanBudget = previousBudget;
  }
  markdownTokenCache.set(key, { text: normalized, tokens });
  while (markdownTokenCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownTokenCache.keys().next().value;
    if (oldest === undefined) break;
    markdownTokenCache.delete(oldest);
  }
  return tokens;
}

export function ChatMarkdown({ text, cacheKey, streaming = false, onPathClick, onCloudDocClick, onRemoteDesktopClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, onOpenLocalWebPreview }: Props) {
  const { t } = useTranslation();
  // A streaming block re-parses at most every STREAMING_MARKDOWN_REFRESH_MS
  // (a THROTTLE with a trailing update: a steady stream can never starve it, and
  // the newest text always lands within one interval). The block is always
  // rendered as Markdown from the latest snapshot: showing the un-parsed text
  // while the snapshot lags flipped the bubble between raw text and Markdown
  // (different heights) on every burst. Finalized text bypasses the timer.
  const [parsedText, setParsedText] = useState(text);
  const latestTextRef = useRef(text);
  latestTextRef.current = text;
  const timerRef = useRef<number | null>(null);
  const lastAppliedAtRef = useRef(0);
  useEffect(() => {
    if (!streaming) {
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      setParsedText(text);
      return;
    }
    if (parsedText === text || timerRef.current !== null) return;
    const wait = Math.max(0, lastAppliedAtRef.current + STREAMING_MARKDOWN_REFRESH_MS - Date.now());
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastAppliedAtRef.current = Date.now();
      setParsedText(latestTextRef.current);
    }, wait);
  }, [text, streaming, parsedText]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const skipRichTextEnhancement = shouldSkipRichTextEnhancement(text);
  // Final/non-streaming updates must be visible in the same render.
  const effectiveParsedText = streaming ? repairStreamingMarkdown(parsedText) : text;
  const tokens = useMemo(() => (
    skipRichTextEnhancement ? [] : parseMarkdownTokens(effectiveParsedText, cacheKey)
  ), [skipRichTextEnhancement, effectiveParsedText, cacheKey]);
  const renderContext = useMemo<RenderContext>(() => ({
    onPathClick,
    onCloudDocClick,
    onRemoteDesktopClick,
    onUrlClick,
    onDownload,
    onHtmlPreview,
    onImagePreview,
    onOpenLocalWebPreview,
    downloadLabel: t('upload.download_file'),
    htmlPreviewLabel: t('chat.html_preview', 'Render HTML'),
  }), [onPathClick, onCloudDocClick, onRemoteDesktopClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, onOpenLocalWebPreview, t]);

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
