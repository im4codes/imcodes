export const SUBSESSION_ACCENT_COLORS = [
  '#38bdf8',
  '#a78bfa',
  '#fb7185',
  '#34d399',
  '#f59e0b',
  '#22d3ee',
  '#f472b6',
  '#84cc16',
  '#60a5fa',
  '#c084fc',
  '#f97316',
  '#2dd4bf',
  '#e879f9',
  '#facc15',
  '#4ade80',
] as const;

export const DEFAULT_SUBSESSION_ACCENT_COLOR = SUBSESSION_ACCENT_COLORS[0];

export function getSubSessionAccentColor(index: number): string {
  const normalized = Number.isFinite(index) ? Math.trunc(index) : 0;
  const paletteIndex = ((normalized % SUBSESSION_ACCENT_COLORS.length) + SUBSESSION_ACCENT_COLORS.length) % SUBSESSION_ACCENT_COLORS.length;
  return SUBSESSION_ACCENT_COLORS[paletteIndex];
}

export function getSubSessionAccentColorMap<T extends { id: string }>(subSessions: readonly T[]): Map<string, string> {
  return new Map(subSessions.map((sub, index) => [sub.id, getSubSessionAccentColor(index)]));
}
