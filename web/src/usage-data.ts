import type { CodexStatusSnapshot } from '@shared/codex-status.js';
import { isUsageContextWindowSource, type UsageContextWindowSource } from '@shared/usage-context-window.js';
import type { TimelineEvent } from './ws-client.js';
import { resolveContextWindow } from './model-context.js';

export interface UsageData {
  inputTokens: number;
  cacheTokens: number;
  contextWindow: number;
  contextWindowSource?: UsageContextWindowSource;
  model?: string;
  codexStatus?: CodexStatusSnapshot;
}

const MAX_CONTEXT_USAGE_OVERRUN_RATIO = 1.05;

function isCodexStatusSnapshot(value: unknown): value is CodexStatusSnapshot {
  return !!value && typeof value === 'object' && 'capturedAt' in value;
}

export function isPlausibleUsagePayload(payload: Record<string, unknown>): boolean {
  if (typeof payload.inputTokens !== 'number') return false;
  const inputTokens = payload.inputTokens;
  const cacheTokens = typeof payload.cacheTokens === 'number' ? payload.cacheTokens : 0;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cacheTokens) || inputTokens < 0 || cacheTokens < 0) {
    return false;
  }
  if (typeof payload.contextWindow !== 'number' || !Number.isFinite(payload.contextWindow) || payload.contextWindow <= 0) {
    return true;
  }
  const contextWindow = resolveContextWindow(
    payload.contextWindow,
    typeof payload.model === 'string' ? payload.model : undefined,
    1_000_000,
    { preferExplicit: payload.contextWindowSource === 'provider' },
  );
  const total = inputTokens + cacheTokens;
  // Provider context meters describe current prompt/window occupancy, not
  // cumulative billing totals. A live context snapshot cannot materially exceed
  // the window; stale Codex/Cursor builds have emitted cumulative totals that
  // made the UI show impossible values like "1.3M / 1M". Skip those snapshots
  // and fall back to the latest plausible usage/model event.
  return total <= contextWindow * MAX_CONTEXT_USAGE_OVERRUN_RATIO;
}

export function extractLatestUsage(events: TimelineEvent[]): UsageData | null {
  let tokensFound = false;
  let modelFound = false;
  let codexFound = false;
  const usage: UsageData = { inputTokens: 0, cacheTokens: 0, contextWindow: 0 };

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'usage.update') continue;
    const payload = event.payload as Record<string, unknown>;

    if (!tokensFound && isPlausibleUsagePayload(payload)) {
      usage.inputTokens = payload.inputTokens as number;
      usage.cacheTokens = typeof payload.cacheTokens === 'number' ? payload.cacheTokens : 0;
      usage.contextWindow = typeof payload.contextWindow === 'number' ? payload.contextWindow : 0;
      if (isUsageContextWindowSource(payload.contextWindowSource)) {
        usage.contextWindowSource = payload.contextWindowSource;
      }
      tokensFound = true;
    }
    if (!modelFound && typeof payload.model === 'string') {
      usage.model = payload.model;
      modelFound = true;
    }
    if (!codexFound && isCodexStatusSnapshot(payload.codexStatus)) {
      usage.codexStatus = payload.codexStatus;
      codexFound = true;
    }
    if (tokensFound && modelFound && codexFound) break;
  }

  return tokensFound || modelFound || codexFound ? usage : null;
}
