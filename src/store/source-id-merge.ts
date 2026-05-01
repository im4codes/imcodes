export function mergeSourceIds(prior: readonly string[], incoming: readonly string[], cap = 200, sticky = 10): string[] {
  const safeCap = Math.max(0, cap);
  const safeSticky = Math.max(0, Math.min(sticky, safeCap));
  const uniquePrior: string[] = [];
  const seen = new Set<string>();
  for (const id of prior) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniquePrior.push(id);
  }
  const head = uniquePrior.slice(0, safeSticky);
  const tail = uniquePrior.slice(safeSticky);
  for (const id of incoming) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tail.push(id);
  }
  const tailCap = Math.max(0, safeCap - head.length);
  const trimmedTail = tail.length > tailCap ? tail.slice(tail.length - tailCap) : tail;
  return [...head, ...trimmedTail];
}
