import { CODEX_MODEL_IDS, looksLikeCodexModelId } from '../shared/models/options.js';

function uniqueModelIds(groups: ReadonlyArray<ReadonlyArray<string | undefined>>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const id = raw?.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Resolve Codex ids without making newly released models depend on the
 * compiled fallback roster. Live provider data wins; persisted data is used
 * when probing is unavailable, and the current look-alike model is retained
 * so a partial catalog cannot reject a valid user selection.
 */
export function resolveCodexModelIds(input: {
  dynamicModels?: ReadonlyArray<string | undefined>;
  persistedModels?: ReadonlyArray<string | undefined>;
  requestedModels?: ReadonlyArray<string | undefined>;
}): string[] {
  const dynamic = uniqueModelIds([input.dynamicModels ?? []]);
  const persisted = uniqueModelIds([input.persistedModels ?? []]);
  const requestedLookalikes = uniqueModelIds([
    (input.requestedModels ?? []).filter((model): model is string => typeof model === 'string' && looksLikeCodexModelId(model)),
  ]);
  const base = dynamic.length ? dynamic : persisted.length ? persisted : [...CODEX_MODEL_IDS];
  return uniqueModelIds([base, requestedLookalikes]);
}
