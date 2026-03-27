/**
 * UsageFooter — shared context bar + usage stats + cost display.
 * Used by both main session (app.tsx) and SubSessionWindow.
 */
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { getSessionCost, getWeeklyCost, getMonthlyCost, formatCost } from '../cost-tracker.js';

interface UsageData {
  inputTokens: number;
  cacheTokens: number;
  contextWindow: number;
  model?: string;
}

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
    const ctx = resolveContextWindow(usage.contextWindow, usage.model);
    const total = usage.inputTokens + usage.cacheTokens;
    const totalPct = Math.min(100, total / ctx * 100);
    const cachePct = Math.min(totalPct, usage.cacheTokens / ctx * 100);
    const newPct = totalPct - cachePct;
    const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
    const tip = [
      usage.model ?? '',
      `Context: ${fmt(total)} / ${fmt(ctx)} (${pctStr}%)`,
      `  New: ${fmt(usage.inputTokens)}  Cache: ${fmt(usage.cacheTokens)}`,
    ].filter(Boolean).join('\n');
    return { ctx, total, totalPct, cachePct, newPct, pctStr, tip };
  }, [usage.inputTokens, usage.cacheTokens, usage.contextWindow, usage.model]);

  const sessionCost = showCost ? getSessionCost(sessionName) : 0;
  const weeklyCost = sessionCost > 0 ? getWeeklyCost() : 0;
  const monthlyCost = sessionCost > 0 ? getMonthlyCost() : 0;
  const modelLabel = shortModelLabel(usage.model);

  return (
    <div class="session-usage-footer" title={tip}>
      {total > 0 && (
        <div class="session-ctx-bar">
          <div class="session-ctx-cache" style={{ width: `${cachePct}%` }} />
          <div class="session-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
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
