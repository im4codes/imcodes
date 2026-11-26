import { CLIENT_TIMEZONE_PREF_KEY, normalizeClientTimezone } from '../../../shared/client-timezone.js';
import type { Database } from '../db/client.js';
import { getUserPref, setUserPref } from '../db/queries.js';

export async function rememberClientTimezone(
  db: Database,
  userId: string,
  value: unknown,
): Promise<string | null> {
  const timezone = normalizeClientTimezone(value);
  if (!timezone) return null;
  await setUserPref(db, userId, CLIENT_TIMEZONE_PREF_KEY, JSON.stringify(timezone));
  return timezone;
}

export async function loadRememberedClientTimezone(
  db: Database,
  userId: string,
): Promise<string | null> {
  const raw = await getUserPref(db, userId, CLIENT_TIMEZONE_PREF_KEY);
  if (raw === null) return null;
  try {
    return normalizeClientTimezone(JSON.parse(raw));
  } catch {
    return null;
  }
}
