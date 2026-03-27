export function shortModelLabel(model?: string | null): string | null {
  const m = model?.trim();
  if (!m) return null;
  const lower = m.toLowerCase();

  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
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

  const parts = m.split('-');
  return parts[parts.length - 1] ?? m;
}
