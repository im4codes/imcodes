import { AGY_FALLBACK_MODEL_IDS } from '../../../shared/agy-agent.js';

// `fable` = Claude Fable 5 (Mythos-class, GA 2026-06-09) — Anthropic's most
// capable widely released model, the new top tier above Opus. Listed first so
// the picker surfaces the strongest model at the top.
export const CLAUDE_CODE_MODEL_IDS = ['fable', 'opus[1M]', 'sonnet', 'haiku'] as const;
export type ClaudeCodeModelId = typeof CLAUDE_CODE_MODEL_IDS[number];

export function normalizeClaudeCodeModelId(value: string | null | undefined): ClaudeCodeModelId | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'opus') return 'opus[1M]';
  if (CLAUDE_CODE_MODEL_IDS.includes(trimmed as ClaudeCodeModelId)) return trimmed as ClaudeCodeModelId;
  // Map a version-bearing / full Claude id (e.g. "claude-opus-4-8[1m]") to its
  // canonical picker option by family, so the model picker still pre-selects
  // correctly even when the detected/stored model preserves its version for the
  // ctx-bar label.
  const lower = trimmed.toLowerCase();
  // Mythos-class maps to the `fable` picker option (claude-fable-5 /
  // claude-mythos-5 both resolve here).
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable';
  if (lower.includes('opus')) return 'opus[1M]';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return undefined;
}

export const DEFAULT_CODEX_AUTOMATION_MODEL = 'gpt-6-luna' as const;
export const DEFAULT_CODEX_SESSION_MODEL = 'gpt-6-sol' as const;
export const CODEX_MODEL_IDS = [DEFAULT_CODEX_SESSION_MODEL, 'gpt-6.2-sol', 'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', DEFAULT_CODEX_AUTOMATION_MODEL, 'gpt-5.2'] as const;
export type CodexModelId = typeof CODEX_MODEL_IDS[number];

/**
 * Pattern match for a Codex/OpenAI-shaped model id that the static
 * `CODEX_MODEL_IDS` list doesn't know about yet (a newly released model such
 * as `gpt-6-luna` or `gpt-6-astra`). Used to classify a live/user-named model
 * by naming convention rather than rejecting it for being absent from the
 * static fallback list.
 */
export function looksLikeCodexModelId(value: string): boolean {
  if (/^codex-sdk$/i.test(value.trim())) return false;
  return /^(gpt-\d|o\d(?:$|[-_.])|codex[-_])/i.test(value.trim());
}

export const MUSE_MODEL_IDS = [
  'muse-wonder-full-1.0',
  'muse-wonder-1.0',
  'muse-spark-1.3',
  'muse-spark-1.2',
] as const;
export type MuseModelId = typeof MUSE_MODEL_IDS[number];

// Share the fallback catalog so picker and provisioning suggestions stay aligned.
export const AGY_MODEL_IDS = AGY_FALLBACK_MODEL_IDS;
export type AgyModelId = typeof AGY_MODEL_IDS[number];

export function mergeModelSuggestions(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())];
}

const CODEX_SOL_MODEL_RE = /^gpt-(\d+(?:\.\d+)*)-sol$/i;

function parseCodexSolVersion(modelId: string): number[] | null {
  const match = CODEX_SOL_MODEL_RE.exec(modelId.trim());
  if (!match) return null;
  return match[1]!.split('.').map((part) => Number(part));
}

function compareCodexSolVersions(a: readonly number[], b: readonly number[]): number {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the highest-version `gpt-<N>[.<M>...]-sol` model id from a catalog,
 * independent of catalog ordering, provider default flags, or non-Sol variants.
 */
export function selectLatestCodexSolModel(
  models: ReadonlyArray<string | { readonly id: string }>,
): string | undefined {
  let bestId: string | undefined;
  let bestVersion: number[] | null = null;
  for (const entry of models) {
    const id = (typeof entry === 'string' ? entry : entry.id).trim();
    const version = parseCodexSolVersion(id);
    if (!version) continue;
    if (!bestVersion || compareCodexSolVersions(version, bestVersion) > 0) {
      bestVersion = version;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Derive the automatic default model for a new Codex SDK session from an
 * ordered/unordered catalog: prefer the highest numeric Sol release, then a
 * valid provider default present in the catalog, returning `undefined` (no
 * explicit model override) when a non-empty catalog has neither. Only an
 * empty/unknown catalog falls back to the static known Sol.
 */
export function resolveCodexAutoDefaultModel(
  models: readonly string[],
  providerDefaultModel?: string | null,
): string | undefined {
  const latestSol = selectLatestCodexSolModel(models);
  if (latestSol) return latestSol;
  const trimmedDefault = providerDefaultModel?.trim();
  if (trimmedDefault && (models.length === 0 || models.includes(trimmedDefault))) {
    return trimmedDefault;
  }
  if (models.length === 0) {
    return selectLatestCodexSolModel(CODEX_MODEL_IDS) ?? DEFAULT_CODEX_SESSION_MODEL;
  }
  return undefined;
}
