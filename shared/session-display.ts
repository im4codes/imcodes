function normalizeDisplayValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isInternalSessionDisplayValue(value: string | null | undefined, sessionName?: string | null): boolean {
  const normalized = normalizeDisplayValue(value);
  if (!normalized) return true;
  const normalizedSession = normalizeDisplayValue(sessionName);
  if (normalizedSession && normalized === normalizedSession) return true;
  if (/^deck_sub_[a-z0-9-]+$/i.test(normalized)) return true;
  if (/^deck_.+_(brain|w\d+)$/i.test(normalized)) return true;
  return false;
}

export function pickReadableSessionDisplay(
  candidates: Array<string | null | undefined>,
  sessionName?: string | null,
): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeDisplayValue(candidate);
    if (!normalized) continue;
    if (isInternalSessionDisplayValue(normalized, sessionName)) continue;
    return normalized;
  }
  return undefined;
}
