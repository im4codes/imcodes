type RuntimeIdentity = { sessionInstanceId: string; runtimeEpoch: string };
type Entry = RuntimeIdentity & { authority: string | null; expiresAt: number };

const ACTIVE_CONTEXT_TTL_MS = 10 * 60 * 1000;
const entries = new Map<string, Entry>();

export function bindProcessSharedMachineAuthority(
  sessionName: string,
  identity: RuntimeIdentity | null,
  authority: string | undefined,
  required: boolean,
  now = Date.now(),
): void {
  entries.delete(sessionName);
  if (!required || !identity) return;
  // Keep the `required` marker even when the hand-off token is missing. A
  // participant turn must never degrade into the ordinary source-owner path
  // merely because token propagation failed.
  entries.set(sessionName, {
    ...identity,
    authority: authority || null,
    expiresAt: now + ACTIVE_CONTEXT_TTL_MS,
  });
}

export function readProcessSharedMachineAuthority(
  sessionName: string,
  identity: RuntimeIdentity,
  now = Date.now(),
): { required: boolean; authority: string | null } {
  const entry = entries.get(sessionName);
  if (!entry) return { required: false, authority: null };
  if (entry.expiresAt <= now) {
    // Preserve the deny marker until the next admitted non-shared turn clears
    // it. Deleting it here would make the next MCP call look owner-authored.
    return { required: true, authority: null };
  }
  if (entry.sessionInstanceId !== identity.sessionInstanceId
    || entry.runtimeEpoch !== identity.runtimeEpoch) return { required: true, authority: null };
  return { required: true, authority: entry.authority };
}

export function clearProcessSharedMachineAuthoritiesForTests(): void {
  entries.clear();
}
