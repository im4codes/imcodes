import type { TerminalDiff } from './types.js';

export type TerminalDiffHandler = (diff: TerminalDiff) => void;

/**
 * What a terminal view calls to receive a session's `terminal.diff` frames.
 * It may return a function that unregisters the handler; a view MUST call it
 * when it unmounts or re-registers.
 */
export type TerminalDiffRegistration = (apply: TerminalDiffHandler) => void | (() => void);

/**
 * Who receives a session's snapshots (full frames) and diffs.
 *
 * It used to be ONE slot per session name, overwritten by whichever view
 * registered last, and never cleared. A session shown in two places at once (a
 * sub-session card's preview and its open window; a pane and its dock) therefore
 * delivered every snapshot to a single view - and which one flipped each time a
 * parent re-rendered and a view re-registered. The other view, having dropped
 * bytes and asked for a snapshot, never received it: it stayed on its old picture
 * while its twin was current. When the later view closed, the survivor was not
 * re-registered at all and received nothing, ever.
 *
 * Every registered view gets every frame, and a view that leaves takes only its
 * own registration with it.
 */
export class TerminalDiffRegistry {
  private readonly bySession = new Map<string, Set<TerminalDiffHandler>>();

  register(sessionName: string, apply: TerminalDiffHandler): () => void {
    let handlers = this.bySession.get(sessionName);
    if (!handlers) { handlers = new Set(); this.bySession.set(sessionName, handlers); }
    handlers.add(apply);
    return () => {
      const current = this.bySession.get(sessionName);
      if (!current) return;
      current.delete(apply);
      if (current.size === 0) this.bySession.delete(sessionName);
    };
  }

  dispatch(sessionName: string, diff: TerminalDiff): void {
    const handlers = this.bySession.get(sessionName);
    if (!handlers) return;
    // A copy: a handler may (un)register while handling.
    for (const apply of [...handlers]) {
      // One view failing must not starve its twin of the frame.
      try { apply(diff); } catch { /* the view guards its own state */ }
    }
  }

  /** Registered handler count for a session (diagnostics / tests). */
  size(sessionName: string): number {
    return this.bySession.get(sessionName)?.size ?? 0;
  }
}
