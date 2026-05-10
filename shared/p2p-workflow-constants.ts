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
 * Audit fix (94b9b837-822 / A2) — FIFO retention cap for
 * `P2pRun.routingHistory`. Long-running advanced workflows that loop
 * through compiled-edge jumps push to `routingHistory` on every jump and
 * default-edge advance with no upper bound; combined with the
 * projection-flush spread `[...routingHistory]` per debounce tick this is
 * a real per-run growth source. Cap mirrors the FIFO-trim pattern used
 * for `helperDiagnostics` (`p2p-orchestrator.ts:1306-1310`).
 *
 * 500 entries is large enough to keep meaningful forensic history for
 * any reasonable workflow (P2P_WORKFLOW_MAX_NODES = 64) while bounding
 * worst-case heap pressure under loops.
 */
export const P2P_ROUTING_HISTORY_RETENTION_COUNT = 500;

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

/**
 * R3 v2 PR-λ — Default `permissionScope` for each preset. The
 * `validateNodeCombination` rules in `shared/p2p-workflow-validators.ts`
 * are strict about which preset/scope pairs compile (e.g.
 * `implementation` requires `implementation` scope, `openspec_propose`
 * requires `artifact_generation`). The canvas editor reads this lookup
 * to auto-switch the scope when the user picks a preset, so they never
 * land in an invalid combination by accident.
 */
export const P2P_PRESET_DEFAULT_PERMISSION_SCOPE: Record<P2pPresetKey, P2pPermissionScope> = {
  brainstorm: 'analysis_only',
  discuss: 'analysis_only',
  audit: 'analysis_only',
  review: 'analysis_only',
  plan: 'analysis_only',
  openspec_propose: 'artifact_generation',
  proposal_audit: 'analysis_only',
  implementation: 'implementation',
  implementation_audit: 'analysis_only',
  custom: 'analysis_only',
};

/**
 * R3 v2 PR-λ — Default dispatch style for each preset. Single-main
 * presets (`implementation`, `openspec_propose`, `proposal_audit`,
 * `implementation_audit`) have ONE authoritative agent; multi-dispatch
 * presets (`brainstorm`, `discuss`, `audit`, `review`, `plan`) fan out
 * to every enabled participant. `custom` defaults to `single_main`
 * because logic / script nodes are inherently single-actor.
 */
export const P2P_PRESET_DEFAULT_DISPATCH_STYLE: Record<P2pPresetKey, P2pNodeDispatchStyle> = {
  brainstorm: 'multi_dispatch',
  discuss: 'multi_dispatch',
  audit: 'multi_dispatch',
  review: 'multi_dispatch',
  plan: 'multi_dispatch',
  openspec_propose: 'single_main',
  proposal_audit: 'single_main',
  implementation: 'single_main',
  implementation_audit: 'single_main',
  custom: 'single_main',
};

/**
 * R3 v2 PR-λ — Default prompt suggestion for each workflow preset.
 * Surfaced in the canvas editor as the `promptAppend` textarea
 * placeholder so users see what the preset will guide the agent to do
 * even when they leave the field blank. The text intentionally mirrors
 * the legacy `PRESET_PROMPTS` map in `shared/p2p-advanced.ts` for the
 * three overlapping presets (`openspec_propose`, `proposal_audit`,
 * `implementation`, `implementation_audit`, `custom`) and adds prompts
 * for the five remaining workflow-only presets.
 */
export const P2P_PRESET_DEFAULT_PROMPT: Record<P2pPresetKey, string> = {
  brainstorm: 'Explore the request from multiple angles. Generate diverse ideas, alternative approaches, and unexpected connections without prematurely converging.',
  discuss: 'Clarify the request, surface missing constraints, and synthesize the strongest next-step understanding from the discussion file and referenced code.',
  audit: 'Audit the provided context for security vulnerabilities, logic errors, and risks. Cite specific code locations and rate severity.',
  review: 'Review the provided context for code quality, maintainability, performance, and adherence to best practices. Suggest concrete improvements.',
  plan: 'Design an implementation plan from the request and discussion evidence. Break down work into clear steps, identify dependencies and risks, and define acceptance criteria.',
  openspec_propose: 'Produce an OpenSpec-ready proposal/design/tasks result from the discussion and code context. Write concrete artifacts, acceptance criteria, and implementation scope rather than broad notes.',
  proposal_audit: 'Audit the proposal artifacts for missing scope, missing acceptance criteria, contradictions, and weak assumptions. Strengthen the proposal without changing the requested objective.',
  implementation: 'Execute the implementation work required by the current round. Prefer concrete code and tests over commentary, while staying within the stated scope and artifact targets.',
  implementation_audit: 'Audit the implementation result against the requested scope, artifact outputs, and acceptance criteria. End with an authoritative verdict marker.',
  custom: 'Follow the configured round contract exactly. Stay within the declared permission scope and use the configured outputs and prompt append as the operative instruction.',
};

/**
 * R3 v2 PR-μ — Default *summary* prompt for each workflow preset.
 *
 * The legacy combo system (`audit→plan` etc.) attached a rich,
 * structured summary prompt to every mode (see `BUILT_IN_MODES` in
 * `shared/p2p-modes.ts`). The previous workflow-system implementation
 * lost this almost entirely:
 *
 *   1. workflow presets `brainstorm/discuss/audit/review/plan` were
 *      collapsed to legacy `'discussion'` by `roundPresetFromWorkflowPreset`,
 *      so the rich `BUILT_IN_MODES.audit.summaryPrompt` etc. NEVER fired.
 *   2. `single_main` rounds (`implementation`, `proposal_audit`,
 *      `implementation_audit`, `openspec_propose`) had
 *      `synthesisStyle = 'none'` → no summary phase at all.
 *   3. Final-run synthesis fell back to a generic one-liner.
 *
 * This map is the single source of truth for the per-preset summary
 * prompt. The canvas inspector exposes it as the placeholder for an
 * editable `summaryPromptOverride` textarea, the workflow adapter
 * carries it onto the legacy round, and the orchestrator dispatches a
 * summary hop on EVERY round that has a non-empty effective summary
 * prompt — including `single_main`. See PR-μ in `tasks.md`.
 */
export const P2P_PRESET_DEFAULT_SUMMARY_PROMPT: Record<P2pPresetKey, string> = {
  brainstorm:
    'Write a complete **Ideas & Approaches Summary** that organizes all ideas generated this round. Structure it as:\n'
    + '1. **Top Recommendations** — the 3-5 strongest ideas, each with description, key advantage, feasibility, and rough effort.\n'
    + '2. **Alternative Approaches** — other viable options grouped by theme, with pros/cons.\n'
    + '3. **Creative Angles** — unconventional ideas worth exploring further.\n'
    + '4. **Discarded Ideas** — approaches considered and rejected, with reasons.\n'
    + '5. **Suggested Next Steps** — concrete actions to evaluate or prototype the top recommendations.',
  discuss:
    'Write a complete **Discussion Conclusion** that synthesizes all perspectives this round. Structure it as:\n'
    + '1. **Consensus** — positions where all participants agreed, with supporting reasoning.\n'
    + '2. **Key Trade-offs** — the main trade-offs evaluated, with analysis of each option.\n'
    + '3. **Recommendation** — the recommended path forward with justification.\n'
    + '4. **Dissenting Views** — important disagreements that remain.\n'
    + '5. **Action Items** — concrete next steps.',
  audit:
    'Write a complete **Audit Report** that consolidates all findings this round. Structure it as:\n'
    + '1. **Executive Summary** — one-paragraph overall risk assessment.\n'
    + '2. **Critical Findings** — vulnerabilities and logic errors with: description, code location, severity (Critical/High/Medium/Low), exploitation scenario, recommended fix.\n'
    + '3. **Additional Findings** — code quality issues and edge cases.\n'
    + '4. **Positive Observations** — things done well that should be preserved.\n'
    + '5. **Recommended Actions** — prioritized list with effort estimates.\n'
    + 'Cite file paths, line numbers, and code snippets for every finding.',
  review:
    'Write a complete **Code Review Report** that consolidates all feedback this round. Structure it as:\n'
    + '1. **Summary** — overall code quality and readiness verdict (approve / request changes / needs major rework).\n'
    + '2. **Must Fix** — blocking issues: bugs, performance, security, broken contracts.\n'
    + '3. **Should Fix** — non-blocking but important: naming, structure, missing error handling, test gaps.\n'
    + '4. **Consider** — optional improvements: refactoring opportunities, alternatives, documentation.\n'
    + '5. **Strengths** — well-designed aspects worth highlighting.\n'
    + 'Cite the specific file and code, explain the problem, and provide a concrete fix or code suggestion for each item.',
  plan:
    'Write a complete **Implementation Plan** that synthesizes the request and discussion evidence into an actionable blueprint. Structure it as:\n'
    + '1. **Goal and Scope** — what must be delivered, what is in scope, what is explicitly out of scope.\n'
    + '2. **Current Context** — relevant existing behavior, constraints, conclusions that drive the plan.\n'
    + '3. **Architecture Overview** — key components, data flow, interfaces, state transitions.\n'
    + '4. **Implementation Phases** — ordered tasks with file paths, function/type changes, dependencies, sequencing, edge cases, rollout notes.\n'
    + '5. **Acceptance and Validation** — explicit acceptance criteria + concrete verification steps and tests.\n'
    + '6. **Risk Assessment** — risks with mitigation strategies.\n'
    + '7. **Open Questions** — unresolved decisions needing stakeholder input.',
  openspec_propose:
    'Write a complete **OpenSpec Proposal Synthesis** for this round. Structure it as:\n'
    + '1. **Proposal Statement** — what the change is and why.\n'
    + '2. **Scope and Out of Scope** — explicit boundaries.\n'
    + '3. **Design Highlights** — key architectural decisions and why.\n'
    + '4. **Tasks Breakdown** — actionable items with acceptance signals.\n'
    + '5. **Risks and Mitigations**.\n'
    + 'Reference the artifact files (proposal.md / design.md / tasks.md) you authored.',
  proposal_audit:
    'Write one authoritative **Proposal Audit Synthesis** for this round. Structure it as:\n'
    + '1. **Audit Verdict** — one sentence on whether the proposal is ready.\n'
    + '2. **Missing Scope** — what the proposal does not yet cover.\n'
    + '3. **Weak Assumptions** — claims that need stronger evidence.\n'
    + '4. **Contradictions** — internal inconsistencies.\n'
    + '5. **Recommended Strengthening** — concrete edits to apply before proceeding.',
  implementation:
    'Write a complete **Implementation Summary** for this round. Structure it as:\n'
    + '1. **What Was Implemented** — concise list of what changed.\n'
    + '2. **Files Touched** — relative paths grouped by purpose.\n'
    + '3. **Test Coverage Added** — new/updated tests with what they prove.\n'
    + '4. **Known Gaps / Followups** — anything intentionally deferred.\n'
    + '5. **Validation Results** — outcome of build / typecheck / tests if run.\n'
    + 'Be specific: name files and functions, do not summarize abstractly.',
  implementation_audit:
    'Write one authoritative **Implementation Audit Synthesis** for this round. Structure it as:\n'
    + '1. **Verdict Marker** — end the synthesis with EXACTLY one of: `<!-- P2P_VERDICT: PASS -->` or `<!-- P2P_VERDICT: REWORK -->`.\n'
    + '2. **What Was Audited** — files and behaviors examined.\n'
    + '3. **Issues Found** — each with severity, file/line citation, and required fix.\n'
    + '4. **Acceptance Criteria Check** — pass/fail per criterion from the proposal.\n'
    + '5. **Required Followup Tasks** — only when verdict is REWORK.',
  custom:
    'Write a synthesis of this round\'s outputs that follows the configured round contract. Be specific and cite files; do not summarize abstractly.',
};

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
