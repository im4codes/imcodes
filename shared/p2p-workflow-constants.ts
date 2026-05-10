export const P2P_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const P2P_WORKFLOW_KNOWN_SCHEMA_MAX = 1 as const;
export const P2P_WORKFLOW_PROJECTION_VERSION = 1 as const;

export const P2P_CAPABILITY_FRESHNESS_TTL_MS = 30_000 as const;
export const P2P_WORKFLOW_MAX_ACTIVE_RUNS = 2 as const;
export const P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS = 4 as const;

/**
 * R3 v1b follow-up — Default maximum attempts for transient script
 * failures. Counted via `run.roundAttemptCounts[round.id]`. The first
 * attempt is `1`; retries are attempts `2…N`.
 */
export const P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS = 3 as const;

/**
 * R3 v2 PR-ζ (B1 / A5) — Workflow variable identifier pattern.
 * Re-exported so the orchestrator's runtime write-path validation
 * matches the parser / draft validator and stays one place to change.
 * Lowercase + digits + underscore only ⇒ structurally rejects
 * `__proto__` / `constructor` / `prototype` keys.
 */
export const P2P_WORKFLOW_VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * R3 v2 PR-ζ (B5) — Per-element byte cap for script-emitted variable
 * arrays. Per-array element count cap is `P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS`.
 * The total `JSON.stringify` byte budget per variable is bounded by
 * `P2P_WORKFLOW_MAX_VARIABLE_BYTES` already; the new caps prevent a
 * runaway `[ "A".repeat(N), … ]` from driving daemon RSS through the
 * variable surface even when the encoded byte sum stays under cap.
 */
export const P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS = 64;
export const P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES = 8 * 1024;

/**
 * R3 v2 PR-ζ (Cx1-A6 / ζ-14) — Allowed executable path pattern + cap.
 * Reuses visible-ASCII charset of `P2P_REQUEST_ID_ASCII_PATTERN` but
 * removes the 128-char length limit so absolute paths up to 256 bytes
 * (matching the documented spec) are accepted. The byte length cap is
 * applied via `TextEncoder` separately.
 */
export const P2P_ALLOWED_EXECUTABLE_PATTERN = /^[\x21-\x7e]+$/;
export const P2P_ALLOWED_EXECUTABLE_MAX_BYTES = 256;

/**
 * R3 v1b follow-up — Diagnostic codes that the script runner classifies as
 * TRANSIENT (worth retrying) vs deterministic. Order matters for the
 * registry-style check in `isRetriableScriptDiagnostic`.
 */
export const P2P_SCRIPT_RETRIABLE_DIAGNOSTIC_CODES = [
  'script_timeout',
  'daemon_busy',
] as const;

export const P2P_WORKFLOW_MAX_NODES = 64 as const;
export const P2P_WORKFLOW_MAX_EDGES = 128 as const;
export const P2P_WORKFLOW_MAX_VARIABLES = 64 as const;
export const P2P_WORKFLOW_MAX_VARIABLE_BYTES = 8 * 1024;
export const P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES = 16 * 1024;
export const P2P_WORKFLOW_MAX_DIAGNOSTICS = 100 as const;
export const P2P_WORKFLOW_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/**
 * R3 v2 PR-ι — Maximum number of workflow drafts a single
 * `P2pSavedConfig` may store. Each entry can be ~64 nodes / 128 edges
 * deep, so 20 keeps the saved-config payload bounded (~few hundred KB
 * worst case) while still giving users plenty of room to organise
 * variations.
 */
export const P2P_WORKFLOW_LIBRARY_MAX_ENTRIES = 20 as const;

/**
 * R3 v2 PR-ι — Maximum byte length of a workflow title (UTF-8 encoded).
 * Mirrors the cap used by `P2P_WORKFLOW_VARIABLE_*` keys so library titles
 * cannot overflow rendered list items.
 */
export const P2P_WORKFLOW_TITLE_MAX_BYTES = 128 as const;

export const P2P_WORKFLOW_ARTIFACT_MAX_FILES = 200 as const;
export const P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const P2P_WORKFLOW_ARTIFACT_MAX_DEPTH = 8 as const;

export const P2P_SCRIPT_DEFAULT_STDIN_MAX_BYTES = 64 * 1024;
export const P2P_SCRIPT_DEFAULT_STDOUT_MAX_BYTES = 256 * 1024;
export const P2P_SCRIPT_DEFAULT_STDERR_MAX_BYTES = 128 * 1024;
export const P2P_SCRIPT_DEFAULT_MACHINE_OUTPUT_MAX_BYTES = 128 * 1024;
export const P2P_SCRIPT_MACHINE_OUTPUT_KIND = 'p2p_script_machine_output_v1' as const;

export const P2P_WORKFLOW_CAPABILITY_V1 = 'p2p.workflow.v1' as const;
export const P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1 = 'p2p.workflow.script.argv.v1' as const;
export const P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1 = 'p2p.workflow.script.interpreter.v1' as const;
export const P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1 = 'p2p.workflow.openspec-artifacts.v1' as const;
export const P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1 = 'p2p.workflow.implementation.v1' as const;

export const P2P_WORKFLOW_CAPABILITIES = [
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
  P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
] as const;

export type P2pWorkflowCapability = (typeof P2P_WORKFLOW_CAPABILITIES)[number];

export const P2P_WORKFLOW_KINDS = ['legacy', 'combo', 'advanced'] as const;
export type P2pWorkflowKind = (typeof P2P_WORKFLOW_KINDS)[number];

export const P2P_NODE_KINDS = ['llm', 'logic', 'script'] as const;
export type P2pNodeKind = (typeof P2P_NODE_KINDS)[number];

export const P2P_PRESET_KEYS = [
  'brainstorm',
  'discuss',
  'audit',
  'review',
  'plan',
  'openspec_propose',
  'proposal_audit',
  'implementation',
  'implementation_audit',
  'custom',
] as const;
export type P2pPresetKey = (typeof P2P_PRESET_KEYS)[number];

export const P2P_NODE_DISPATCH_STYLES = ['single_main', 'multi_dispatch'] as const;
export type P2pNodeDispatchStyle = (typeof P2P_NODE_DISPATCH_STYLES)[number];

export const P2P_EDGE_KINDS = ['default', 'conditional'] as const;
export type P2pEdgeKind = (typeof P2P_EDGE_KINDS)[number];

export const P2P_EDGE_CONDITION_KINDS = [
  'routing_key_equals',
  'verdict_marker_equals',
  'logic_marker_equals',
] as const;
export type P2pEdgeConditionKind = (typeof P2P_EDGE_CONDITION_KINDS)[number];

export const P2P_PERMISSION_SCOPES = [
  'analysis_only',
  'artifact_generation',
  'implementation',
] as const;
export type P2pPermissionScope = (typeof P2P_PERMISSION_SCOPES)[number];

export const P2P_ARTIFACT_CONVENTIONS = [
  'none',
  'explicit_paths',
  'openspec_convention',
] as const;
export type P2pArtifactConvention = (typeof P2P_ARTIFACT_CONVENTIONS)[number];

export const P2P_ARTIFACT_PHASES = ['freeze', 'create', 'validate', 'baseline'] as const;
export type P2pArtifactPhase = (typeof P2P_ARTIFACT_PHASES)[number];

export const P2P_START_CONTEXT_SOURCE_KINDS = [
  'current_prompt',
  'associated_discussion_file',
  'recent_discussion_history',
  'file_reference',
] as const;
export type P2pStartContextSourceKind = (typeof P2P_START_CONTEXT_SOURCE_KINDS)[number];

export const P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES = [
  'compiledWorkflow',
  'boundWorkflow',
  'privateRuntimeState',
  'runtimePrivateState',
  'rawPrompt',
  'rawPromptText',
  'scriptRawOutputs',
  'rawScriptOutput',
  'artifactBaselines',
  'privateArtifactBaselines',
  'editorCache',
  'hiddenEditorCache',
  'env',
  'environment',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
] as const;

export const P2P_REQUEST_ID_MAX_BYTES = 128 as const;
export const P2P_REQUEST_ID_ASCII_PATTERN = /^[\x21-\x7e]{1,128}$/;

export const P2P_BRIDGE_PENDING_REQUEST_TIMEOUT_MS = 30_000 as const;
export const P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET = 16 as const;
export const P2P_BRIDGE_PENDING_REQUESTS_GLOBAL = 512 as const;
export const P2P_BRIDGE_ERROR_CODES = {
  INVALID_REQUEST_ID: 'invalid_request_id',
  DUPLICATE_REQUEST_ID: 'duplicate_request_id',
  WRONG_PEER: 'p2p_wrong_peer',
  ROUTE_POLICY_ERROR: 'p2p_route_policy_error',
  PENDING_LIMIT_EXCEEDED: 'p2p_pending_limit_exceeded',
} as const;

export const P2P_SANITIZE_MAX_STRING_BYTES = 4096 as const;
export const P2P_SANITIZE_MAX_ARRAY_ITEMS = 64 as const;
export const P2P_SANITIZE_MAX_OBJECT_KEYS = 64 as const;
export const P2P_SANITIZE_MAX_DEPTH = 6 as const;
export const P2P_SANITIZE_MAX_TOTAL_BYTES = 64 * 1024;
