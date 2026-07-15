/**
 * Machine quick-reference insert + compose-time resolution helpers (web),
 * mirroring `alias-insert.ts` but for a `^^(refName)` machine target marker.
 *
 * Unlike an alias (a secret value replaced out of band), a machine marker is a
 * visible reference: it stays literal in the delivered text so the agent sees
 * which machine is referenced, and it resolves out of band to the target
 * `serverId` (a hint the server re-validates against the owner's machines).
 */
import {
  buildMachineMarker,
  buildResolvedMachines as buildResolvedMachinesPure,
  type MachineRef,
  type SendMachineResolution,
} from '@shared/machine-reference.js';

/**
 * Insert a `^^(refName)` marker at the caret of a focused contenteditable/textarea
 * composer via `execCommand('insertText', ...)`, mirroring the alias insert path.
 * Inserts the marker text only (never resolves) and does not send.
 *
 * @returns `true` if the insert command was issued, `false` when unavailable
 *   (e.g. SSR / no `document`).
 */
export function insertMachineMarkerAtCaret(refName: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  return document.execCommand('insertText', false, buildMachineMarker(refName));
}

/**
 * Compute the compose-time machine resolution for `text` against `machines`.
 * Pure passthrough to the shared resolver: known unique `^^(name)` markers map
 * to their `serverId`; unknown/ambiguous names are skipped and left literal.
 */
export function buildResolvedMachines(
  text: string,
  machines: readonly MachineRef[],
): { text: string; resolvedMachines: SendMachineResolution; ambiguous: string[]; unresolved: string[] } {
  return buildResolvedMachinesPure(text, machines);
}
