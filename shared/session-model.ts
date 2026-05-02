export interface SessionModelMetadata {
  activeModel?: string | null;
  requestedModel?: string | null;
  modelDisplay?: string | null;
  qwenModel?: string | null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the effective model a session is running for context-window and UI
 * display decisions. Provider usage events are not guaranteed to include a
 * model on every update, so all daemon/web callers must use the same fallback
 * order before resolving model-family limits.
 */
export function resolveEffectiveSessionModel(
  session: SessionModelMetadata | null | undefined,
  ...fallbacks: Array<string | null | undefined>
): string | undefined {
  return nonEmpty(session?.activeModel)
    ?? nonEmpty(session?.requestedModel)
    ?? nonEmpty(session?.modelDisplay)
    ?? nonEmpty(session?.qwenModel)
    ?? fallbacks.map(nonEmpty).find((value): value is string => value !== undefined);
}
