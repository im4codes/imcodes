/**
 * Dedicated-execution prompt-routing appendix builder.
 *
 * When dedicated execution routing is enabled AND a valid execution template
 * target is configured, implementation/delegation prompts get a SHORT English
 * appendix telling the model to delegate execution to an ephemeral clone of the
 * configured execution session via `send_message` (rather than implementing in
 * the orchestrator session itself).
 *
 * This builder is intentionally GENERIC / routing-only. It owns NO task
 * semantics: it never injects OpenSpec change/requirement/task/artifact wording.
 * The execution entry point that calls {@link appendExecutionRoutingAppendix}
 * owns the task-specific body of the prompt; this module only appends the
 * delegation-routing contract. Keeping it generic is what lets the same appendix
 * ride on OpenSpec, generic delegated execution, Team final execution, and Auto
 * Deliver implementation prompts without turning a generic prompt into an
 * OpenSpec one.
 *
 * The appendix is delimited by a stable sentinel marker so the
 * "append exactly once" contract is enforceable: if the marker is already
 * present in the base prompt, the appendix is NOT re-appended.
 */

import {
  EXECUTION_CLONE_KIND,
  type ExecutionCloneParentStage,
} from '../../shared/execution-clone.js';

/**
 * Stable sentinel marking the start of an injected routing appendix. Used both
 * as the heading the model reads and as the idempotency probe — a prompt that
 * already contains this marker is never appended to a second time.
 */
export const EXECUTION_ROUTING_APPENDIX_MARKER =
  '[[execution-routing:delegate-via-clone]]' as const;

export interface ExecutionRoutingAppendixOptions {
  /** Whether dedicated execution routing is enabled (global preference flag). */
  enabled: boolean;
  /** The execution-entry-point stage that owns this prompt's task semantics. */
  parentStage: ExecutionCloneParentStage;
  /**
   * The configured execution-template send target (the session a clone is copied
   * from). When absent/blank, routing has no destination and the appendix is
   * empty.
   */
  templateTarget?: string | null;
}

/** A target is usable only when it is a non-empty, non-whitespace string. */
function hasValidTarget(templateTarget?: string | null): templateTarget is string {
  return typeof templateTarget === 'string' && templateTarget.trim().length > 0;
}

/**
 * Build the routing appendix block.
 *
 * Returns `''` when routing is disabled OR no valid `templateTarget` is
 * configured. Otherwise returns a concise English block (prefixed with the
 * stable marker) that:
 *  - tells the model NOT to implement in the orchestrator session and to
 *    delegate execution to an ephemeral clone of the configured session;
 *  - shows the EXACT `send_message` call shape with the real target + stage;
 *  - instructs the model to use the returned `clone.target` for the follow-up
 *    send, for stop/wait/status, and for `destroy_execution_clone`.
 *
 * The block contains NO task/change/requirement wording — it is purely the
 * delegation-routing contract.
 */
export function buildExecutionRoutingAppendix(
  opts: ExecutionRoutingAppendixOptions,
): string {
  if (!opts.enabled) return '';
  if (!hasValidTarget(opts.templateTarget)) return '';

  const target = opts.templateTarget.trim();
  const stage = opts.parentStage;

  // The call shape mirrors the MCP send `clone` schema: kind + ephemeral +
  // parentRunId (supplied by the run context at call time) + parentStage. The
  // returned `clone.target` is the live worker session to drive afterwards.
  const callShape =
    `send_message({ target: "${target}", message: workerPrompt, reply: true, ` +
    `clone: { kind: "${EXECUTION_CLONE_KIND}", ephemeral: true, parentRunId, ` +
    `parentStage: "${stage}" } })`;

  return [
    EXECUTION_ROUTING_APPENDIX_MARKER,
    'Execution routing: do NOT carry out the work in this session. Delegate execution to an ephemeral clone of the configured execution session via send_message. The clone runs the work; this session orchestrates only.',
    'Issue the hand-off exactly like this (substitute your own worker prompt; parentRunId is provided by the run context):',
    callShape,
    'The reply carries a clone.target identifying the live worker session. Use that returned clone.target for every follow-up: additional send_message hand-offs, stop/wait/status, and the final destroy_execution_clone. Always destroy the clone when the work is done, failed, stopped, or timed out.',
  ].join('\n');
}

/**
 * Append the routing appendix to `basePrompt` exactly once.
 *
 * - Returns `basePrompt` unchanged when the appendix is empty (disabled / no
 *   valid target).
 * - Idempotent: if {@link EXECUTION_ROUTING_APPENDIX_MARKER} already appears in
 *   `basePrompt`, the prompt is returned unchanged (never double-appended).
 * - Otherwise separates the appendix from the base with a blank line.
 */
export function appendExecutionRoutingAppendix(
  basePrompt: string,
  opts: ExecutionRoutingAppendixOptions,
): string {
  const appendix = buildExecutionRoutingAppendix(opts);
  if (appendix.length === 0) return basePrompt;
  if (basePrompt.includes(EXECUTION_ROUTING_APPENDIX_MARKER)) return basePrompt;
  return `${basePrompt}\n\n${appendix}`;
}
