import { P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS } from '../../shared/p2p-workflow-constants.js';

/**
 * In-memory script-node concurrency counter.
 *
 * v1a forward-looking primitive: the real script runner lands in v1b. This
 * module exists so daemon admission for script nodes is bounded separately
 * from advanced-workflow admission and so the cap is testable from spec
 * scenarios today.
 *
 * Process-local only — restart resets the counter. Callers MUST pair every
 * successful `acquireScriptSlot()` with exactly one `releaseScriptSlot()`
 * (use try/finally).
 */

let activeScriptSlots = 0;

export interface AcquireScriptSlotResult {
  ok: boolean;
  inUse: number;
  capacity: number;
}

export function acquireScriptSlot(): AcquireScriptSlotResult {
  if (activeScriptSlots >= P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS) {
    return { ok: false, inUse: activeScriptSlots, capacity: P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS };
  }
  activeScriptSlots += 1;
  return { ok: true, inUse: activeScriptSlots, capacity: P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS };
}

export function releaseScriptSlot(): void {
  if (activeScriptSlots > 0) activeScriptSlots -= 1;
}

export function getScriptSlotsInUse(): number {
  return activeScriptSlots;
}

/** Test-only helper: reset the in-memory counter. */
export function __resetScriptConcurrencyForTests(): void {
  activeScriptSlots = 0;
}
