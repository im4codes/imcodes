import type {
  P2pArtifactConvention,
  P2pEdgeConditionKind,
  P2pEdgeKind,
  P2pNodeDispatchStyle,
  P2pNodeKind,
  P2pPermissionScope,
  P2pPresetKey,
  P2pStartContextSourceKind,
  P2pWorkflowKind,
} from './p2p-workflow-constants.js';
import type { P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';
import type { P2pAdvancedRound, P2pContextReducerConfig } from './p2p-advanced.js';

export type P2pJsonPrimitive = string | number | boolean | null;
export type P2pJsonValue = P2pJsonPrimitive | P2pJsonValue[] | { [key: string]: P2pJsonValue };
export type P2pWorkflowVariableValue = string | number | boolean | string[];

export interface P2pLegacyLaunchConfig {
  modeOverride?: string;
  rounds?: number;
  hopTimeoutMinutes?: number;
}

export interface P2pOldAdvancedLaunchConfig {
  advancedPresetKey?: string;
  advancedRounds?: Array<Record<string, unknown>>;
  advancedRunTimeoutMinutes?: number;
  contextReducer?: Record<string, unknown> | null;
}

export interface P2pWorkflowLaunchContext {
  requestId?: string;
  runId?: string;
  sessionName?: string;
  projectRoot?: string;
  userText?: string;
  locale?: string;
}

export interface P2pWorkflowLaunchEnvelope {
  workflowSchemaVersion: 1;
  workflowKind: P2pWorkflowKind;
  legacy?: P2pLegacyLaunchConfig;
  advancedDraft?: P2pWorkflowDraft;
  oldAdvanced?: P2pOldAdvancedLaunchConfig;
  migrationPolicy?: { kind: 'materialize_old_advanced' };
  requiredDaemonCapabilities?: string[];
  /**
   * Audit:R3 PR-γ / N-M5 / V-4 — policy hash carried by a preview/saved
   * workflow at the time it was compiled. The daemon recompiles every launch
   * with its CURRENT `P2pStaticPolicy`; if the hash differs from the saved
   * value, the daemon emits a warning-severity
   * `static_policy_mismatch_recompiled` diagnostic so the caller knows the
   * preview's compilation is stale. ASCII string, ≤128 bytes.
   */
  expectedStaticPolicyHash?: string;
  launchContext?: P2pWorkflowLaunchContext;
  /**
   * R3 PR-α follow-up — Per-launch script executable allowlist. Configured
   * by the user in the web UI (`P2pConfigPanel` → "Allowed executables")
   * and round-tripped through `P2pSavedConfig.allowedExecutables` so the
   * same list applies to every advanced launch from that config.
   *
   * Daemon merges these entries into `P2pStaticPolicy.allowedExecutables`
   * during `prepareAdvancedWorkflowLaunch` (no daemon-side hand-edited
   * config file — IM.codes is UI-driven). Each entry MUST be a non-empty
   * visible-ASCII string ≤256 bytes; the array itself is capped at 64
   * entries. Empty list means script bind rejects every executable with
   * `script_executable_denied`.
   */
  allowedExecutables?: string[];
}

export interface P2pWorkflowDraft {
  schemaVersion: 1;
  id: string;
  title?: string;
  nodes: P2pWorkflowNodeDraft[];
  edges: P2pWorkflowEdgeDraft[];
  rootNodeId?: string;
  startContext?: P2pWorkflowStartContext;
  variables?: P2pWorkflowVariableDefinition[];
  loopBudgets?: Record<string, number>;
}

export interface P2pWorkflowNodeDraft {
  id: string;
  title?: string;
  nodeKind: P2pNodeKind;
  preset: P2pPresetKey;
  dispatchStyle?: P2pNodeDispatchStyle;
  permissionScope?: P2pPermissionScope;
  promptAppend?: string;
  /**
   * R3 v2 PR-μ — Optional per-node override for the round-end summary
   * prompt. When unset, the orchestrator uses
   * `P2P_PRESET_DEFAULT_SUMMARY_PROMPT[preset]`. The canvas inspector
   * exposes this as an editable textarea with the default-prompt as
   * placeholder so users see what the auto-summary will say.
   *
   * Setting `summaryPromptOverride: ''` (empty string after trim) is
   * treated as "use default"; setting any non-empty value forces the
   * orchestrator to dispatch a summary hop on the initiator at the end
   * of this round even when `dispatchStyle === 'single_main'` (which
   * previously skipped the summary phase).
   */
  summaryPromptOverride?: string;
  timeoutMs?: number;
  routingAuthority?: P2pRoutingAuthority;
  script?: P2pScriptNodeContract;
  /** R3 v1b follow-up — logic node contract; see `P2pLogicNodeContract`. */
  logic?: P2pLogicNodeContract;
  artifacts?: P2pArtifactContract[];
}

export interface P2pWorkflowEdgeDraft {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeKind: P2pEdgeKind;
  condition?: P2pWorkflowEdgeCondition;
}

export interface P2pWorkflowEdgeCondition {
  kind: P2pEdgeConditionKind;
  equals: string;
}

export type P2pRoutingAuthority =
  | { kind: 'none' }
  | { kind: 'audit_verdict_marker'; allowedMarkers: string[] }
  | { kind: 'logic_marker'; allowedMarkers: string[] }
  | { kind: 'script_routing_key'; allowedKeys: string[] };

export interface P2pWorkflowStartContext {
  sources: P2pWorkflowStartContextSource[];
  maxTotalBytes?: number;
}

export interface P2pWorkflowStartContextSource {
  kind: P2pStartContextSourceKind;
  id: string;
  path?: string;
  maxBytes?: number;
  missingBehavior?: 'fail' | 'skip';
  binaryBehavior?: 'fail' | 'skip';
  order?: number;
  discussionOffset?: {
    byteOffset: number;
    sha256Prefix: string;
    sizeAtOffset: number;
  };
}

export interface P2pWorkflowVariableDefinition {
  name: string;
  value: P2pWorkflowVariableValue;
}

export interface P2pStaticPolicy {
  policyVersion: 1;
  maxNodes: number;
  maxEdges: number;
  maxLoopBudget: number;
  allowedExecutables: string[];
  allowInterpreterScripts: boolean;
  allowOpenSpecArtifacts: boolean;
  allowImplementationPermission: boolean;
  maxPromptAppendBytes: number;
  /**
   * Daemon-side concurrency caps. The daemon admission path MUST read these
   * values rather than hardcoded constants, so the cap is governed by the
   * single P2pStaticPolicy source rather than scattered literals.
   */
  concurrency: {
    maxAdvancedRuns: number;
    maxScripts: number;
  };
  policyHash?: string;
}

export interface P2pCompiledWorkflow {
  schemaVersion: 1;
  workflowId: string;
  rootNodeId: string;
  nodes: P2pCompiledNode[];
  edges: P2pCompiledEdge[];
  variables: P2pWorkflowVariableDefinition[];
  loopBudgets: Record<string, number>;
  derivedRequiredCapabilities: string[];
  staticPolicyHash: string;
  workflowContractHash: string;
  diagnostics: P2pWorkflowDiagnostic[];
}

export interface P2pCompiledNode {
  id: string;
  title?: string;
  nodeKind: P2pNodeKind;
  preset: P2pPresetKey;
  dispatchStyle?: P2pNodeDispatchStyle;
  permissionScope: P2pPermissionScope;
  promptAppend?: string;
  /**
   * R3 v2 PR-μ — User-authored override of the round-end summary
   * prompt. Carried verbatim from `P2pWorkflowNodeDraft.summaryPromptOverride`.
   * The orchestrator's adapter (`mapCompiledNodeToLegacyRound`) resolves
   * this against `P2P_PRESET_DEFAULT_SUMMARY_PROMPT[preset]` to compute
   * the effective summary prompt for the round.
   */
  summaryPromptOverride?: string;
  routingAuthority: P2pRoutingAuthority;
  script?: P2pScriptNodeContract;
  /**
   * R3 v1b follow-up — Logic node contract. When `nodeKind === 'logic'`,
   * the executor evaluates `logic.rules` against `run.variables` (initialized
   * from `compiled.variables` and patched by script nodes' machine output
   * frames) and emits the matching `emit` marker. Conditional outgoing
   * edges with `condition.kind === 'logic_marker_equals'` are then matched
   * against the emitted marker.
   *
   * The evaluator is intentionally minimal — declarative rules over
   * variable equality / presence — to keep the logic node sandboxed
   * without a full expression interpreter.
   */
  logic?: P2pLogicNodeContract;
  artifacts: P2pArtifactContract[];
}

/**
 * Declarative logic-node contract. Each rule is checked in declaration
 * order; the first rule whose `if` clause matches drives the emitted
 * marker. If no rule matches, `default` is emitted. `if: undefined` is an
 * always-match rule (useful as the trailing rule before `default`, or as
 * a single rule that emits unconditionally).
 *
 * Allowed `if` shapes (kept tiny on purpose):
 *   - `{ kind: 'variable_equals', name, equals }` — variable's stringified
 *     value === `equals`
 *   - `{ kind: 'variable_present', name }` — variable is defined and
 *     non-null
 *   - `{ kind: 'variable_truthy', name }` — variable is truthy in the
 *     usual JS sense (non-empty string, non-zero number, true, non-empty array)
 *
 * `emit` and `default` MUST be visible-ASCII strings ≤128 bytes. The
 * compiler caps `rules.length` at 32 per node.
 */
export interface P2pLogicNodeContract {
  rules: P2pLogicRule[];
  default: string;
}

export type P2pLogicRule =
  | { if?: undefined; emit: string }
  | { if: { kind: 'variable_equals'; name: string; equals: string }; emit: string }
  | { if: { kind: 'variable_present'; name: string }; emit: string }
  | { if: { kind: 'variable_truthy'; name: string }; emit: string };

export interface P2pCompiledEdge extends P2pWorkflowEdgeDraft {}

export interface P2pBindRuntimeContext {
  runId: string;
  requestId?: string;
  repoRoot: string;
  participants: Array<{ sessionName: string; roleLabel?: string; agentType?: string }>;
  launchScope: { serverId?: string; projectId?: string; sessionName?: string };
  /**
   * Capability advertisement snapshot at bind time. The `capabilities` array
   * is the daemon's most recent `daemon.hello` payload. Used by both
   * `getMissingP2pWorkflowCapabilities` (bind-time check) and
   * `recheckDangerousNodeCapabilities` (executor-time recheck).
   */
  capabilitySnapshot: {
    daemonId: string;
    capabilities: string[];
    helloEpoch: number;
    sentAt: number;
  };
  /**
   * Audit:R2-Cx1-4 / R3 PR-α — policy snapshot at bind time, full
   * `P2pStaticPolicy` shape (NOT an ad-hoc subset). This lets
   * `recheckDangerousNodeCapabilities`, `validateCompiledWorkflowAgainstBindPolicy`,
   * and any future executor compare bound policy vs current daemon policy
   * field-for-field (allowedExecutables, allow flags, concurrency caps).
   *
   * The previous `currentDaemonPolicy: { allowScript, allowImplementation, ...}`
   * subset was structurally incompatible with the recheck helper signature
   * — see audit findings A1 / N-M1.
   */
  policySnapshot: P2pStaticPolicy;
  concurrencyAdmission: { accepted: boolean; reason?: 'daemon_busy' };
  artifactRuntime?: { rootDir: string };
}

export interface P2pBoundWorkflow {
  compiled: P2pCompiledWorkflow;
  bindContext: P2pBindRuntimeContext;
  diagnostics: P2pWorkflowDiagnostic[];
}

export type P2pBindFailureReason =
  | 'daemon_busy'
  | 'missing_required_capability'
  | 'capability_stale';

export type P2pBindResult =
  | { ok: true; bound: P2pBoundWorkflow; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; reason: P2pBindFailureReason; diagnostics: P2pWorkflowDiagnostic[] };

/**
 * Discriminated union describing how `startP2pRun` was asked to execute the
 * advanced phase of a P2P run. v1a accepts two kinds:
 *
 * - `envelope_compiled`: the advanced rounds came from a fully validated
 *   `P2pWorkflowLaunchEnvelope` that was compiled and bound by
 *   `prepareAdvancedWorkflowLaunch`. The orchestrator MUST surface
 *   `bound.bindContext.capabilitySnapshot` and
 *   `bound.bindContext.policySnapshot` on the run state so dangerous
 *   nodes can `recheckDangerousNodeCapabilities` against the snapshot vs the
 *   live policy. This is the production user-facing path.
 *
 * - `supervision_internal`: the rounds were synthesised by
 *   `supervision-automation.ts` for an automatic audit. They never come from
 *   user input and therefore do not pass through envelope validation. The
 *   discriminant tag exists to make the bypass explicit in source review and
 *   in static reverse-regression checks (rather than being detected by a
 *   filename heuristic).
 *
 * - `openspec_auto_deliver_internal`: the rounds were synthesised by
 *   OpenSpec Auto Deliver stage materialization. They are daemon-owned,
 *   carry their own launch-origin metadata, and must not be resolved through
 *   user-facing combo or advanced preset lookup.
 *
 * Older callers (cron, tests) may still pass `advancedRounds` / `advancedPresetKey`
 * directly without `advanced`. v1a treats those as the legacy passthrough; v1b
 * deletes the deprecated fields and makes `advanced` the only entry point.
 */
export type StartP2pRunAdvancedSource =
  | { kind: 'envelope_compiled'; bound: P2pBoundWorkflow; advancedRounds: P2pAdvancedRound[]; advancedRunTimeoutMs?: number; contextReducer?: P2pContextReducerConfig }
  | { kind: 'supervision_internal'; advancedRounds: P2pAdvancedRound[]; advancedPresetKey?: string; advancedRunTimeoutMs?: number }
  | { kind: 'openspec_auto_deliver_internal'; advancedRounds: P2pAdvancedRound[]; advancedPresetKey?: string; advancedRunTimeoutMs?: number };

export interface P2pWorkflowRuntimePrivateState {
  runId: string;
  boundWorkflow: P2pBoundWorkflow;
  variables: Record<string, P2pWorkflowVariableValue>;
  rawNodeOutputs: Record<string, string>;
}

export interface P2pWorkflowStatusProjection {
  projectionVersion: 1;
  runId: string;
  workflowId: string;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'stale';
  currentNodeId?: string;
  completedNodeIds: string[];
  diagnostics: P2pWorkflowDiagnostic[];
  capabilitySnapshot?: P2pBindRuntimeContext['capabilitySnapshot'];
  updatedAt: string;
  artifactSummaries?: Array<{ nodeId: string; path: string; status: 'pending' | 'changed' | 'unchanged' | 'failed' }>;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary?: string }>;
}

export interface P2pPersistedWorkflowSnapshot {
  projectionVersion: 1;
  runId: string;
  workflowId: string;
  status: P2pWorkflowStatusProjection['status'];
  currentNodeId?: string;
  completedNodeIds: string[];
  diagnostics: P2pWorkflowDiagnostic[];
  updatedAt: string;
}

export interface P2pScriptNodeContract {
  commandKind: 'argv' | 'interpreter';
  argv: string[];
  interpreter?: string;
  stdin?: string;
  envAllowlist?: string[];
  requiredMachineOutput?: boolean;
  timeoutMs?: number;
  caps?: {
    stdinBytes?: number;
    stdoutBytes?: number;
    stderrBytes?: number;
    machineOutputBytes?: number;
  };
}

export interface P2pScriptMachineOutputFrame {
  kind: 'p2p_script_machine_output_v1';
  status?: 'ok' | 'fail';
  routingKey?: string;
  variables?: Record<string, P2pWorkflowVariableValue>;
  artifacts?: Array<{ path: string; sha256?: string }>;
  displaySummary?: string;
}

export interface P2pArtifactContract {
  convention: P2pArtifactConvention;
  paths: string[];
  permissionScope?: P2pPermissionScope;
  symlinkPolicy?: 'reject_all' | 'allow_existing_under_root';
}
