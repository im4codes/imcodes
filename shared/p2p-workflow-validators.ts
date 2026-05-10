import {
  P2P_EDGE_CONDITION_KINDS,
  P2P_EDGE_KINDS,
  P2P_ARTIFACT_CONVENTIONS,
  P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES,
  P2P_NODE_DISPATCH_STYLES,
  P2P_NODE_KINDS,
  P2P_PERMISSION_SCOPES,
  P2P_PRESET_KEYS,
  P2P_ALLOWED_EXECUTABLE_MAX_BYTES,
  P2P_ALLOWED_EXECUTABLE_PATTERN,
  P2P_REQUEST_ID_ASCII_PATTERN,
  P2P_START_CONTEXT_SOURCE_KINDS,
  P2P_WORKFLOW_ARTIFACT_MAX_DEPTH,
  P2P_WORKFLOW_ARTIFACT_MAX_FILES,
  P2P_WORKFLOW_CAPABILITIES,
  P2P_WORKFLOW_KINDS,
  P2P_WORKFLOW_KNOWN_SCHEMA_MAX,
  P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES,
  P2P_WORKFLOW_MAX_VARIABLE_BYTES,
  P2P_WORKFLOW_MAX_VARIABLES,
  P2P_WORKFLOW_PROJECTION_VERSION,
  P2P_WORKFLOW_SCHEMA_VERSION,
  type P2pEdgeConditionKind,
  type P2pNodeKind,
  type P2pPermissionScope,
  type P2pPresetKey,
} from './p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';
import { P2P_WORKFLOW_DIAGNOSTIC_CODES } from './p2p-workflow-diagnostics.js';
import { getP2pArtifactPathDepth, isP2pArtifactRelativePath } from './p2p-workflow-artifact-paths.js';
import { validateP2pScriptContract } from './p2p-workflow-script.js';
import type {
  P2pArtifactContract,
  P2pPersistedWorkflowSnapshot,
  P2pWorkflowStartContext,
  P2pWorkflowStatusProjection,
  P2pWorkflowDraft,
  P2pWorkflowEdgeCondition,
  P2pWorkflowEdgeDraft,
  P2pWorkflowLaunchEnvelope,
  P2pWorkflowNodeDraft,
  P2pWorkflowVariableDefinition,
  P2pWorkflowVariableValue,
} from './p2p-workflow-types.js';

export type P2pValidationResult<T> =
  | { ok: true; value: T; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

const VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN_FIELD_SET = new Set<string>(P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES);
const FORBIDDEN_SCAN_MAX_DEPTH = 32;
const FORBIDDEN_SCAN_MAX_NODES = 5_000;
const FORBIDDEN_SCAN_MAX_ARRAY_ITEMS = 1_000;
const FORBIDDEN_SCAN_MAX_STRING_BYTES = 256 * 1024;
const SHORT_TEXT_MAX_BYTES = 4 * 1024;
const START_CONTEXT_SOURCE_MAX_BYTES = 512 * 1024;
const START_CONTEXT_TOTAL_MAX_BYTES = 1024 * 1024;
const DIAGNOSTIC_CODES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodedJsonByteLength(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

function hasAnyOwn(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

export function findForbiddenEnvelopeField(
  value: unknown,
  path = '',
  state: { depth: number; nodes: number; visited: WeakSet<object> } = { depth: 0, nodes: 0, visited: new WeakSet<object>() },
): string | null {
  if (typeof value === 'string') return byteLength(value) > FORBIDDEN_SCAN_MAX_STRING_BYTES ? path || '$' : null;
  if (!isRecord(value) && !Array.isArray(value)) return null;
  if (state.visited.has(value)) return null;
  state.visited.add(value);
  state.nodes += 1;
  if (state.depth > FORBIDDEN_SCAN_MAX_DEPTH || state.nodes > FORBIDDEN_SCAN_MAX_NODES) return path || '$';
  if (Array.isArray(value)) {
    if (value.length > FORBIDDEN_SCAN_MAX_ARRAY_ITEMS) return path || '$';
    for (let index = 0; index < value.length; index += 1) {
      const previousDepth = state.depth;
      state.depth = previousDepth + 1;
      const nested = findForbiddenEnvelopeField(value[index], `${path}[${index}]`, state);
      state.depth = previousDepth;
      if (nested) return nested;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      FORBIDDEN_FIELD_SET.has(key) ||
      normalizedKey.endsWith('token') ||
      normalizedKey.endsWith('secret') ||
      normalizedKey.endsWith('apikey') ||
      normalizedKey === 'env' ||
      normalizedKey === 'environment'
    ) {
      return path ? `${path}.${key}` : key;
    }
    const previousDepth = state.depth;
    state.depth = previousDepth + 1;
    const nested = findForbiddenEnvelopeField(value[key], path ? `${path}.${key}` : key, state);
    state.depth = previousDepth;
    if (nested) return nested;
  }
  return null;
}

export function hasOldAdvancedFields(value: unknown): boolean {
  return isRecord(value) && hasAnyOwn(value, ['advancedPresetKey', 'advancedRounds', 'advancedRunTimeoutMinutes', 'contextReducer', 'oldAdvanced']);
}

export function hasNewWorkflowFields(value: unknown): boolean {
  return isRecord(value) && hasAnyOwn(value, [
    'workflowSchemaVersion',
    'workflowKind',
    'advancedDraft',
    'launchContext',
    'requiredDaemonCapabilities',
    // Audit:R3 PR-γ — `expectedStaticPolicyHash` is a v1a envelope field that
    // marks a launch as "compiled against a known static policy". Including it
    // here ensures `migrate` paths see the field and don't classify the
    // envelope as legacy.
    'expectedStaticPolicyHash',
  ]);
}

export function validateP2pWorkflowLaunchEnvelope(input: unknown): P2pValidationResult<P2pWorkflowLaunchEnvelope> {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { summary: 'Envelope must be an object.' })] };
  }

  const forbiddenField = findForbiddenEnvelopeField(input);
  if (forbiddenField) {
    return {
      ok: false,
      diagnostics: [makeP2pWorkflowDiagnostic('forbidden_envelope_field', 'parse', { fieldPath: forbiddenField })],
    };
  }

  const oldAdvancedAtTop = hasAnyOwn(input, ['advancedPresetKey', 'advancedRounds', 'advancedRunTimeoutMinutes', 'contextReducer']);
  const oldAdvancedNested = isRecord(input.oldAdvanced);
  const newWorkflow = hasNewWorkflowFields(input) || isRecord(input.advancedDraft);
  const hasOldOnlyInput = oldAdvancedAtTop || oldAdvancedNested;
  if (hasOldOnlyInput && newWorkflow && !oldAdvancedNested) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('mixed_advanced_schema_fields', 'parse')] };
  }
  if (hasOldOnlyInput && isRecord(input.advancedDraft)) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('mixed_advanced_schema_fields', 'parse')] };
  }

  const version = input.workflowSchemaVersion;
  if (version !== P2P_WORKFLOW_SCHEMA_VERSION) {
    if (typeof version === 'number' && version > P2P_WORKFLOW_KNOWN_SCHEMA_MAX) {
      return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('unsupported_schema_version', 'parse')] };
    }
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { summary: 'Unsupported or missing workflow schema version.' })] };
  }

  if (!isOneOf(input.workflowKind, P2P_WORKFLOW_KINDS)) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: 'workflowKind' })] };
  }
  if (input.requiredDaemonCapabilities !== undefined) {
    diagnostics.push(...validateP2pRequiredDaemonCapabilities(input.requiredDaemonCapabilities, 'requiredDaemonCapabilities'));
  }
  if (input.expectedStaticPolicyHash !== undefined) {
    // Audit:R3 PR-δ (A6 / Cu1-M2 / Cx1-R2-6) — implementation MUST match
    // the comment "string ≤128 ASCII bytes". Previously only JS string
    // length was checked; multi-byte characters could pass at 128 code
    // units (≈384 bytes). Now we enforce the visible-ASCII pattern (same
    // as `P2P_REQUEST_ID_ASCII_PATTERN`) AND the UTF-8 byte length cap.
    // The pattern already restricts to single-byte ASCII so the byte cap
    // is technically redundant, but the explicit `TextEncoder` check
    // protects against future pattern relaxation.
    const hash = input.expectedStaticPolicyHash;
    let bytes = 0;
    if (typeof hash === 'string') {
      try {
        bytes = new TextEncoder().encode(hash).byteLength;
      } catch {
        bytes = Number.POSITIVE_INFINITY;
      }
    }
    if (
      typeof hash !== 'string'
      || hash.length === 0
      || hash.length > 128
      || !P2P_REQUEST_ID_ASCII_PATTERN.test(hash)
      || bytes > 128
    ) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: 'expectedStaticPolicyHash' }));
    }
  }
  if (input.launchContext !== undefined) {
    diagnostics.push(...validateP2pWorkflowLaunchContext(input.launchContext, 'launchContext'));
  }
  if (input.migrationPolicy !== undefined) {
    if (!isRecord(input.migrationPolicy) || input.migrationPolicy.kind !== 'materialize_old_advanced' || !isRecord(input.oldAdvanced)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: 'migrationPolicy' }));
    }
  }
  if (input.allowedExecutables !== undefined) {
    // R3 PR-α follow-up — UI-driven allowlist on the envelope.
    // - Must be an array
    // - ≤64 entries
    // - Each entry must be a non-empty visible-ASCII string ≤256 bytes
    // - No duplicates (post-validation the daemon dedupes anyway, but the
    //   envelope shape SHOULD round-trip cleanly to/from the UI)
    if (!Array.isArray(input.allowedExecutables) || input.allowedExecutables.length > 64) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: 'allowedExecutables' }));
    } else {
      const seen = new Set<string>();
      const encoder = new TextEncoder();
      input.allowedExecutables.forEach((entry, index) => {
        // R3 v2 PR-ζ (Cx1-A6 / ζ-14) — pattern is visible-ASCII (no
        // length cap baked in), and the 256-byte limit is applied via
        // `TextEncoder.byteLength` so the comment's "≤256 bytes" intent
        // matches reality. Previous implementation reused the requestId
        // pattern (capped at 128 chars), so entries 129–256 chars
        // failed validation despite the documented 256-byte cap.
        if (typeof entry !== 'string'
          || entry.length === 0
          || encoder.encode(entry).byteLength > P2P_ALLOWED_EXECUTABLE_MAX_BYTES
          || !P2P_ALLOWED_EXECUTABLE_PATTERN.test(entry)) {
          diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `allowedExecutables[${index}]` }));
          return;
        }
        if (seen.has(entry)) {
          diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `allowedExecutables[${index}]`, summary: 'Duplicate allowedExecutables entry.' }));
          return;
        }
        seen.add(entry);
      });
    }
  }

  if (input.advancedDraft !== undefined) {
    const draftResult = validateP2pWorkflowDraft(input.advancedDraft);
    diagnostics.push(...draftResult.diagnostics);
    if (!draftResult.ok) return { ok: false, diagnostics };
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { ok: false, diagnostics };
  }
  return { ok: true, value: input as unknown as P2pWorkflowLaunchEnvelope, diagnostics };
}

export function validateP2pWorkflowDraft(input: unknown): P2pValidationResult<P2pWorkflowDraft> {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { summary: 'Draft must be an object.' })] };
  }
  if (input.schemaVersion !== P2P_WORKFLOW_SCHEMA_VERSION) {
    return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('unsupported_schema_version', 'compile', { fieldPath: 'schemaVersion' })] };
  }
  if (typeof input.id !== 'string' || input.id.trim() === '') {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: 'id' }));
  }
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: 'nodes' }));
  } else {
    for (const [index, node] of input.nodes.entries()) {
      diagnostics.push(...validateNodeDraft(node, `nodes[${index}]`));
    }
  }
  if (!Array.isArray(input.edges)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: 'edges' }));
  } else {
    for (const [index, edge] of input.edges.entries()) {
      diagnostics.push(...validateEdgeDraft(edge, `edges[${index}]`));
    }
  }
  if (input.variables !== undefined) {
    if (!Array.isArray(input.variables)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { fieldPath: 'variables' }));
    } else {
      diagnostics.push(...validateP2pWorkflowVariables(input.variables));
    }
  }
  if (input.startContext !== undefined) {
    diagnostics.push(...validateP2pWorkflowStartContext(input.startContext, 'startContext'));
  }
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { ok: false, diagnostics }
    : { ok: true, value: input as unknown as P2pWorkflowDraft, diagnostics };
}

export function validateP2pWorkflowVariables(input: unknown[]): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (input.length > P2P_WORKFLOW_MAX_VARIABLES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { summary: 'Too many workflow variables.' }));
  }
  const seen = new Set<string>();
  for (const [index, rawVariable] of input.entries()) {
    if (!isRecord(rawVariable)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { fieldPath: `variables[${index}]` }));
      continue;
    }
    const variable = rawVariable as Partial<P2pWorkflowVariableDefinition>;
    if (typeof variable.name !== 'string' || !VARIABLE_NAME_RE.test(variable.name)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { fieldPath: `variables[${index}].name` }));
    } else if (seen.has(variable.name)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { fieldPath: `variables[${index}].name`, summary: 'Duplicate workflow variable.' }));
    } else {
      seen.add(variable.name);
    }
    if (!isP2pWorkflowVariableValue(variable.value)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { fieldPath: `variables[${index}].value` }));
    } else if (encodedJsonByteLength(variable.value) > P2P_WORKFLOW_MAX_VARIABLE_BYTES) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_variable', 'compile', { fieldPath: `variables[${index}].value`, summary: 'Workflow variable exceeds byte limit.' }));
    }
  }
  return diagnostics;
}

export function isP2pWorkflowVariableValue(value: unknown): value is P2pWorkflowVariableValue {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

export function validateNodeDraft(input: unknown, fieldPath: string): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isRecord(input)) {
    return [makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath })];
  }
  const node = input as Partial<P2pWorkflowNodeDraft>;
  if (typeof node.id !== 'string' || node.id.trim() === '') {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.id` }));
  }
  if (!isOneOf(node.nodeKind, P2P_NODE_KINDS)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.nodeKind` }));
  }
  if (!isOneOf(node.preset, P2P_PRESET_KEYS)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.preset` }));
  }
  if (node.dispatchStyle !== undefined && !isOneOf(node.dispatchStyle, P2P_NODE_DISPATCH_STYLES)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.dispatchStyle` }));
  }
  if (node.permissionScope !== undefined && !isOneOf(node.permissionScope, P2P_PERMISSION_SCOPES)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.permissionScope` }));
  }
  diagnostics.push(...validateNodeCombination(node, fieldPath));
  if (typeof node.promptAppend === 'string' && byteLength(node.promptAppend) > P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_prompt_append', 'compile', { fieldPath: `${fieldPath}.promptAppend` }));
  }
  // R3 v2 PR-μ — `summaryPromptOverride` shares the prompt-append byte
  // budget; over-budget overrides emit the same `invalid_prompt_append`
  // diagnostic so the canvas surfaces them inline.
  if (typeof node.summaryPromptOverride === 'string' && byteLength(node.summaryPromptOverride) > P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_prompt_append', 'compile', { fieldPath: `${fieldPath}.summaryPromptOverride` }));
  }
  if (node.nodeKind === 'script') {
    diagnostics.push(...validateP2pScriptNodeContract(node.script, `${fieldPath}.script`));
  } else if (node.script !== undefined) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_script_contract', 'compile', { fieldPath: `${fieldPath}.script` }));
  }
  if (node.artifacts !== undefined) {
    if (!Array.isArray(node.artifacts)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath: `${fieldPath}.artifacts` }));
    } else {
      for (const [index, artifact] of node.artifacts.entries()) {
        diagnostics.push(...validateP2pArtifactContract(artifact, `${fieldPath}.artifacts[${index}]`));
      }
    }
  }
  return diagnostics;
}

export function validateEdgeDraft(input: unknown, fieldPath: string): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isRecord(input)) {
    return [makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath })];
  }
  const edge = input as Partial<P2pWorkflowEdgeDraft>;
  for (const key of ['id', 'fromNodeId', 'toNodeId'] as const) {
    if (typeof edge[key] !== 'string' || edge[key]?.trim() === '') {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.${key}` }));
    }
  }
  if (!isOneOf(edge.edgeKind, P2P_EDGE_KINDS)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `${fieldPath}.edgeKind` }));
  }
  if (edge.edgeKind === 'conditional') {
    diagnostics.push(...validateEdgeCondition(edge.condition, `${fieldPath}.condition`));
  }
  return diagnostics;
}

function validateEdgeCondition(input: unknown, fieldPath: string): P2pWorkflowDiagnostic[] {
  if (!isRecord(input)) return [makeP2pWorkflowDiagnostic('invalid_edge_condition', 'compile', { fieldPath })];
  const condition = input as Partial<P2pWorkflowEdgeCondition>;
  if (!isOneOf(condition.kind, P2P_EDGE_CONDITION_KINDS)) {
    return [makeP2pWorkflowDiagnostic('invalid_edge_condition', 'compile', { fieldPath: `${fieldPath}.kind` })];
  }
  if (typeof condition.equals !== 'string' || condition.equals === '') {
    return [makeP2pWorkflowDiagnostic('invalid_edge_condition', 'compile', { fieldPath: `${fieldPath}.equals` })];
  }
  return [];
}

export function validateP2pScriptNodeContract(input: unknown, fieldPath = 'script'): P2pWorkflowDiagnostic[] {
  const result = validateP2pScriptContract(input, fieldPath);
  return result.diagnostics;
}

export function validateP2pArtifactContract(input: unknown, fieldPath = 'artifact'): P2pWorkflowDiagnostic[] {
  if (!isRecord(input)) return [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath })];
  const artifact = input as Partial<P2pArtifactContract>;
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isOneOf(artifact.convention, P2P_ARTIFACT_CONVENTIONS)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath: `${fieldPath}.convention` }));
  }
  if (artifact.permissionScope !== undefined && !isOneOf(artifact.permissionScope, P2P_PERMISSION_SCOPES)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath: `${fieldPath}.permissionScope` }));
  }
  if (artifact.symlinkPolicy !== undefined && artifact.symlinkPolicy !== 'reject_all' && artifact.symlinkPolicy !== 'allow_existing_under_root') {
    diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath: `${fieldPath}.symlinkPolicy` }));
  }
  if (!Array.isArray(artifact.paths) || artifact.paths.length === 0 || artifact.paths.length > P2P_WORKFLOW_ARTIFACT_MAX_FILES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath: `${fieldPath}.paths` }));
  } else {
    for (const [index, path] of artifact.paths.entries()) {
      if (typeof path !== 'string' || !isP2pArtifactRelativePath(path) || getP2pArtifactPathDepth(path) > P2P_WORKFLOW_ARTIFACT_MAX_DEPTH) {
        diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath: `${fieldPath}.paths[${index}]` }));
      }
    }
  }
  return diagnostics;
}

export function isSafeRelativeArtifactPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('~') || path.includes('\0') || path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('//')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function coerceNodeKind(value: unknown): P2pNodeKind | null {
  return isOneOf(value, P2P_NODE_KINDS) ? value : null;
}

export function coercePreset(value: unknown): P2pPresetKey | null {
  return isOneOf(value, P2P_PRESET_KEYS) ? value : null;
}

export function coercePermissionScope(value: unknown): P2pPermissionScope | null {
  return isOneOf(value, P2P_PERMISSION_SCOPES) ? value : null;
}

export function coerceEdgeConditionKind(value: unknown): P2pEdgeConditionKind | null {
  return isOneOf(value, P2P_EDGE_CONDITION_KINDS) ? value : null;
}

export function validateP2pWorkflowStartContext(input: unknown, fieldPath = 'startContext'): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isRecord(input) || !Array.isArray(input.sources)) {
    return [makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath })];
  }
  const context = input as Partial<P2pWorkflowStartContext>;
  if (context.maxTotalBytes !== undefined && (!Number.isInteger(context.maxTotalBytes) || context.maxTotalBytes < 0 || context.maxTotalBytes > START_CONTEXT_TOTAL_MAX_BYTES)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('context_source_too_large', 'bind', { fieldPath: `${fieldPath}.maxTotalBytes` }));
  }
  const seen = new Set<string>();
  for (const [index, rawSource] of input.sources.entries()) {
    const sourcePath = `${fieldPath}.sources[${index}]`;
    if (!isRecord(rawSource)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: sourcePath }));
      continue;
    }
    if (!isOneOf(rawSource.kind, P2P_START_CONTEXT_SOURCE_KINDS)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${sourcePath}.kind` }));
    }
    if (typeof rawSource.id !== 'string' || rawSource.id.trim() === '' || byteLength(rawSource.id) > SHORT_TEXT_MAX_BYTES || seen.has(rawSource.id)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${sourcePath}.id` }));
    } else {
      seen.add(rawSource.id);
    }
    const maxBytes = rawSource.maxBytes;
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > START_CONTEXT_SOURCE_MAX_BYTES)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('context_source_too_large', 'bind', { fieldPath: `${sourcePath}.maxBytes` }));
    }
    if (rawSource.missingBehavior !== undefined && rawSource.missingBehavior !== 'fail' && rawSource.missingBehavior !== 'skip') {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${sourcePath}.missingBehavior` }));
    }
    if (rawSource.binaryBehavior !== undefined && rawSource.binaryBehavior !== 'fail' && rawSource.binaryBehavior !== 'skip') {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${sourcePath}.binaryBehavior` }));
    }
    if (rawSource.order !== undefined && !Number.isInteger(rawSource.order)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${sourcePath}.order` }));
    }
    if (rawSource.kind === 'file_reference') {
      if (typeof rawSource.path !== 'string' || !isP2pArtifactRelativePath(rawSource.path)) {
        diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', { fieldPath: `${sourcePath}.path` }));
      }
    } else if (rawSource.path !== undefined && (typeof rawSource.path !== 'string' || !isP2pArtifactRelativePath(rawSource.path))) {
      diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', { fieldPath: `${sourcePath}.path` }));
    }
    if (rawSource.discussionOffset !== undefined) {
      diagnostics.push(...validateDiscussionOffset(rawSource.discussionOffset, `${sourcePath}.discussionOffset`));
    }
  }
  return diagnostics;
}

export function validateP2pRequiredDaemonCapabilities(input: unknown, fieldPath = 'requiredDaemonCapabilities'): P2pWorkflowDiagnostic[] {
  if (!Array.isArray(input)) return [makeP2pWorkflowDiagnostic('missing_required_capability', 'web_validate', { fieldPath })];
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [index, capability] of input.entries()) {
    if (typeof capability !== 'string' || !(P2P_WORKFLOW_CAPABILITIES as readonly string[]).includes(capability) || seen.has(capability)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_required_capability', 'web_validate', { fieldPath: `${fieldPath}[${index}]` }));
    } else {
      seen.add(capability);
    }
  }
  return diagnostics;
}

export function validateP2pWorkflowLaunchContext(input: unknown, fieldPath = 'launchContext'): P2pWorkflowDiagnostic[] {
  if (!isRecord(input)) return [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath })];
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const stringFields = ['runId', 'sessionName', 'projectRoot', 'userText', 'locale'] as const;
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !P2P_REQUEST_ID_ASCII_PATTERN.test(input.requestId))) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.requestId` }));
  }
  for (const key of stringFields) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || byteLength(input[key]) > SHORT_TEXT_MAX_BYTES)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.${key}` }));
    }
  }
  return diagnostics;
}

export function validateP2pWorkflowStatusProjection(input: unknown): P2pValidationResult<P2pWorkflowStatusProjection> {
  const diagnostics = validateProjectionLike(input, 'projection');
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { ok: false, diagnostics }
    : { ok: true, value: input as P2pWorkflowStatusProjection, diagnostics };
}

export function validateP2pPersistedWorkflowSnapshot(input: unknown): P2pValidationResult<P2pPersistedWorkflowSnapshot> {
  const diagnostics = validateProjectionLike(input, 'snapshot', true);
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { ok: false, diagnostics }
    : { ok: true, value: input as P2pPersistedWorkflowSnapshot, diagnostics };
}

function validateNodeCombination(node: Partial<P2pWorkflowNodeDraft>, fieldPath: string): P2pWorkflowDiagnostic[] {
  if (!isOneOf(node.nodeKind, P2P_NODE_KINDS) || !isOneOf(node.preset, P2P_PRESET_KEYS)) return [];
  const scope = node.permissionScope ?? 'analysis_only';
  if (!isOneOf(scope, P2P_PERMISSION_SCOPES)) return [];
  const artifacts = Array.isArray(node.artifacts) ? node.artifacts : [];
  const invalid = () => [makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', {
    fieldPath,
    summary: `Invalid nodeKind/preset/permissionScope combination: ${node.nodeKind}/${node.preset}/${scope}.`,
  })];

  if (node.nodeKind === 'logic') {
    return node.preset === 'custom' && scope === 'analysis_only' ? [] : invalid();
  }
  if (node.nodeKind === 'script') {
    return node.preset === 'custom' ? [] : invalid();
  }
  if (node.nodeKind !== 'llm') return [];

  if (node.preset === 'audit' || node.preset === 'proposal_audit' || node.preset === 'implementation_audit') {
    return scope === 'analysis_only' ? [] : invalid();
  }
  if (node.preset === 'openspec_propose') {
    return scope === 'artifact_generation' && artifacts.some((artifact) => isRecord(artifact) && artifact.convention === 'openspec_convention') ? [] : invalid();
  }
  if (node.preset === 'implementation') {
    return scope === 'implementation' ? [] : invalid();
  }
  if (scope === 'analysis_only') return [];
  if (scope === 'artifact_generation') return artifacts.length > 0 ? [] : invalid();
  return invalid();
}

function validateDiscussionOffset(input: unknown, fieldPath: string): P2pWorkflowDiagnostic[] {
  if (!isRecord(input)) return [makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath })];
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!Number.isInteger(input.byteOffset) || (input.byteOffset as number) < 0) {
    diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${fieldPath}.byteOffset` }));
  }
  if (typeof input.sha256Prefix !== 'string' || !/^[a-f0-9]{8,64}$/i.test(input.sha256Prefix)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${fieldPath}.sha256Prefix` }));
  }
  if (!Number.isInteger(input.sizeAtOffset) || (input.sizeAtOffset as number) < 0) {
    diagnostics.push(makeP2pWorkflowDiagnostic('missing_context_source', 'bind', { fieldPath: `${fieldPath}.sizeAtOffset` }));
  }
  return diagnostics;
}

function validateProjectionLike(input: unknown, fieldPath: string, persisted = false): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (!isRecord(input)) return [makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath })];
  if (input.projectionVersion !== P2P_WORKFLOW_PROJECTION_VERSION) {
    diagnostics.push(makeP2pWorkflowDiagnostic('unsupported_schema_version', 'web_validate', { fieldPath: `${fieldPath}.projectionVersion` }));
  }
  for (const key of ['runId', 'workflowId', 'updatedAt'] as const) {
    if (typeof input[key] !== 'string' || input[key] === '') {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.${key}` }));
    }
  }
  if (!['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'stale'].includes(String(input.status))) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.status` }));
  }
  if (input.currentNodeId !== undefined && typeof input.currentNodeId !== 'string') {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.currentNodeId` }));
  }
  if (!Array.isArray(input.completedNodeIds) || input.completedNodeIds.some((id) => typeof id !== 'string' || id === '')) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.completedNodeIds` }));
  }
  if (!Array.isArray(input.diagnostics) || input.diagnostics.some((diagnostic) => !isWorkflowDiagnosticLike(diagnostic))) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_launch_envelope', 'parse', { fieldPath: `${fieldPath}.diagnostics` }));
  }
  if (persisted && (input.capabilitySnapshot !== undefined || input.artifactSummaries !== undefined || input.nodeSummaries !== undefined)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('forbidden_envelope_field', 'parse', { fieldPath }));
  }
  return diagnostics;
}

function isWorkflowDiagnosticLike(input: unknown): boolean {
  return isRecord(input) &&
    typeof input.code === 'string' &&
    (DIAGNOSTIC_CODES.size === 0 || DIAGNOSTIC_CODES.has(input.code)) &&
    typeof input.phase === 'string' &&
    (input.severity === 'info' || input.severity === 'warning' || input.severity === 'error') &&
    typeof input.messageKey === 'string';
}

/** True when a workflow draft, persisted snapshot, or status projection
 *  declares a `schemaVersion` greater than `P2P_WORKFLOW_KNOWN_SCHEMA_MAX`,
 *  or a `projectionVersion` greater than `P2P_WORKFLOW_PROJECTION_VERSION`.
 *
 *  The web v1a UI uses this gate to switch the panel to read-only mode and
 *  block launches: a future-version draft must never be best-effort edited
 *  or compiled by an older client. Returns false for inputs that lack any
 *  recognised version field — those are handled by the regular validators
 *  with `invalid_workflow_graph` / `invalid_launch_envelope` diagnostics. */
export function isFutureWorkflowSchema(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion === 'number' && Number.isFinite(schemaVersion) && schemaVersion > P2P_WORKFLOW_KNOWN_SCHEMA_MAX) {
    return true;
  }
  const workflowSchemaVersion = (input as { workflowSchemaVersion?: unknown }).workflowSchemaVersion;
  if (typeof workflowSchemaVersion === 'number' && Number.isFinite(workflowSchemaVersion) && workflowSchemaVersion > P2P_WORKFLOW_KNOWN_SCHEMA_MAX) {
    return true;
  }
  const projectionVersion = (input as { projectionVersion?: unknown }).projectionVersion;
  if (typeof projectionVersion === 'number' && Number.isFinite(projectionVersion) && projectionVersion > P2P_WORKFLOW_PROJECTION_VERSION) {
    return true;
  }
  // Nested envelope: launch envelopes carry an `advancedDraft` whose own
  // `schemaVersion` may be in the future. Check it but don't recurse further.
  const advancedDraft = (input as { advancedDraft?: unknown }).advancedDraft;
  if (isRecord(advancedDraft)) {
    const draftVersion = (advancedDraft as { schemaVersion?: unknown }).schemaVersion;
    if (typeof draftVersion === 'number' && Number.isFinite(draftVersion) && draftVersion > P2P_WORKFLOW_KNOWN_SCHEMA_MAX) {
      return true;
    }
  }
  return false;
}
