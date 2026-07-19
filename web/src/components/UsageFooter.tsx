/**
 * UsageFooter — shared context bar + usage stats + cost display.
 * Used by both main session (app.tsx) and SubSessionWindow.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { resolveContextWindow } from '../model-context.js';
import { bestModelLabel } from '../model-label.js';
import { getSessionCost, getWeeklyCost, getMonthlyCost, formatCost } from '../cost-tracker.js';
import { deriveSessionLiveStatus } from '../session-live-status.js';
import type { UsageData } from '../usage-data.js';
import { formatProviderQuotaLabel, type ProviderQuotaMeta } from '@shared/provider-quota.js';
import { isAuthoritativeUsageContextWindowSource } from '@shared/usage-context-window.js';
import { usePref, parseBooleanish } from '../hooks/usePref.js';
import { PREF_KEY_SHOW_TOOL_CALLS } from '../constants/prefs.js';
import { CLAUDE_WEEKLY_QUOTA_PREF_KEY } from '@shared/claude-quota.js';
import { CodexResetCredits } from './CodexResetCredits.js';
import { SessionUsagePanel } from './SessionUsagePanel.js';
import type { WsClient } from '../ws-client.js';

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
  /** Whether the current timeline tail still has an active transport turn. */
  activeTimelineTurn?: boolean;
  /** Whether this browser is still tracking an unresolved optimistic send. */
  pendingUserSend?: boolean;
  /** Safe transport activity/error detail extracted from session.state payloads. */
  transportActivityDetail?: string | null;
  /** Session-list error reason when no timeline error detail is present. */
  sessionError?: string | null;
  /** Current timestamp for thinking timer (updated every second). */
  now?: number;
  /** Sends recent memory summaries into the current agent as sync-only context. */
  onSyncMemorySummaries?: () => void;
  syncMemorySummariesBusy?: boolean;
  syncMemorySummariesDisabled?: boolean;
  /** Dispatches the current composer task to dedicated execution clones. */
  onRunExecutionClones?: () => void;
  runExecutionClonesBusy?: boolean;
  runExecutionClonesDisabled?: boolean;
  runExecutionClonesTitle?: string;
  runExecutionClonesCount?: number;
  /** WS client — enables the Codex reset-credits affordance (codex sessions). */
  wsClient?: WsClient | null;
  connected?: boolean;
}

const fmt = (n: number) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(0)}k`
  : String(n);

export function UsageFooter({ usage, sessionName, sessionState, agentType, modelOverride, planLabel, quotaLabel, quotaUsageLabel, quotaMeta, showCost, activeThinkingTs, statusText, activeToolCall, activeTimelineTurn, pendingUserSend, transportActivityDetail, sessionError, now, onSyncMemorySummaries, syncMemorySummariesBusy, syncMemorySummariesDisabled, onRunExecutionClones, runExecutionClonesBusy, runExecutionClonesDisabled, runExecutionClonesTitle, runExecutionClonesCount, wsClient, connected }: Props) {
  const { t } = useTranslation();
  const [sessionUsageOpen, setSessionUsageOpen] = useState(false);

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
  const liveStatus = deriveSessionLiveStatus({
    sessionState,
    activeThinking: !!activeThinkingTs,
    activeToolCall: !!activeToolCall,
    activeTransportTurn: !!activeTimelineTurn,
    pendingUserSend: !!pendingUserSend,
    statusText,
    transportActivityDetail,
    sessionError,
    isAgentless,
  });
  const showLiveStatus = !isAgentless;
  const [quotaNow, setQuotaNow] = useState(() => Date.now());
  const [ctxBurning, setCtxBurning] = useState(false);
  const previousCtxSignatureRef = useRef<string | null>(null);

  const displayModel = modelOverride ?? usage.model;
  // Live-tick the quota label (so "resets in Xm" stays current) for ANY provider
  // that reports structured quota windows — Codex and claude-code-sdk both feed
  // `quotaMeta`; the gate is its presence, not the agent family.
  useEffect(() => {
    if (!quotaMeta) return;
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
  }, [quotaMeta]);

  const displayQuotaLabel = useMemo(() => {
    if (!quotaMeta) return quotaLabel;
    return formatProviderQuotaLabel(quotaMeta, now ?? quotaNow) ?? quotaLabel;
  }, [now, quotaLabel, quotaMeta, quotaNow]);

  const displayPlanLabel = useMemo(() => {
    const normalized = planLabel?.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'free') return t('session.provider_plan_free');
    if (normalized === 'paid') return t('session.provider_plan_paid');
    if (normalized === 'byo') return t('session.provider_plan_byo');
    return planLabel;
  }, [planLabel, t]);

  const { ctx, total, totalPct, cachePct, newPct, pctStr, tip } = useMemo(() => {
    const ctx = resolveContextWindow(
      usage.contextWindow,
      displayModel,
      1_000_000,
      { preferExplicit: isAuthoritativeUsageContextWindowSource(usage.contextWindowSource) },
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

  // Prefer a version-bearing label: modelOverride is often a bare alias
  // (`opus[1M]` → `opus`) while usage.model carries the resolved id
  // (`claude-opus-4-8` → `opus-4.8`).
  const modelLabel = bestModelLabel(modelOverride, usage.model);
  // Keep the ctx meter visible even before the first non-zero usage event when
  // the session/model is known. A zero-token session still has useful context
  // capacity information (e.g. "0 / 922k" for GPT-5.5); hiding it made Codex
  // SDK sessions look like ctx tracking had disappeared after stale cumulative
  // usage snapshots were filtered out.
  const hasContextInfo = total > 0 || (usage.contextWindow ?? 0) > 0 || !!modelLabel;

  useEffect(() => {
    if (!hasContextInfo) {
      previousCtxSignatureRef.current = null;
      setCtxBurning(false);
      return;
    }
    const signature = `${total}:${cachePct.toFixed(3)}:${newPct.toFixed(3)}:${ctx}`;
    const previousSignature = previousCtxSignatureRef.current;
    previousCtxSignatureRef.current = signature;
    if (!previousSignature || previousSignature === signature) return;

    setCtxBurning(true);
    const timeoutId = window.setTimeout(() => setCtxBurning(false), 780);
    return () => window.clearTimeout(timeoutId);
  }, [cachePct, ctx, hasContextInfo, newPct, total]);

  const sessionCost = showCost ? getSessionCost(sessionName) : 0;
  const weeklyCost = sessionCost > 0 ? getWeeklyCost() : 0;
  const monthlyCost = sessionCost > 0 ? getMonthlyCost() : 0;
  const inlineQuotaText = displayQuotaLabel;
  const liveStatusMode = liveStatus.visualMode;
  const liveStatusText = useMemo(() => {
    if (isAgentless || !liveStatusMode) return null;
    if (liveStatusMode === 'error') {
      return liveStatus.errorDetail
        ? t('session.state_error_detail', {
          error: liveStatus.errorDetail,
          defaultValue: 'Error: {{error}}',
        })
        : t('session.state_error', { defaultValue: 'Session error' });
    }
    if (liveStatusMode === 'stopping') return t('session.state_stop_requested');
    if (liveStatusMode === 'cancelled') {
      return liveStatus.errorDetail
        ? t('session.state_error_detail', {
          error: liveStatus.errorDetail,
          defaultValue: 'Error: {{error}}',
        })
        : t('session.state_stop_requested');
    }
    if (liveStatusMode === 'result') return statusText || t('session.state_idle');
    if (liveStatusMode === 'waiting') return statusText || t('session.state_idle');
    if (liveStatus.sweep) {
      if (activeToolCall) return statusText || t('session.state_running');
      if (activeThinkingTs) return t('chat.thinking_running', { sec: Math.max(0, Math.round(((now ?? Date.now()) - activeThinkingTs) / 1000)) });
      if (liveStatus.activityDetail) {
        return t('session.state_running_detail', {
          detail: liveStatus.activityDetail,
          defaultValue: 'Agent working: {{detail}}',
        });
      }
      return t('session.state_running');
    }
    return t('session.state_idle');
  }, [activeThinkingTs, activeToolCall, isAgentless, liveStatus.activityDetail, liveStatus.errorDetail, liveStatus.sweep, liveStatusMode, now, statusText, t]);
  const showInlineStatusText = liveStatusMode === 'running' || liveStatusMode === 'thinking' || liveStatusMode === 'tool' || liveStatusMode === 'waiting' || liveStatusMode === 'stopping' || liveStatusMode === 'cancelled' || liveStatusMode === 'result' || liveStatusMode === 'error';
  // The weekly (7d) line is opt-in: it needs the daemon to read the local
  // Claude token. The 5h line needs no authorization (it comes from the SDK
  // rate_limit_event). Show an authorize affordance for claude-code-sdk until
  // the user opts in (per-user pref → applies to all their servers).
  const weeklyQuotaPref = usePref<boolean>(CLAUDE_WEEKLY_QUOTA_PREF_KEY, { parse: parseBooleanish });
  const showWeeklyAuthPrompt = agentType === 'claude-code-sdk' && weeklyQuotaPref.value !== true;
  // Providers that report structured quota windows (Codex + claude-code-sdk)
  // render the SAME prominent multi-line quota block as Codex — not the inline
  // bottom token span — so the limit display is consistent across providers.
  const providerQuotaLines = (agentType === 'codex' || agentType === 'codex-sdk' || agentType === 'claude-code-sdk')
    ? (displayQuotaLabel ?? '').split(' · ').filter(Boolean)
    : [];
  // Reset credits are a codex-account feature (accrued via ChatGPT auth).
  const isCodexSession = agentType === 'codex' || agentType === 'codex-sdk';
  return (
    <div class="session-usage-footer" title={tip} data-agent-type={agentType ?? undefined}>
      {sessionUsageOpen && (
        <SessionUsagePanel targetSessionName={sessionName} onClose={() => setSessionUsageOpen(false)} />
      )}
      {hasContextInfo && (
        <div class={`session-ctx-bar${ctxBurning ? ' is-burning' : ''}`}>
          <div class="session-ctx-cache" style={{ width: `${cachePct}%` }} />
          <div class="session-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
          {ctxBurning && <span class="session-ctx-burn" style={{ width: `${totalPct}%` }} aria-hidden="true" />}
        </div>
      )}
      {(providerQuotaLines.length > 0 || showWeeklyAuthPrompt || isCodexSession) && (
        <div class="session-usage-codex-row">
          {isCodexSession && wsClient && (
            <CodexResetCredits wsClient={wsClient} connected={connected !== false} />
          )}
          {(providerQuotaLines.length > 0 || showWeeklyAuthPrompt) && (
            <div class="session-usage-codex-quota">
              {providerQuotaLines.map((line) => (
                <div class="session-usage-codex-line">{line}</div>
              ))}
              {showWeeklyAuthPrompt && (
                <button
                  type="button"
                  class="session-usage-codex-line session-usage-weekly-authorize"
                  title={t('session.weekly_quota_authorize_hint')}
                  onClick={() => {
                    // Explicit consent before reading the local Claude token — not
                    // a one-click toggle.
                    if (typeof window !== 'undefined' && window.confirm(t('session.weekly_quota_confirm'))) {
                      void weeklyQuotaPref.save(true);
                    }
                  }}
                >
                  {t('session.weekly_quota_authorize')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div class="session-usage-stats">
        {showLiveStatus && liveStatusText && liveStatusMode && (
          <span class={`session-live-status-inline ${liveStatusMode}`} title={liveStatusText} aria-label={liveStatusText}>
            <img
              class="session-live-status-emoji robot session-live-status-robot-avatar"
              src="/imcodes-robot-avatar.png"
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            {liveStatusMode === 'running' && <span class="session-live-status-emoji gear">⚙️</span>}
            {liveStatusMode === 'thinking' && <span class="session-live-status-emoji thought">💭</span>}
            {liveStatusMode === 'tool' && <span class="session-live-status-emoji tool">🔍</span>}
            {liveStatusMode === 'waiting' && <span class="session-live-status-emoji wait">⏳</span>}
            {liveStatusMode === 'stopping' && <span class="session-live-status-emoji wait">■</span>}
            {liveStatusMode === 'cancelled' && <span class="session-live-status-emoji error">⚠️</span>}
            {liveStatusMode === 'result' && <span class="session-live-status-emoji result">✅</span>}
            {liveStatusMode === 'error' && <span class="session-live-status-emoji error">⚠️</span>}
            {liveStatusMode === 'idle' && <span class="session-live-status-emoji sleep">💤</span>}
            {showInlineStatusText && <span class="session-live-status-text">{liveStatusText}</span>}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {onRunExecutionClones && (
            <button
              type="button"
              class={`shortcut-btn shortcut-btn-icon shortcut-btn-execution-clones${runExecutionClonesBusy ? ' is-busy' : ''}`}
              title={runExecutionClonesTitle ?? t('chat.execution_clone_run')}
              aria-label={runExecutionClonesTitle ?? t('chat.execution_clone_run')}
              disabled={runExecutionClonesDisabled}
              onClick={onRunExecutionClones}
            >
              <span aria-hidden="true">🤖</span>
              {runExecutionClonesCount && runExecutionClonesCount > 1 ? (
                <span class="shortcut-btn-mini-count" aria-hidden="true">×{runExecutionClonesCount}</span>
              ) : null}
            </button>
          )}
          <button
            type="button"
            class="shortcut-btn shortcut-btn-icon shortcut-btn-session-usage"
            title={t('sessionUsage.open')}
            aria-label={t('sessionUsage.open')}
            onClick={() => setSessionUsageOpen(true)}
          >
            📊
          </button>
          {onSyncMemorySummaries && (
            <button
              type="button"
              class={`shortcut-btn shortcut-btn-icon shortcut-btn-memory-sync${syncMemorySummariesBusy ? ' is-busy' : ''}`}
              title={syncMemorySummariesBusy ? t('chat.memory_summary_sync_busy') : t('chat.memory_summary_sync')}
              aria-label={syncMemorySummariesBusy ? t('chat.memory_summary_sync_busy') : t('chat.memory_summary_sync')}
              disabled={syncMemorySummariesDisabled}
              onClick={onSyncMemorySummaries}
            >
              ↻
            </button>
          )}
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
          {inlineQuotaText && providerQuotaLines.length === 0 && <span class="session-usage-tokens">{inlineQuotaText}</span>}
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
