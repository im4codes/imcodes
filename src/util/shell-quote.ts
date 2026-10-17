/** Quote `value` as one POSIX shell word (single quotes; an embedded `'` becomes `'\''`). */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
