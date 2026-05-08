/**
 * UsageFooter — shared context bar + usage stats + cost display.
 * Used by both main session (app.tsx) and SubSessionWindow.
 */
import { useEffect, useMemo, useState, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { getSessionCost, getWeeklyCost, getMonthlyCost, formatCost } from '../cost-tracker.js';
import type { UsageData } from '../usage-data.js';
import { formatProviderQuotaLabel, type ProviderQuotaMeta } from '@shared/provider-quota.js';
import { USAGE_CONTEXT_WINDOW_SOURCES } from '@shared/usage-context-window.js';
import { usePref, parseBooleanish } from '../hooks/usePref.js';
import { PREF_KEY_SHOW_TOOL_CALLS } from '../constants/prefs.js';

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
  /** Whether the current live tail is an active tool call. */
  activeToolCall?: boolean;
  /** Current timestamp for thinking timer (updated every second). */
  now?: number;
}

const fmt = (n: number) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(0)}k`
  : String(n);

export function UsageFooter({ usage, sessionName, sessionState, agentType, modelOverride, planLabel, quotaLabel, quotaUsageLabel, quotaMeta, showCost, activeThinkingTs, statusText, activeToolCall, now }: Props) {
  const { t } = useTranslation();
  const isCodexFamily = agentType === 'codex' || agentType === 'codex-sdk';
  // Wrench pill: tri-state toggle for "show developer details in chat timeline".
  // Sourced from usePref → SharedResource, so this UsageFooter and ChatView
  // share one GET / one listener / one cache entry per tab.
  //   value === null  → undecided (first run; defaults ON, pill shows prompt)
  //   value === true  → developer view (pill highlighted, details visible)
  //   value === false → simple chat (pill dim, details hidden)
  const showToolCallsPref = usePref<boolean>(PREF_KEY_SHOW_TOOL_CALLS, { parse: parseBooleanish });
  const showToolCallsValue = showToolCallsPref.value;
  const showToolCallsLoaded = showToolCallsPref.loaded;
  const showToolCallsActive = showToolCallsValue !== false;
  const showToolCallsUndecided = showToolCallsLoaded && showToolCallsValue === null;
  const handleShowToolCallsToggle = useCallback(() => {
    // Tri-state click cycle:
    //   undecided → false (Simple; default is already Developer)
    //   true      → false (Simple)
    //   false     → true (Developer)
    // Once decided, the pill is a plain on/off toggle. The first click from
    // an undecided state closes the developer details the user is already
    // seeing by default.
    const next = showToolCallsValue === false ? true : false;
    void showToolCallsPref.save(next);
  }, [showToolCallsPref, showToolCallsValue]);
  // shell / script sessions are NOT agents — they're plain terminals. The
  // daemon emits `session.state(running)` whenever raw bytes flow (idle
  // detection runs even without a structured watcher), which previously
  // surfaced as "Agent working..." in the footer. That wording is wrong
  // for a shell prompt and confusing for users running `top`, tailing logs,
  // etc. Skip the live-work UI entirely for these session types.
  const isAgentless = agentType === 'shell' || agentType === 'script';
  const hasActiveLiveWork = !isAgentless && (!!activeToolCall || !!activeThinkingTs);
  const showLiveStatus = !isAgentless && (sessionState === 'running' || sessionState === 'idle' || hasActiveLiveWork);
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
    const ctx = resolveContextWindow(
      usage.contextWindow,
      displayModel,
      1_000_000,
      { preferExplicit: usage.contextWindowSource === USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER },
    );
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
  }, [usage.inputTokens, usage.cacheTokens, usage.contextWindow, usage.contextWindowSource, displayModel, displayPlanLabel, displayQuotaLabel, quotaUsageLabel, t]);

  const sessionCost = showCost ? getSessionCost(sessionName) : 0;
  const weeklyCost = sessionCost > 0 ? getWeeklyCost() : 0;
  const monthlyCost = sessionCost > 0 ? getMonthlyCost() : 0;
  const modelLabel = shortModelLabel(displayModel);
  // Keep the ctx meter visible even before the first non-zero usage event when
  // the session/model is known. A zero-token session still has useful context
  // capacity information (e.g. "0 / 922k" for GPT-5.5); hiding it made Codex
  // SDK sessions look like ctx tracking had disappeared after stale cumulative
  // usage snapshots were filtered out.
  const hasContextInfo = total > 0 || (usage.contextWindow ?? 0) > 0 || !!modelLabel;
  const inlineQuotaText = displayQuotaLabel;
  const liveStatusMode = isAgentless
    ? null
    : hasActiveLiveWork
      ? (activeToolCall ? 'tool' : 'thinking')
      : sessionState === 'running'
        ? 'running'
        : sessionState === 'idle'
          ? (statusText ? (/^(?:supervised|auto):/i.test(statusText) ? 'result' : 'waiting') : 'idle')
          : null;
  const liveStatusText = useMemo(() => {
    if (isAgentless) return null;
    if (hasActiveLiveWork || sessionState === 'running') {
      if (activeToolCall) return statusText || 'Tool running...';
      if (activeThinkingTs) return t('chat.thinking_running', { sec: Math.max(0, Math.round(((now ?? Date.now()) - activeThinkingTs) / 1000)) });
      return 'Agent working...';
    }
    if (sessionState === 'idle' && statusText) return statusText;
    if (sessionState === 'idle') return 'Agent idle — waiting for input';
    return null;
  }, [activeThinkingTs, activeToolCall, hasActiveLiveWork, isAgentless, now, sessionState, statusText, t]);
  const showInlineStatusText = liveStatusMode === 'running' || liveStatusMode === 'thinking' || liveStatusMode === 'tool' || liveStatusMode === 'waiting' || liveStatusMode === 'result';
  const codexQuotaLines = (agentType === 'codex' || agentType === 'codex-sdk')
    ? (displayQuotaLabel ?? '').split(' · ').filter(Boolean)
    : [];
  return (
    <div class="session-usage-footer" title={tip} data-agent-type={agentType ?? undefined}>
      {hasContextInfo && (
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
        {showLiveStatus && liveStatusText && liveStatusMode && (
          <span class={`session-live-status-inline ${liveStatusMode}`} title={liveStatusText} aria-label={liveStatusText}>
            <span class="session-live-status-emoji robot">🤖</span>
            {liveStatusMode === 'running' && <span class="session-live-status-emoji gear">⚙️</span>}
            {liveStatusMode === 'thinking' && <span class="session-live-status-emoji thought">💭</span>}
            {liveStatusMode === 'tool' && <span class="session-live-status-emoji tool">🔍</span>}
            {liveStatusMode === 'waiting' && <span class="session-live-status-emoji wait">⏳</span>}
            {liveStatusMode === 'result' && <span class="session-live-status-emoji result">✅</span>}
            {liveStatusMode === 'idle' && <span class="session-live-status-emoji sleep">💤</span>}
            {showInlineStatusText && <span class="session-live-status-text">{liveStatusText}</span>}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span class="shortcut-btn-tools-wrapper">
            {/* Undecided-state bubble. Points the user at the wrench so the
             *  first-run choice surface is obvious even before they scroll
             *  the chat (where the larger chooser banner lives). The bubble
             *  unmounts automatically the moment `showToolCallsUndecided`
             *  flips false — picking either banner button or clicking the
             *  wrench saves the pref, which clears the undecided state. */}
            {showToolCallsUndecided && (
              <span
                class="shortcut-btn-tools-bubble"
                role="status"
                aria-live="polite"
              >
                {t('chat.tool_calls_choose_prompt')}
              </span>
            )}
            <button
              type="button"
              class={`shortcut-btn shortcut-btn-icon shortcut-btn-tools${showToolCallsActive ? ' is-on' : ''}${showToolCallsUndecided ? ' is-undecided' : ''}`}
              title={
                showToolCallsActive
                  ? t('chat.tool_calls_toggle_hide')
                  : showToolCallsUndecided
                    ? t('chat.tool_calls_toggle_undecided')
                    : t('chat.tool_calls_toggle_show')
              }
              aria-label={
                showToolCallsActive
                  ? t('chat.tool_calls_toggle_hide')
                  : t('chat.tool_calls_toggle_show')
              }
              aria-pressed={showToolCallsActive}
              onClick={handleShowToolCallsToggle}
            >
              🛠
            </button>
          </span>
          {modelLabel && <span class="session-usage-model">{modelLabel}</span>}
          {hasContextInfo && <span class="session-usage-tokens">{fmt(total)} / {fmt(ctx)} ({pctStr}%)</span>}
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
