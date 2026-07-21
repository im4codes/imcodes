import type { CodexStatusSnapshot } from '@shared/codex-status.js';
import {
  isAuthoritativeUsageContextWindowSource,
  isUsageContextWindowSource,
  usageContextWindowSourceRank,
  type UsageContextWindowSource,
} from '@shared/usage-context-window.js';
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
    { preferExplicit: isAuthoritativeUsageContextWindowSource(payload.contextWindowSource) },
  );
  const total = inputTokens + cacheTokens;
  // Provider context meters describe current prompt/window occupancy, not
  // cumulative billing totals. A live context snapshot cannot materially exceed
  // the window; stale Codex/Cursor builds have emitted cumulative totals that
  // made the UI show impossible values like "1.3M / 1M". Skip those snapshots
  // and fall back to the latest plausible usage/model event.
  return total <= contextWindow * MAX_CONTEXT_USAGE_OVERRUN_RATIO;
}

export function mergeUsageUpdate(
  previous: UsageData | undefined,
  payload: Record<string, unknown>,
): UsageData | null {
  const next: UsageData = previous
    ? { ...previous }
    : { inputTokens: 0, cacheTokens: 0, contextWindow: 0 };
  let changed = false;

  const hasTokenSnapshot = typeof payload.inputTokens === 'number';
  const payloadIsPlausible = hasTokenSnapshot && isPlausibleUsagePayload(payload);
  const incomingContextSource = isUsageContextWindowSource(payload.contextWindowSource)
    ? payload.contextWindowSource
    : undefined;
  const modelChanged = typeof previous?.model === 'string'
    && typeof payload.model === 'string'
    && previous.model !== payload.model;
  const contextSourceIsCurrent = modelChanged
    || usageContextWindowSourceRank(incomingContextSource) >= usageContextWindowSourceRank(next.contextWindowSource);
  if (
    typeof payload.contextWindow === 'number'
    && Number.isFinite(payload.contextWindow)
    && payload.contextWindow > 0
    && (!hasTokenSnapshot || payloadIsPlausible)
    && contextSourceIsCurrent
  ) {
    next.contextWindow = payload.contextWindow;
    next.contextWindowSource = incomingContextSource;
    changed = true;
  }
  if (typeof payload.model === 'string' && payload.model) {
    next.model = payload.model;
    changed = true;
  }
  if (isCodexStatusSnapshot(payload.codexStatus)) {
    next.codexStatus = payload.codexStatus;
    changed = true;
  }

  const candidate = {
    ...payload,
    ...(next.contextWindow > 0 ? {
      contextWindow: next.contextWindow,
      ...(next.contextWindowSource ? { contextWindowSource: next.contextWindowSource } : {}),
    } : {}),
    ...(next.model ? { model: next.model } : {}),
  };
  if (isPlausibleUsagePayload(candidate)) {
    next.inputTokens = payload.inputTokens as number;
    next.cacheTokens = typeof payload.cacheTokens === 'number' ? payload.cacheTokens : 0;
    changed = true;
  }

  return changed ? next : (previous ?? null);
}

export function extractLatestUsage(events: TimelineEvent[]): UsageData | null {
  let tokensFound = false;
  let contextFound = false;
  let modelFound = false;
  let codexFound = false;
  const usage: UsageData = { inputTokens: 0, cacheTokens: 0, contextWindow: 0 };

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'usage.update') continue;
    const payload = event.payload as Record<string, unknown>;

    const hasTokenSnapshot = typeof payload.inputTokens === 'number';
    const contextMetadataIsUsable = !hasTokenSnapshot || isPlausibleUsagePayload(payload);
    if (
      !contextFound
      && contextMetadataIsUsable
      && typeof payload.contextWindow === 'number'
      && Number.isFinite(payload.contextWindow)
      && payload.contextWindow > 0
    ) {
      usage.contextWindow = payload.contextWindow;
      if (isUsageContextWindowSource(payload.contextWindowSource)) {
        usage.contextWindowSource = payload.contextWindowSource;
      }
      contextFound = true;
    }
    if (!modelFound && typeof payload.model === 'string') {
      usage.model = payload.model;
      modelFound = true;
    }

    // Claude-compatible SDKs can publish the authoritative preset/model window
    // in a metadata-only completion and publish token occupancy in an earlier
    // frame. Validate the older token snapshot against the newest metadata,
    // rather than letting a stale launch-time 200k window hide a current 1M
    // preset update.
    const effectivePayload = {
      ...payload,
      ...(contextFound ? {
        contextWindow: usage.contextWindow,
        ...(usage.contextWindowSource ? { contextWindowSource: usage.contextWindowSource } : {}),
      } : {}),
      ...(modelFound && usage.model ? { model: usage.model } : {}),
    };
    if (!tokensFound && isPlausibleUsagePayload(effectivePayload)) {
      usage.inputTokens = payload.inputTokens as number;
      usage.cacheTokens = typeof payload.cacheTokens === 'number' ? payload.cacheTokens : 0;
      if (!contextFound) {
        usage.contextWindow = typeof payload.contextWindow === 'number' ? payload.contextWindow : 0;
        if (isUsageContextWindowSource(payload.contextWindowSource)) {
          usage.contextWindowSource = payload.contextWindowSource;
        }
      }
      tokensFound = true;
    }
    if (!codexFound && isCodexStatusSnapshot(payload.codexStatus)) {
      usage.codexStatus = payload.codexStatus;
      codexFound = true;
    }
    if (tokensFound && contextFound && modelFound && codexFound) break;
  }

  return tokensFound || contextFound || modelFound || codexFound ? usage : null;
}
