/**
 * Tiny status icon for the daemon's embedding pipeline + server fallback.
 * Renders inline next to CPU / Mem / Load in the SubSessionBar toolbar.
 *
 * Design goals:
 *   - One emoji wide, no layout shift across states.
 *   - Tooltip explains what each state means without requiring the user
 *     to grep daemon.log.
 *   - Color-coded:
 *       • green   ready      — semantic search runs locally
 *       • yellow  fallback   — local broken, routing through server
 *       • red     unavailable — both dead, recall returns nothing
 *       • dim     idle/loading — neutral; not yet exercised
 *
 * The status object is broadcast in every `daemon.stats` heartbeat (5s
 * interval) so the icon stays current without any extra round-trip.
 */

import { useTranslation } from 'react-i18next';
import type { EmbeddingStatus } from '@shared/embedding-status.js';

interface Props {
  status?: EmbeddingStatus | null;
  /** Compact mode shrinks the emoji slightly to match the surrounding
   *  CPU/Mem/Load glyphs in the mobile collapsed bar. */
  compact?: boolean;
}

interface Style {
  emoji: string;
  color: string;
  /** i18n key for the title attribute. Falls back to the literal string
   *  in the second arg of t() when the locale hasn't been translated yet. */
  titleKey: string;
  titleFallback: string;
}

function pickStyle(status: EmbeddingStatus | null | undefined): Style {
  if (!status) {
    return { emoji: '◌', color: '#64748b', titleKey: 'embedding.status_unknown', titleFallback: 'Embedding status unknown (older daemon or disconnected)' };
  }
  switch (status.state) {
    case 'ready':
      return { emoji: '✨', color: '#4ade80', titleKey: 'embedding.status_ready', titleFallback: 'Embedding: local pipeline ready' };
    case 'loading':
      return { emoji: '⌛', color: '#fbbf24', titleKey: 'embedding.status_loading', titleFallback: 'Embedding: loading model…' };
    case 'fallback':
      return { emoji: '☁️', color: '#fbbf24', titleKey: 'embedding.status_fallback', titleFallback: 'Embedding: local unavailable, using server fallback' };
    case 'unavailable':
      return { emoji: '⚠️', color: '#f87171', titleKey: 'embedding.status_unavailable', titleFallback: 'Embedding unavailable — semantic search disabled' };
    case 'idle':
    default:
      return { emoji: '◌', color: '#64748b', titleKey: 'embedding.status_idle', titleFallback: 'Embedding: idle (not yet used)' };
  }
}

export function EmbeddingStatusIcon({ status, compact = false }: Props) {
  const { t } = useTranslation();
  const style = pickStyle(status);
  const reasonSuffix = status?.reason ? ` (${status.reason})` : '';
  // The tooltip combines the localized state description with the raw
  // failure code so operators can grep for it in daemon logs without
  // needing the locale string memorized.
  const title = t(style.titleKey, style.titleFallback) + reasonSuffix;
  return (
    <span
      class="embedding-status-icon"
      data-state={status?.state ?? 'unknown'}
      title={title}
      style={{
        color: style.color,
        cursor: 'help',
        fontSize: compact ? '0.75em' : '0.85em',
        verticalAlign: 'middle',
        whiteSpace: 'nowrap',
      }}
    >
      {style.emoji}
    </span>
  );
}
