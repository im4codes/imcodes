/**
 * UsageFooter — shared context bar + usage stats + cost display.
 * Used by both main session (app.tsx) and SubSessionWindow.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { getSessionCost, getWeeklyCost, getMonthlyCost, formatCost } from '../cost-tracker.js';
import type { UsageData } from '../usage-data.js';
import { formatProviderQuotaLabel, type ProviderQuotaMeta } from '@shared/provider-quota.js';

interface Props {
  usage: UsageData;
  sessionName: string;
  sessionState?: string | null;
  agentType?: string | null;
  modelOverride?: string | null;
  planLabel?: string | null;
  quotaLabel?: string | null;
  quotaUsageLabel?: string | null;
  quotaMeta?: ProviderQuotaMeta | null;
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

export function UsageFooter({ usage, sessionName, sessionState, agentType, modelOverride, planLabel, quotaLabel, quotaUsageLabel, quotaMeta, showCost, activeThinkingTs, statusText, now }: Props) {
  const { t } = useTranslation();
  const isCodexFamily = agentType === 'codex' || agentType === 'codex-sdk';
  const showRunningStatus = sessionState === 'running' && !!(activeThinkingTs || statusText);
  const [quotaNow, setQuotaNow] = useState(() => Date.now());

  const displayModel = modelOverride ?? usage.model;
  useEffect(() => {
    if (!isCodexFamily || !quotaMeta) return;
    let intervalId: number | undefined;
    const tick = () => setQuotaNow(Date.now());
    tick();
    const delay = Math.max(250, 60_000 - (Date.now() % 60_000));
    const timeoutId = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, 60_000);
    }, delay);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [isCodexFamily, quotaMeta]);

  const displayQuotaLabel = useMemo(() => {
    if (!isCodexFamily || !quotaMeta) return quotaLabel;
    return formatProviderQuotaLabel(quotaMeta, now ?? quotaNow) ?? quotaLabel;
  }, [isCodexFamily, now, quotaLabel, quotaMeta, quotaNow]);

  const displayPlanLabel = useMemo(() => {
    const normalized = planLabel?.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'free') return t('session.provider_plan_free');
    if (normalized === 'paid') return t('session.provider_plan_paid');
    if (normalized === 'byo') return t('session.provider_plan_byo');
    return planLabel;
  }, [planLabel, t]);

  const { ctx, total, cachePct, newPct, pctStr, tip } = useMemo(() => {
    const ctx = resolveContextWindow(usage.contextWindow, displayModel);
    const total = usage.inputTokens + usage.cacheTokens;
    const totalPct = Math.min(100, total / ctx * 100);
    const cachePct = Math.min(totalPct, usage.cacheTokens / ctx * 100);
    const newPct = totalPct - cachePct;
    const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
    const tip = [
      displayModel ?? '',
      `Context: ${fmt(total)} / ${fmt(ctx)} (${pctStr}%)`,
      `  New: ${fmt(usage.inputTokens)}  Cache: ${fmt(usage.cacheTokens)}`,
      displayPlanLabel ? t('session.provider_plan_title', { value: displayPlanLabel }) : '',
      displayQuotaLabel ? t('session.provider_quota_title', { value: displayQuotaLabel }) : '',
      quotaUsageLabel ? t('session.provider_quota_usage_title', { value: quotaUsageLabel }) : '',
    ].filter(Boolean).join('\n');
    return { ctx, total, totalPct, cachePct, newPct, pctStr, tip };
  }, [usage.inputTokens, usage.cacheTokens, usage.contextWindow, displayModel, displayPlanLabel, displayQuotaLabel, quotaUsageLabel, t]);

  const sessionCost = showCost ? getSessionCost(sessionName) : 0;
  const weeklyCost = sessionCost > 0 ? getWeeklyCost() : 0;
  const monthlyCost = sessionCost > 0 ? getMonthlyCost() : 0;
  const modelLabel = shortModelLabel(displayModel);
  const inlineQuotaText = displayQuotaLabel;
  const codexQuotaLines = (agentType === 'codex' || agentType === 'codex-sdk')
    ? (displayQuotaLabel ?? '').split(' · ').filter(Boolean)
    : [];

  return (
    <div class="session-usage-footer" title={tip} data-agent-type={agentType ?? undefined}>
      {total > 0 && (
        <div class="session-ctx-bar">
          <div class="session-ctx-cache" style={{ width: `${cachePct}%` }} />
          <div class="session-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
        </div>
      )}
      {codexQuotaLines.length > 0 && (
        <div class="session-usage-codex-quota">
          {codexQuotaLines.map((line) => (
            <div class="session-usage-codex-line">{line}</div>
          ))}
        </div>
      )}
      <div class="session-usage-stats">
        {showRunningStatus && (
          <span class="session-thinking-inline">
            <span class="chat-thinking-dots">···</span>
            {' '}{activeThinkingTs
              ? t('chat.thinking_running', { sec: Math.max(0, Math.round(((now ?? Date.now()) - activeThinkingTs) / 1000)) })
              : statusText}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {modelLabel && <span class="session-usage-model">{modelLabel}</span>}
          {total > 0 && <span class="session-usage-tokens">{fmt(total)} / {fmt(ctx)} ({pctStr}%)</span>}
          {inlineQuotaText && codexQuotaLines.length === 0 && <span class="session-usage-tokens">{inlineQuotaText}</span>}
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
