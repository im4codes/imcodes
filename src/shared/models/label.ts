export function shortModelLabel(model?: string | null): string | null {
  const m = model?.trim();
  if (!m) return null;
  const lower = m.toLowerCase();

  const claudeFamily =
    lower.includes('opus') ? 'opus'
    : lower.includes('sonnet') ? 'sonnet'
    : lower.includes('haiku') ? 'haiku'
    : null;
  if (claudeFamily) {
    // Surface the version: new-style `claude-opus-4-8` (digits AFTER the
    // family) or old-style `claude-3-5-sonnet` (digits BEFORE the family).
    // Capture at most major[-minor] so trailing date suffixes like
    // `-20260514` are not swallowed. `-`/`_` separators render as `.`.
    const before = lower.match(new RegExp(`(\\d+(?:[-.]\\d+)?)[-_]${claudeFamily}`));
    const after = lower.match(new RegExp(`${claudeFamily}[-_]?(\\d+(?:[-.]\\d+)?)`));
    const ver = before?.[1] ?? after?.[1] ?? null;
    return ver ? `${claudeFamily} ${ver.replace(/[-_]/g, '.')}` : claudeFamily;
  }
  if (lower.includes('flash')) return 'flash';

  if (/^gpt-5\.4(?:$|[-_.])/.test(lower)) {
    if (lower.includes('mini')) return 'gpt-5.4-mini';
    if (lower.includes('nano')) return 'gpt-5.4-nano';
    if (lower.includes('pro')) return 'gpt-5.4-pro';
    if (lower.includes('codex')) return 'gpt-5.4-codex';
    return 'gpt-5.4';
  }

  const gpt5x = lower.match(/\b(gpt-5(?:\.\d+)?(?:-(?:codex|max|mini|nano|pro))?)\b/);
  if (gpt5x) return gpt5x[1];

  if (lower.includes('gpt-4o')) return 'gpt-4o';
  if (lower.includes('gpt-4.1')) return 'gpt-4.1';
  if (lower.includes('o4-mini') || lower.includes('o4mini')) return 'o4-mini';
  if (/\bo3(?:$|[-_.])/.test(lower)) return 'o3';

  const gem = lower.match(/\b(gemini[- ]\d[\w.-]*)\b/);
  if (gem) return gem[1];

  if (lower === 'coder-model') return 'coder-model';
  const qwen = m.match(/\b(qwen[\w.-]*)\b/i);
  if (qwen) return qwen[1];
  const glm = m.match(/\b(glm[\w.-]*)\b/i);
  if (glm) return glm[1];
  const kimi = m.match(/\b(kimi[\w.-]*)\b/i);
  if (kimi) return kimi[1];
  const minimax = m.match(/\b(minimax[\w.-]*)\b/i);
  if (minimax) return minimax[1];

  const parts = m.split('-');
  return parts[parts.length - 1] ?? m;
}
