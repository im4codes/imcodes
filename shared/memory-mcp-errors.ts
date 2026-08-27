export const MCP_ERROR_REASONS = {
  INVALID_NAMESPACE: 'invalid_namespace',
  FEATURE_DISABLED: 'feature_disabled',
  IDENTITY_REJECTED: 'identity_rejected',
  WRITE_QUOTA_EXCEEDED: 'write_quota_exceeded',
  SCOPE_FORBIDDEN: 'scope_forbidden',
  PROJECTION_UNAVAILABLE: 'projection_unavailable',
  VALIDATION_FAILED: 'validation_failed',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  // Machine remote-exec tool surface (list_machines / exec_remote). A typed
  // reason for each way a target can be unusable, so the agent tool never
  // returns an ad-hoc string (controlled-node-remote-exec 10.12).
  MACHINE_NOT_FOUND: 'machine_not_found',
  MACHINE_AMBIGUOUS: 'machine_ambiguous',
  EXEC_OFFLINE: 'exec_offline',
  EXEC_DISABLED: 'exec_disabled',
  // The machine control plane (list/exec API) was unreachable or returned an
  // unusable response. Distinct from "no machines" and from "machine not found":
  // a control-plane failure must never be mistaken for an empty/unknown target.
  CONTROL_PLANE_UNAVAILABLE: 'control_plane_unavailable',
  /**
   * The delegation target -- or another session sharing its provider account --
   * is being refused by its upstream provider.
   *
   * NOT the same fact as `RATE_LIMITED` above, and the two must never be
   * merged: `RATE_LIMITED` is IM.codes throttling the CALLER's own writes, so
   * the caller should slow down. `TARGET_LIMITED` says the caller is fine and
   * the RECIPIENT's upstream quota is out, so slowing down changes nothing and
   * the work has to go to a different provider family.
   */
  TARGET_LIMITED: 'target_limited',
  /**
   * The delegation target cannot take new work for a reason that is NOT quota:
   * it is missing, errored, or offline.
   *
   * Kept separate from `TARGET_LIMITED` because the two imply different retry
   * strategies and the caller must not confuse them. A limit ends at a known
   * reset time, so waiting is the correct response. An unavailable target has
   * no such clock -- retrying on a quota schedule would either hammer a dead
   * session or park real work behind a reset that was never going to fix it.
   * Reporting one as the other also corrupts the provider-limit record itself,
   * since an operator would read a crashed agent as an exhausted account.
   */
  TARGET_UNAVAILABLE: 'target_unavailable',
} as const;

export type MCPErrorReason = (typeof MCP_ERROR_REASONS)[keyof typeof MCP_ERROR_REASONS];

export const RECOVERABLE_MCP_ERROR_REASONS: ReadonlySet<MCPErrorReason> = new Set([
  MCP_ERROR_REASONS.FEATURE_DISABLED,
  MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE,
  MCP_ERROR_REASONS.RATE_LIMITED,
  MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
  // A provider quota comes back. Marking this terminal would make a caller
  // give up on a target that is merely waiting out a reset window.
  MCP_ERROR_REASONS.TARGET_LIMITED,
  // Sessions come back: restarted, recovered, reconnected. Terminal would make
  // a caller abandon a target that is merely down right now.
  MCP_ERROR_REASONS.TARGET_UNAVAILABLE,
]);

export function isRecoverableMcpErrorReason(reason: unknown): reason is MCPErrorReason {
  return RECOVERABLE_MCP_ERROR_REASONS.has(reason as MCPErrorReason);
}
