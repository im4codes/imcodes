/** Server-local calendar schedule, not a drifting 24h interval. Date normalizes
 * nonexistent DST hours forward; a repeated hour is used only once. */
export function nextHistoryCleanupAt(after) {
  const date = new Date(after);
  let next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 3).getTime();
  if (next <= after) next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 3).getTime();
  return next;
}
