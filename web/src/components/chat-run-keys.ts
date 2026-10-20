/**
 * Stable keys for MERGED view items (assistant blocks, tool groups/activity).
 *
 * A run of consecutive events is one view item. It used to be keyed by the id
 * of the first event of the run that happens to be in the derived list, so the
 * key changed whenever that first event left the list: the retained-event cap
 * dropping the oldest event, or the tail derivation window sliding on every
 * append. Preact saw a new key and re-created the whole row - including the
 * one that is streaming - once per message boundary in a long run.
 *
 * The key a run was rendered under is remembered per member event, so a run
 * that still contains any event it had before keeps its key. A run that is
 * split (a tool call lands inside it) keeps the key for the part holding the
 * original first event; the other part gets its own key, which is correct:
 * it is a new row.
 */
const MAX_REMEMBERED_MEMBERS = 8192;

export type RunKind = 'assistant-block' | 'tool-group' | 'tool-activity';

const keyByMember = new Map<string, string>();

function memberKey(kind: RunKind, eventId: string): string {
  return `${kind}\u0001${eventId}`;
}

/**
 * The key for a run made of `memberIds`, whose key would be `defaultKey` without
 * continuity. `used` holds the keys already claimed in this derivation so two
 * rows can never share a key.
 */
export function claimRunKey(
  kind: RunKind,
  defaultKey: string,
  memberIds: readonly string[],
  used: Set<string>,
): string {
  let key = defaultKey;
  for (const id of memberIds) {
    const prior = keyByMember.get(memberKey(kind, id));
    if (prior !== undefined) { key = prior; break; }
  }
  if (used.has(key)) {
    key = defaultKey;
    for (let n = 2; used.has(key); n += 1) key = `${defaultKey}~${n}`;
  }
  used.add(key);
  for (const id of memberIds) {
    const slot = memberKey(kind, id);
    keyByMember.delete(slot);
    keyByMember.set(slot, key);
  }
  while (keyByMember.size > MAX_REMEMBERED_MEMBERS) {
    const oldest = keyByMember.keys().next().value;
    if (oldest === undefined) break;
    keyByMember.delete(oldest);
  }
  return key;
}

export function __resetRunKeysForTests(): void {
  keyByMember.clear();
}
