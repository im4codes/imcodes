/**
 * Authoritative delegation-claim projection.
 *
 * A Brain turn may only be surfaced as having assigned / queued / recovered
 * work when an authorized IM.codes dispatch actually happened. R1 proved only
 * that the catalog COULD delegate (`assertImcodesDelegationReady`); it never
 * proved that any tool was called or accepted, so a turn with a healthy
 * catalog and zero tool calls still reached the UI unqualified.
 *
 * The boundary here is deliberately NOT textual. Nothing in this module reads
 * assistant prose, matches keywords, or guesses intent: a claim is
 * substantiated only by structured dispatch facts extracted from the MCP tool
 * result itself. Prose stays prose; delegation STATUS is derived from facts or
 * it does not exist.
 */

/** The only MCP server that carries IM.codes delegation authority. */
export const DELEGATION_AUTHORITY_MCP_SERVER = 'imcodes-memory';

/**
 * The exact tools whose results can substantiate a delegation claim. Codex's
 * NATIVE collaboration tools share the short name `send_message` but carry no
 * IM.codes authority; they are distinguished here by MCP server, never by name
 * alone.
 */
export const DELEGATION_DISPATCH_TOOLS = ['send_message'] as const;

/** Metadata field carrying the projection on a completed assistant message. */
export const DELEGATION_CLAIM_METADATA_FIELD = 'delegationClaim';

/**
 * The only delivery outcomes that mean a target was actually reached.
 *
 * An allowlist rather than a "not failed" test: a non-empty status string is
 * not evidence. `accepted`/`pending`/`sent` describe the CALL, not the arrival,
 * and an unknown future status must not be read as success by default.
 */
export const DELEGATION_REACHED_DELIVERY_STATUSES = ['delivered', 'queued'] as const;

/** A delegation claim is substantiated by facts, or it is not a claim at all. */
export type DelegationClaimStatus = 'substantiated' | 'unsubstantiated';

/** One delivery leg of a dispatch, exactly as the registry reported it. */
export interface DelegationDeliveryFact {
  target: string;
  status: string;
  messageId?: string;
}

/** One authorized dispatch, bound to its exact authority ids. */
export interface DelegationDispatchFact {
  dispatchId: string;
  /** Required: without both ids the dispatch cannot be checked against the registry. */
  taskId: string;
  assignmentId: string;
  deliveries: DelegationDeliveryFact[];
}

/** The projection attached to a completed Brain turn. */
export interface DelegationClaimProjection {
  status: DelegationClaimStatus;
  dispatches: DelegationDispatchFact[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asMeaningfulString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** True only for the exact IM.codes server + dispatch tool pair. */
export const isDelegationDispatchTool = (server: unknown, tool: unknown): boolean =>
  asMeaningfulString(server) === DELEGATION_AUTHORITY_MCP_SERVER
  && DELEGATION_DISPATCH_TOOLS.includes(asMeaningfulString(tool) as never);

const readDeliveries = (output: Record<string, unknown>): DelegationDeliveryFact[] => {
  const raw = output.deliveries;
  if (!Array.isArray(raw)) return [];
  const deliveries: DelegationDeliveryFact[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const target = asMeaningfulString(record.target);
    const status = asMeaningfulString(record.status);
    // A delivery leg without both a target and a status states nothing; it is
    // dropped rather than counted as evidence of reaching anyone. A leg that
    // FAILED, or carries a status we cannot interpret, is dropped for the same
    // reason -- it is not evidence that anything arrived.
    if (!target || !status) continue;
    if (!(DELEGATION_REACHED_DELIVERY_STATUSES as readonly string[]).includes(status)) continue;
    const messageId = asMeaningfulString(record.messageId);
    deliveries.push({ target, status, ...(messageId ? { messageId } : {}) });
  }
  return deliveries;
};

/**
 * Extract a dispatch fact from one completed MCP tool call.
 *
 * Returns null unless the call carries real authority: the exact IM.codes
 * server and dispatch tool, an accepted status, a dispatchId, and at least one
 * delivery leg. An accepted call that delivered nowhere substantiates nothing.
 */
export const readDelegationDispatchFact = (
  server: unknown,
  tool: unknown,
  toolArguments: unknown,
  structuredOutput: unknown,
): DelegationDispatchFact | null => {
  if (!isDelegationDispatchTool(server, tool)) return null;
  const output = asRecord(structuredOutput);
  if (!output) return null;
  if (asMeaningfulString(output.status) !== 'accepted') return null;
  const dispatchId = asMeaningfulString(output.dispatchId);
  if (!dispatchId) return null;
  const deliveries = readDeliveries(output);
  if (deliveries.length === 0) return null;
  const task = asRecord(asRecord(toolArguments)?.task);
  const taskId = asMeaningfulString(task?.taskId);
  const assignmentId = asMeaningfulString(task?.assignmentId);
  // Both ids are required. An ordinary send with no task binding is a real
  // message, but it is not evidence that supervised work was assigned, so it
  // must not substantiate an assigned/queued/recovered claim.
  if (!taskId || !assignmentId) return null;
  return { dispatchId, taskId, assignmentId, deliveries };
};

/**
 * Project the turn's delegation authority from its dispatch facts alone.
 *
 * Zero facts yields `unsubstantiated` with an empty dispatch list, so a
 * consumer has nothing it could render as assigned/queued/recovered. That is
 * the whole point: the absence of authority is represented explicitly instead
 * of being left for prose to fill in.
 */
export const projectDelegationClaim = (
  dispatches: readonly DelegationDispatchFact[],
): DelegationClaimProjection => ({
  status: dispatches.length > 0 ? 'substantiated' : 'unsubstantiated',
  dispatches: [...dispatches],
});

/** Read a projection back off message metadata, if present and well-formed. */
export const readDelegationClaim = (
  metadata: Record<string, unknown> | undefined,
): DelegationClaimProjection | null => {
  const claim = asRecord(metadata?.[DELEGATION_CLAIM_METADATA_FIELD]);
  if (!claim) return null;
  const status = asMeaningfulString(claim.status);
  if (status !== 'substantiated' && status !== 'unsubstantiated') return null;
  const dispatches = Array.isArray(claim.dispatches) ? claim.dispatches : [];
  return { status, dispatches: dispatches as DelegationDispatchFact[] };
};
