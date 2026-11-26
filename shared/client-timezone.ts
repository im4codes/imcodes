export const CLIENT_TIMEZONE_PREF_KEY = 'client.timezone.v1' as const;

export function normalizeClientTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timezone = value.trim();
  if (!timezone || timezone.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return null;
  }
}
