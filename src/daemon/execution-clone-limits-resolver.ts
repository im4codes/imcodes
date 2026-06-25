/**
 * Run-authoritative execution-clone limit resolver (N2 fix).
 *
 * WHY THIS LIVES IN ITS OWN MODULE — circular-import avoidance.
 * The clone create path's import graph is
 *   `p2p-orchestrator → execution-clone-orchestration → execution-clone`.
 * Making `execution-clone.ts` import an orchestrator to look up run limits would
 * close that cycle. So the lookup lives HERE (a module that imports the
 * orchestrators) and is INJECTED into the send-tool deps as
 * `resolveExecutionCloneLimits`. `execution-clone.ts` MUST NOT import this file.
 *
 * UNIFIED PRINCIPLE (one run registry, two epistemologies):
 *  - registry-PRESENCE selects the run-authoritative limits: a live run's
 *    `dedicatedExecutionRouting.limits` is the per-`parentRunId` config and is
 *    honored as-is through `parseDedicatedExecutionRoutingPreference` (clamped to
 *    the parser bounds `[MIN,MAX]`), whether it is TIGHTER OR LOOSER than the
 *    v1 default. This matches the budget the programmatic Team path already uses
 *    directly, so the two paths agree on a shared `parentRunId`, and it remains
 *    NaN-safe (a partial/missing field falls back to the field default, never to
 *    `undefined`). It is NOT `min`'d against the default — the default is not a
 *    ceiling.
 *  - registry-ABSENCE is NOT a legitimate "parent terminal" signal (that is the
 *    sweep's concern, deliberately NOT handled here). Absence here means only
 *    "no run-authoritative limit known" → return the canonical defaults. It must
 *    never be interpreted as "run ended".
 */
import {
  defaultDedicatedExecutionRoutingPreference,
  parseDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';
import { getP2pRun } from './p2p-orchestrator.js';
import { getOpenSpecAutoDeliverRun } from './openspec-auto-deliver-orchestrator.js';

/**
 * Resolve the bounded clone routing limits to enforce for a clone-create on the
 * given parent run.
 *
 * - The run-authoritative limits are threaded onto a live P2P run, or — when no
 *   P2P run matches — onto a live OpenSpec auto-deliver run. The P2P run is
 *   consulted FIRST; the auto-deliver run is the fallback source.
 * - registry-PRESENT → `parseDedicatedExecutionRoutingPreference(run.limits)`:
 *   the run's config is run-authoritative within the parser bounds (tighter OR
 *   looser than the default). The parser also makes this NaN-safe (a partial or
 *   non-numeric field falls back to the field default; a finite out-of-bounds
 *   value clamps to `[MIN,MAX]`).
 * - registry-ABSENT → the canonical defaults. Registry-absence is NOT a terminal
 *   signal here — it just means "no run-authoritative limit known".
 *
 * NOTE (v1): the auto-deliver run shape does not currently carry a `limits`
 * field, so in practice its branch resolves to `undefined` and is a no-op in
 * v1. It is wired symmetrically so that adding `limits` to the auto-deliver run
 * later requires no change here. See `extractRunLimits`.
 */
export function resolveExecutionCloneLimitsForParentRun(
  parentRunId: string,
): DedicatedExecutionRoutingGlobalPreference {
  const raw =
    extractRunLimits(getP2pRun(parentRunId)) ??
    extractRunLimits(getOpenSpecAutoDeliverRun(parentRunId));

  // registry-present → parse(run.limits) (run-authoritative within parser
  // bounds, tighter OR looser than default; NaN-safe); absence → defaults.
  return raw
    ? parseDedicatedExecutionRoutingPreference(raw)
    : defaultDedicatedExecutionRoutingPreference();
}

/**
 * Select a run's `dedicatedExecutionRouting.limits` source if present. Tolerant
 * of run shapes whose `dedicatedExecutionRouting` does not declare a `limits`
 * field at all — the OpenSpec auto-deliver run in v1 has `{ enabled,
 * templateSessionName, recentSummary }` with NO `limits`, so this branch
 * resolves to `undefined` and is a no-op in v1. The P2P run DOES declare
 * `limits`. The routing is accepted as a structurally-open record so both run
 * types fit without a cast at the call site. This SELECTS the raw source only
 * (validated to be a non-null object) and does NOT cast it to the preference
 * type — `parseDedicatedExecutionRoutingPreference` at the call site sanitizes
 * every field, so a partial/malformed `limits` can never reach the cap as a
 * `NaN`.
 */
function extractRunLimits(
  run: { dedicatedExecutionRouting?: Record<string, unknown> } | undefined,
): Record<string, unknown> | undefined {
  const limits = run?.dedicatedExecutionRouting?.['limits'];
  if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
    return limits as Record<string, unknown>;
  }
  return undefined;
}
