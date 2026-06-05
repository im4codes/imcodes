export function memoryTextMatchesQuery(haystackText: string, query: string | undefined): boolean {
  if (!query?.trim()) return false;
  const needle = query.trim().toLowerCase();
  const haystack = haystackText.toLowerCase();
  if (haystack.includes(needle)) return true;
  const terms = needle
    .split(/[\s\p{P}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length < 2) return false;
  return terms.every((term) => haystack.includes(term));
}
