/**
 * The context window a transport session's usage is measured against: the
 * provider-reported window when it sends one, else the session's preset window
 * (the configured authority for third-party models), else the model's known
 * window. One resolution for the usage display and automatic compaction, so
 * the two never disagree -- Claude, for instance, reports no window at all.
 */
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';
import { USAGE_CONTEXT_WINDOW_SOURCES } from '../../shared/usage-context-window.js';
import { getSession } from '../store/session-store.js';
import { resolveContextWindow } from '../util/model-context.js';
import { getCachedPresetContextWindow } from './cc-presets.js';

export interface SessionContextWindow {
  contextWindow: number;
  effectiveModel?: string;
  source?: typeof USAGE_CONTEXT_WINDOW_SOURCES[keyof typeof USAGE_CONTEXT_WINDOW_SOURCES];
}

export function resolveSessionContextWindow(
  sessionName: string,
  providerContextWindow: unknown,
  model: string | undefined,
): SessionContextWindow {
  const session = getSession(sessionName);
  const effectiveModel = resolveEffectiveSessionModel(session, model);
  // A preset can be edited while an SDK session remains alive. Prefer the
  // current preset cache over the launch-time copy stored on that session so a
  // changed 1M window takes effect on the very next usage frame.
  const cachedPresetCtx = session?.ccPreset ? getCachedPresetContextWindow(session.ccPreset) : undefined;
  const presetCtx = cachedPresetCtx ?? session?.presetContextWindow;
  const explicit = typeof providerContextWindow === 'number' && Number.isFinite(providerContextWindow) && providerContextWindow > 0
    ? providerContextWindow
    : undefined;
  const contextWindow = resolveContextWindow(
    explicit ?? presetCtx,
    effectiveModel,
    1_000_000,
    { preferExplicit: explicit !== undefined || presetCtx !== undefined },
  );
  const source = explicit !== undefined && contextWindow === explicit
    ? USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER
    : presetCtx !== undefined && contextWindow === presetCtx
      ? USAGE_CONTEXT_WINDOW_SOURCES.PRESET
      : undefined;
  return { contextWindow, ...(effectiveModel ? { effectiveModel } : {}), ...(source ? { source } : {}) };
}
