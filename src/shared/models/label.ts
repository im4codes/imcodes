function stripModelSuffixes(id: string): string {
  return id
    .replace(/\[1m\]/gi, '')
    .trim()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/[-_]\d{6,8}$/, '')
    .trim();
}

function lastTwoSegments(id: string): string {
  const parts = id.split(/[-\s]+/).filter(Boolean);
  return parts.length > 0 ? parts.slice(-2).join('-') : id;
}

export function shortModelLabel(model?: string | null): string | null {
  const m = model?.trim();
  if (!m) return null;
  const cleaned = stripModelSuffixes(m);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  const claudeFamily =
    lower.includes('opus') ? 'opus'
    : lower.includes('sonnet') ? 'sonnet'
    : lower.includes('haiku') ? 'haiku'
    : lower.includes('fable') ? 'fable'
    : lower.includes('mythos') ? 'mythos'
    : null;
  if (claudeFamily) {
    // Surface the version: new-style `claude-opus-4-8` (digits AFTER the
    // family) or old-style `claude-3-5-sonnet` (digits BEFORE the family).
    // Capture at most major[-minor] so trailing date suffixes like
    // `-20260514` are not swallowed. `-`/`_` separators render as `.`.
    const before = lower.match(new RegExp(`(\\d+(?:[-.]\\d+)?)[-_]${claudeFamily}`));
    const after = lower.match(new RegExp(`${claudeFamily}[-_]?(\\d+(?:[-.]\\d+)?)`));
    const ver = before?.[1] ?? after?.[1] ?? null;
    return ver ? `${claudeFamily}-${ver.replace(/[-_]/g, '.')}` : claudeFamily;
  }
  if (lower.includes('flash')) return 'flash';

  if (lower.includes('gpt-4o')) return 'gpt-4o';
  if (lower.includes('gpt-4.1')) return 'gpt-4.1';
  if (lower.includes('o4-mini') || lower.includes('o4mini')) return 'o4-mini';
  if (/\bo3(?:$|[-_.])/.test(lower)) return 'o3';

  // Any GPT/Codex id of any generation (gpt-5.4-mini, gpt-5.6-sol,
  // gpt-6-luna, ...): show its last two dash-separated parts so both the
  // version and the variant survive; a bare `gpt-5.6` stays `gpt-5.6`.
  const gpt = lower.match(/\bgpt-\d[\w.-]*/);
  if (gpt) return lastTwoSegments(gpt[0]);

  const gem = lower.match(/\b(gemini[- ]\d[\w.-]*)\b/);
  if (gem) return lastTwoSegments(gem[1]);

  if (lower === 'coder-model') return 'coder-model';
  const compatFamily = cleaned.match(/\b((?:qwen|glm|kimi|minimax)[\w.-]*)\b/i);
  if (compatFamily) return lastTwoSegments(compatFamily[1]);

  const unscoped = cleaned.split('/').pop()?.trim() || cleaned;
  return lastTwoSegments(unscoped);
}

/**
 * Pick the best display label across several candidate model strings,
 * preferring the one that carries a version number.
 *
 * Sessions often store the configured model as a bare alias (e.g. `opus[1M]`),
 * which collapses to `opus` with no version, while the authoritative usage
 * event reports the resolved id (e.g. `claude-opus-4-8`) → `opus-4.8`. Callers
 * pass candidates in priority order; a version-bearing label wins over a
 * version-less one, otherwise the first non-empty label is used. This keeps the
 * configured-model priority intact except when it would hide an available
 * version.
 */
export function bestModelLabel(...models: Array<string | null | undefined>): string | null {
  const labels = models.map((m) => shortModelLabel(m));
  const versioned = labels.find((l): l is string => l != null && /\d/.test(l));
  if (versioned) return versioned;
  return labels.find((l): l is string => l != null) ?? null;
}
