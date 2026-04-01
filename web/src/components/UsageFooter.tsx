/**
 * UsageFooter — shared context bar + usage stats + cost display.
 * Used by both main session (app.tsx) and SubSessionWindow.
 */
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { getSessionCost, getWeeklyCost, getMonthlyCost, formatCost } from '../cost-tracker.js';
import type { UsageData } from '../usage-data.js';

interface Props {
  usage: UsageData;
  sessionName: string;
  /** Show cost tracking (requires costUsd events to have been recorded). */
  showCost?: boolean;
  /** Active thinking timestamp — shows elapsed time spinner. */
  activeThinkingTs?: number | null;
  /** Status text from agent (e.g. "Reading file..."). */
  statusText?: string | null;
  /** Current timestamp for thinking timer (updated every second). */
  now?: number;
}

const fmt = (n: number) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(0)}k`
  : String(n);

export function UsageFooter({ usage, sessionName, showCost, activeThinkingTs, statusText, now }: Props) {
  const { t } = useTranslation();

  const { ctx, total, cachePct, newPct, pctStr, tip } = useMemo(() => {
    const ctx = usage.codexStatus?.contextWindowTokens ?? resolveContextWindow(usage.contextWindow, usage.model);
    const total = usage.codexStatus?.contextUsedTokens ?? (usage.inputTokens + usage.cacheTokens);
    const totalPct = Math.min(100, total / ctx * 100);
    const cachePct = usage.codexStatus?.contextUsedTokens ? 0 : Math.min(totalPct, usage.cacheTokens / ctx * 100);
    const newPct = totalPct - cachePct;
    const pctStr = usage.codexStatus?.contextLeftPercent !== undefined
      ? String(usage.codexStatus.contextLeftPercent)
      : totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
    const tip = [
      usage.model ?? '',
      `Context: ${fmt(total)} / ${fmt(ctx)} (${pctStr}%)`,
      `  New: ${fmt(usage.inputTokens)}  Cache: ${fmt(usage.cacheTokens)}`,
      usage.codexStatus?.fiveHourLeftPercent !== undefined ? `5h: ${usage.codexStatus.fiveHourLeftPercent}% (${usage.codexStatus.fiveHourResetAt ?? ''})` : '',
      usage.codexStatus?.weeklyLeftPercent !== undefined ? `Weekly: ${usage.codexStatus.weeklyLeftPercent}% (${usage.codexStatus.weeklyResetAt ?? ''})` : '',
    ].filter(Boolean).join('\n');
    return { ctx, total, totalPct, cachePct, newPct, pctStr, tip };
  }, [usage.inputTokens, usage.cacheTokens, usage.contextWindow, usage.model, usage.codexStatus]);

  const sessionCost = showCost ? getSessionCost(sessionName) : 0;
  const weeklyCost = sessionCost > 0 ? getWeeklyCost() : 0;
  const monthlyCost = sessionCost > 0 ? getMonthlyCost() : 0;
  const modelLabel = shortModelLabel(usage.model);
  const hasCodexStatus = usage.codexStatus?.contextLeftPercent !== undefined
    || usage.codexStatus?.fiveHourLeftPercent !== undefined
    || usage.codexStatus?.weeklyLeftPercent !== undefined;

  return (
    <div class="session-usage-footer" title={tip}>
      {total > 0 && (
        <div class="session-ctx-bar">
          <div class="session-ctx-cache" style={{ width: `${cachePct}%` }} />
          <div class="session-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
        </div>
      )}
      {hasCodexStatus && (
        <div class="session-usage-codex-row">
          {usage.codexStatus?.contextLeftPercent !== undefined && (
            <span class="session-usage-badge" title={t('session.codex_ctx_title', { percent: usage.codexStatus.contextLeftPercent })}>
              {t('session.codex_ctx_short')} {usage.codexStatus.contextLeftPercent}%
            </span>
          )}
          {usage.codexStatus?.fiveHourLeftPercent !== undefined && (
            <span
              class="session-usage-badge"
              title={t('session.codex_limit_title', {
                label: t('session.codex_5h_short'),
                percent: usage.codexStatus.fiveHourLeftPercent,
                reset: usage.codexStatus.fiveHourResetAt ?? '—',
              })}
            >
              {t('session.codex_5h_short')} {usage.codexStatus.fiveHourLeftPercent}%
            </span>
          )}
          {usage.codexStatus?.weeklyLeftPercent !== undefined && (
            <span
              class="session-usage-badge"
              title={t('session.codex_limit_title', {
                label: t('session.codex_wk_short'),
                percent: usage.codexStatus.weeklyLeftPercent,
                reset: usage.codexStatus.weeklyResetAt ?? '—',
              })}
            >
              {t('session.codex_wk_short')} {usage.codexStatus.weeklyLeftPercent}%
            </span>
          )}
        </div>
      )}
      <div class="session-usage-stats">
        {(activeThinkingTs || statusText) && (
          <span class="session-thinking-inline">
            <span class="chat-thinking-dots">···</span>
            {' '}{activeThinkingTs
              ? t('chat.thinking_running', { sec: Math.max(0, Math.round(((now ?? Date.now()) - activeThinkingTs) / 1000)) })
              : statusText}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {modelLabel && <span class="session-usage-model">{modelLabel}</span>}
          {total > 0 && <span class="session-usage-tokens">{fmt(total)} / {fmt(ctx)} ({pctStr}%)</span>}
          {sessionCost > 0 && (
            <span class="session-usage-cost">
              {formatCost(sessionCost)} · wk {formatCost(weeklyCost)} · mo {formatCost(monthlyCost)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
