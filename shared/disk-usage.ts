/**
 * A mounted filesystem's capacity, reported by the daemon inside `daemon.stats`
 * for the desktop status bar. Shared between the daemon (producer) and web
 * (consumer). Mobile clients ignore it; the desktop UI renders up to two inline
 * and spills the rest into a tooltip.
 */
export interface DiskUsage {
  /** Mount point on POSIX (e.g. "/", "/data") or drive root on Windows ("C:\\"). */
  mount: string;
  /** Total filesystem size in bytes. */
  totalBytes: number;
  /** Used bytes (total − free, includes reserved blocks). */
  usedBytes: number;
  /** used/total as a whole-number percentage 0–100. */
  usedPercent: number;
}
