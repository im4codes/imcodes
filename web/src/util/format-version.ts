/**
 * Display-only formatting for the daemon version string.
 *
 * Background: dev releases ship with a CalVer + counter suffix that's
 * useful for support but visually noisy in narrow status bars. Real
 * value seen on a phone-width screen:
 *
 *     v2026.4.1949-dev.1928
 *
 * The trailing `.1928` is the per-publish counter from the dev pipeline.
 * Operators rarely need it at a glance — the date-coded `2026.4.1949`
 * already pinpoints the build, and the tooltip / settings panel still
 * shows the full string for support escalations.
 *
 * Truncation rule: collapse `-<tag>.<digits>` to just `-<tag>` (`-dev`,
 * `-rc`, `-beta`, etc.). Stable versions without a pre-release tag are
 * returned unchanged.
 */
export function formatDaemonVersionShort(version: string | null | undefined): string {
  if (!version) return '';
  // Strip the trailing `.<digits>` after a pre-release tag.
  // Examples:
  //   '2026.4.1949-dev.1928' → '2026.4.1949-dev'
  //   '2026.4.1949-rc.3'     → '2026.4.1949-rc'
  //   '2026.4.1873'          → '2026.4.1873'
  return version.replace(/(-[A-Za-z]+)\.\d+$/, '$1');
}
