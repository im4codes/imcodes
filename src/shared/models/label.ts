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

interface AnalyzedModelLabel {
  label: string;
  hasVersion: boolean;
}

function analyzeModelLabel(model?: string | null): AnalyzedModelLabel | null {
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
    return {
      label: ver ? `${claudeFamily}-${ver.replace(/[-_]/g, '.')}` : claudeFamily,
      hasVersion: ver != null,
    };
  }

  const unscoped = cleaned.split('/').pop()?.trim() || cleaned;
  if (lower.includes('flash')) {
    return { label: 'flash', hasVersion: /\d/.test(unscoped) };
  }

  if (lower.includes('gpt-4o')) return { label: 'gpt-4o', hasVersion: true };
  if (lower.includes('gpt-4.1')) return { label: 'gpt-4.1', hasVersion: true };
  if (lower.includes('o4-mini') || lower.includes('o4mini')) return { label: 'o4-mini', hasVersion: true };
  if (/\bo3(?:$|[-_.])/.test(lower)) return { label: 'o3', hasVersion: true };

  // Any GPT/Codex id of any generation (gpt-5.4-mini, gpt-5.6-sol,
  // gpt-6-luna, ...): show its last two dash-separated parts so both the
  // version and the variant survive; a bare `gpt-5.6` stays `gpt-5.6`.
  const gpt = lower.match(/\bgpt-\d[\w.-]*/);
  if (gpt) return { label: lastTwoSegments(gpt[0]), hasVersion: true };

  const gem = lower.match(/\b(gemini[- ]\d[\w.-]*)\b/);
  if (gem) return { label: lastTwoSegments(gem[1]), hasVersion: true };

  if (lower === 'coder-model') return { label: 'coder-model', hasVersion: false };
  const compatFamily = cleaned.match(/\b((?:qwen|glm|kimi|minimax)[\w.-]*)\b/i);
  if (compatFamily) {
    return {
      label: lastTwoSegments(compatFamily[1]),
      hasVersion: /\d/.test(compatFamily[1]),
    };
  }

  return {
    label: lastTwoSegments(unscoped),
    hasVersion: /\d/.test(unscoped),
  };
}

export function shortModelLabel(model?: string | null): string | null {
  return analyzeModelLabel(model)?.label ?? null;
}

/**
 * Pick the best display label across several candidate model strings,
 * preferring the one that carries a version number before truncation.
 *
 * Sessions often store the configured model as a bare alias (e.g. `opus[1M]`,
 * `auto`), which has no version, while the authoritative usage event reports the
 * resolved id (e.g. `claude-opus-4-8`, `gemini-4-hydrogen-high`). Version
 * detection uses the normalized pre-cap identity so truncating multi-segment
 * IDs to their last two segments never demotes a versioned candidate beneath an
 * older usage event.
 */
export function bestModelLabel(...models: Array<string | null | undefined>): string | null {
  const analyzed = models.map((m) => analyzeModelLabel(m));
  const versioned = analyzed.find((item): item is AnalyzedModelLabel => item != null && item.hasVersion);
  if (versioned) return versioned.label;
  return analyzed.find((item): item is AnalyzedModelLabel => item != null)?.label ?? null;
}
