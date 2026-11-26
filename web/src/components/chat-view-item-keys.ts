/**
 * "Did the rendered item keys change?" without building a signature string.
 *
 * The virtualized chat used `items.map(key).join('\u0001')` per items change:
 * O(n) allocation of a large string for every streaming update of every open
 * window, only to compare it with the previous one. This compares in place and
 * only allocates a fresh key array when something actually changed.
 */
export interface ItemKeySnapshot {
  generation: number;
  keys: readonly string[];
}

export function itemKeysUnchanged(
  previous: ItemKeySnapshot | null,
  generation: number,
  items: ReadonlyArray<{ key: string }>,
): boolean {
  if (!previous || previous.generation !== generation || previous.keys.length !== items.length) return false;
  for (let index = 0; index < items.length; index += 1) {
    if (previous.keys[index] !== items[index]!.key) return false;
  }
  return true;
}

export function snapshotItemKeys(generation: number, items: ReadonlyArray<{ key: string }>): ItemKeySnapshot {
  return { generation, keys: items.map((item) => item.key) };
}
