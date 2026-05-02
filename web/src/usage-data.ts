import type { CodexStatusSnapshot } from '@shared/codex-status.js';
import { isUsageContextWindowSource, type UsageContextWindowSource } from '@shared/usage-context-window.js';
import type { TimelineEvent } from './ws-client.js';

export interface UsageData {
  inputTokens: number;
  cacheTokens: number;
  contextWindow: number;
  contextWindowSource?: UsageContextWindowSource;
  model?: string;
  codexStatus?: CodexStatusSnapshot;
}

const IMPOSSIBLE_CONTEXT_USAGE_MULTIPLIER = 50;

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
  const total = inputTokens + cacheTokens;
  // Older Codex/Codex-SDK builds accidentally emitted cumulative billing totals
  // as live ctx usage. Keep historical timelines readable by skipping values
  // that are orders of magnitude larger than any possible context window.
  return total <= payload.contextWindow * IMPOSSIBLE_CONTEXT_USAGE_MULTIPLIER;
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
