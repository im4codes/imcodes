import {
  OPENSPEC_AUTO_DELIVER_CHANGE_SLUG_MAX_BYTES,
  OPENSPEC_AUTO_DELIVER_COMBO_IDS,
  OPENSPEC_AUTO_DELIVER_COMBO_WRITE_MODES,
  OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE,
  OPENSPEC_AUTO_DELIVER_MUTATION_SCOPES,
  OPENSPEC_AUTO_DELIVER_PRESET_IDS,
  OPENSPEC_AUTO_DELIVER_REQUEST_ID_MAX_BYTES,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
  OPENSPEC_AUTO_DELIVER_STRICT_RESULT_CHANNELS,
  OPENSPEC_AUTO_DELIVER_VERDICTS,
  OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES,
  type OpenSpecAutoDeliverComboId,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverScoreModuleId,
} from './openspec-auto-deliver-constants.js';
import type {
  OpenSpecAutoDeliverComboDescriptor,
  OpenSpecAutoDeliverLaunchRequest,
  OpenSpecAutoDeliverTaskStats,
  OpenSpecAutoDeliverValidationIssue,
  OpenSpecAutoDeliverValidationResult,
  OpenSpecAutoDeliverVerdictPayload,
} from './openspec-auto-deliver-types.js';
import { P2P_PERMISSION_SCOPES } from './p2p-workflow-constants.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function issue(code: string, message: string, path?: string): OpenSpecAutoDeliverValidationIssue {
  return { code, message, path, severity: 'error' };
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

const REQUEST_ID_RE = /^[\x21-\x7e]+$/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;

export function validateOpenSpecAutoDeliverRequestId(value: unknown): OpenSpecAutoDeliverValidationResult<string> {
  if (
    typeof value !== 'string'
    || value.length === 0
    || byteLength(value) > OPENSPEC_AUTO_DELIVER_REQUEST_ID_MAX_BYTES
    || !REQUEST_ID_RE.test(value)
  ) {
    return { ok: false, issues: [issue('invalid_request_id', 'Request id must be visible ASCII and within the byte limit.')] };
  }
  return { ok: true, value, issues: [] };
}

export function validateOpenSpecAutoDeliverChangeSlug(value: unknown): OpenSpecAutoDeliverValidationResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, issues: [issue('invalid_change_slug', 'Change slug must be a string.')] };
  }
  const slug = value.trim();
  const issues: OpenSpecAutoDeliverValidationIssue[] = [];
  if (slug.length === 0) issues.push(issue('empty_change_slug', 'Change slug cannot be empty.'));
  if (byteLength(slug) > OPENSPEC_AUTO_DELIVER_CHANGE_SLUG_MAX_BYTES) issues.push(issue('change_slug_too_large', 'Change slug exceeds byte limit.'));
  if (slug !== value) issues.push(issue('change_slug_whitespace', 'Change slug must not have surrounding whitespace.'));
  if (slug.includes('\0')) issues.push(issue('change_slug_nul', 'Change slug must not contain NUL.'));
  if (slug.includes('/') || slug.includes('\\')) issues.push(issue('change_slug_separator', 'Change slug must not contain path separators.'));
  if (slug === '.' || slug === '..' || slug.includes('..')) issues.push(issue('change_slug_traversal', 'Change slug must not contain traversal segments.'));
  if (slug.startsWith('~')) issues.push(issue('change_slug_home_expansion', 'Change slug must not use home expansion.'));
  if (slug.startsWith('/') || WINDOWS_DRIVE_RE.test(slug) || WINDOWS_UNC_RE.test(slug)) {
    issues.push(issue('change_slug_absolute', 'Change slug must not be an absolute path.'));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: slug, issues: [] };
}

export function parseOpenSpecTasksMarkdown(markdown: string): OpenSpecAutoDeliverTaskStats {
  const items: OpenSpecAutoDeliverTaskStats['items'] = [];
  let inFence = false;
  let fenceMarker: string | null = null;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = null;
      }
      return;
    }
    if (inFence) return;
    const taskMatch = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (!taskMatch) return;
    const checked = taskMatch[1] === 'x' || taskMatch[1] === 'X';
    items.push({
      line: index + 1,
      checked,
      label: (taskMatch[2] ?? '').trim(),
    });
  });
  const checked = items.filter((item) => item.checked).length;
  return {
    total: items.length,
    checked,
    unchecked: items.length - checked,
    items,
  };
}

export function validateOpenSpecAutoDeliverLaunchRequest(input: unknown): OpenSpecAutoDeliverValidationResult<OpenSpecAutoDeliverLaunchRequest> {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('invalid_launch_request', 'Launch request must be an object.')] };
  }
  const issues: OpenSpecAutoDeliverValidationIssue[] = [];
  const requestId = validateOpenSpecAutoDeliverRequestId(input.requestId);
  if (!requestId.ok) issues.push(...requestId.issues.map((entry) => ({ ...entry, path: 'requestId' })));
  const slug = validateOpenSpecAutoDeliverChangeSlug(input.changeName);
  if (!slug.ok) issues.push(...slug.issues.map((entry) => ({ ...entry, path: 'changeName' })));
  if (input.serverId !== undefined && (typeof input.serverId !== 'string' || input.serverId.length === 0)) issues.push(issue('invalid_server_id', 'serverId must be a non-empty string when provided.', 'serverId'));
  if (typeof input.sessionName !== 'string' || input.sessionName.length === 0) issues.push(issue('invalid_session_name', 'sessionName is required.', 'sessionName'));
  if (!isOneOf(input.presetId, OPENSPEC_AUTO_DELIVER_PRESET_IDS)) issues.push(issue('invalid_preset_id', 'presetId is invalid.', 'presetId'));
  if (input.projectName !== undefined && typeof input.projectName !== 'string') issues.push(issue('invalid_project_name', 'projectName must be a string.', 'projectName'));
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      requestId: requestId.ok ? requestId.value : '',
      ...(typeof input.serverId === 'string' ? { serverId: input.serverId } : {}),
      sessionName: input.sessionName as string,
      changeName: slug.ok ? slug.value : '',
      presetId: input.presetId as OpenSpecAutoDeliverPresetId,
      ...(typeof input.projectName === 'string' ? { projectName: input.projectName } : {}),
    },
    issues: [],
  };
}

function validateScore(input: unknown, path: string): OpenSpecAutoDeliverValidationIssue[] {
  const issues: OpenSpecAutoDeliverValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_module_score', 'Module score must be an object.', path)];
  if (!isOneOf(input.module, OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS)) issues.push(issue('invalid_score_module', 'Score module is not canonical.', `${path}.module`));
  if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 10) {
    issues.push(issue('invalid_score_value', 'Score must be a number from 0 through 10.', `${path}.score`));
  }
  if (input.max_score !== 10) issues.push(issue('invalid_max_score', 'max_score must equal 10.', `${path}.max_score`));
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) issues.push(issue('invalid_score_summary', 'Score summary is required.', `${path}.summary`));
  return issues;
}

function validateStringArray(value: unknown, path: string): OpenSpecAutoDeliverValidationIssue[] {
  if (!Array.isArray(value)) return [issue('invalid_string_array', 'Expected an array of strings.', path)];
  return value.flatMap((entry, index) => typeof entry === 'string' ? [] : [issue('invalid_string_array_item', 'Expected a string.', `${path}[${index}]`)]);
}

export function validateOpenSpecAutoDeliverVerdictPayload(input: unknown): OpenSpecAutoDeliverValidationResult<OpenSpecAutoDeliverVerdictPayload> {
  if (!isRecord(input)) return { ok: false, issues: [issue('invalid_verdict_payload', 'Verdict payload must be an object.')] };
  const issues: OpenSpecAutoDeliverValidationIssue[] = [];
  if (!isOneOf(input.verdict, OPENSPEC_AUTO_DELIVER_VERDICTS)) issues.push(issue('invalid_verdict', 'Verdict must be PASS, REWORK, or BLOCKED.', 'verdict'));
  if (!Array.isArray(input.module_scores)) {
    issues.push(issue('invalid_module_scores', 'module_scores must be an array.', 'module_scores'));
  } else {
    const seen = new Set<OpenSpecAutoDeliverScoreModuleId>();
    input.module_scores.forEach((score, index) => {
      issues.push(...validateScore(score, `module_scores[${index}]`));
      if (isRecord(score) && isOneOf(score.module, OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS)) {
        if (seen.has(score.module)) issues.push(issue('duplicate_score_module', 'Score module appears more than once.', `module_scores[${index}].module`));
        seen.add(score.module);
      }
    });
    for (const moduleId of OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS) {
      if (!seen.has(moduleId)) issues.push(issue('missing_score_module', `Missing score module: ${moduleId}.`, 'module_scores'));
    }
  }
  issues.push(...validateStringArray(input.unchecked_tasks, 'unchecked_tasks'));
  issues.push(...validateStringArray(input.required_changes, 'required_changes'));
  if (!Array.isArray(input.repairs_applied)) {
    issues.push(issue('invalid_repairs_applied', 'repairs_applied must be an array.', 'repairs_applied'));
  } else {
    input.repairs_applied.forEach((repair, index) => {
      if (!isRecord(repair)) {
        issues.push(issue('invalid_repair_summary', 'Repair summary must be an object.', `repairs_applied[${index}]`));
        return;
      }
      issues.push(...validateStringArray(repair.files, `repairs_applied[${index}].files`));
      if (typeof repair.reason !== 'string' || repair.reason.trim().length === 0) {
        issues.push(issue('invalid_repair_reason', 'Repair reason is required.', `repairs_applied[${index}].reason`));
      }
    });
  }
  if (!Array.isArray(input.evidence)) {
    issues.push(issue('invalid_evidence', 'evidence must be an array.', 'evidence'));
  } else {
    input.evidence.forEach((entry, index) => {
      if (!isRecord(entry)) {
        issues.push(issue('invalid_evidence_entry', 'Evidence entry must be an object.', `evidence[${index}]`));
        return;
      }
      if (!isOneOf(entry.source, OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE)) {
        issues.push(issue('invalid_evidence_source', 'Evidence source is invalid.', `evidence[${index}].source`));
      }
      if (typeof entry.summary !== 'string' || entry.summary.trim().length === 0) {
        issues.push(issue('invalid_evidence_summary', 'Evidence summary is required.', `evidence[${index}].summary`));
      }
      if (entry.command !== undefined && typeof entry.command !== 'string') issues.push(issue('invalid_evidence_command', 'Evidence command must be a string.', `evidence[${index}].command`));
      if (entry.exitCode !== undefined && (typeof entry.exitCode !== 'number' || !Number.isFinite(entry.exitCode))) issues.push(issue('invalid_evidence_exit_code', 'Evidence exitCode must be a number.', `evidence[${index}].exitCode`));
    });
  }
  if (
    input.verdict === 'PASS'
    && (
      (Array.isArray(input.unchecked_tasks) && input.unchecked_tasks.length > 0)
      || (Array.isArray(input.required_changes) && input.required_changes.length > 0)
    )
  ) {
    issues.push(issue('contradictory_pass_payload', 'PASS cannot include unchecked tasks or required changes.'));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as OpenSpecAutoDeliverVerdictPayload, issues: [] };
}

export function parseOpenSpecAutoDeliverAuthoritativeJsonPayload(text: string): OpenSpecAutoDeliverValidationResult<unknown> {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length !== 1) {
    return { ok: false, issues: [issue(matches.length === 0 ? 'missing_authoritative_json' : 'multiple_authoritative_json', 'Expected exactly one authoritative JSON fence.')] };
  }
  const payload = matches[0]?.[1] ?? '';
  if (byteLength(payload) > OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES) {
    return { ok: false, issues: [issue('authoritative_payload_too_large', 'Authoritative result payload exceeds byte limit.')] };
  }
  try {
    return { ok: true, value: JSON.parse(payload), issues: [] };
  } catch {
    return { ok: false, issues: [issue('malformed_authoritative_json', 'Authoritative JSON is malformed.')] };
  }
}

export function validateOpenSpecAutoDeliverComboDescriptor(input: unknown): OpenSpecAutoDeliverValidationResult<OpenSpecAutoDeliverComboDescriptor> {
  if (!isRecord(input)) return { ok: false, issues: [issue('invalid_combo_descriptor', 'Combo descriptor must be an object.')] };
  const issues: OpenSpecAutoDeliverValidationIssue[] = [];
  const comboIds = Object.values(OPENSPEC_AUTO_DELIVER_COMBO_IDS) as OpenSpecAutoDeliverComboId[];
  if (!isOneOf(input.id, comboIds)) issues.push(issue('invalid_combo_id', 'Combo id is not canonical.', 'id'));
  if (typeof input.title !== 'string' || input.title.trim().length === 0) issues.push(issue('invalid_combo_title', 'Combo title is required.', 'title'));
  if (!isRecord(input.capability)) {
    issues.push(issue('invalid_combo_capability', 'Combo capability is required.', 'capability'));
  } else {
    if (!isOneOf(input.capability.stage, ['spec_audit_repair', 'implementation_audit_repair'] as const)) issues.push(issue('invalid_combo_stage', 'Combo stage is invalid.', 'capability.stage'));
    if (!isOneOf(input.capability.requiredPermissionScope, P2P_PERMISSION_SCOPES)) issues.push(issue('invalid_combo_permission_scope', 'Combo permission scope is invalid.', 'capability.requiredPermissionScope'));
    if (!Array.isArray(input.capability.allowedMutationScopes) || input.capability.allowedMutationScopes.some((scope) => !isOneOf(scope, OPENSPEC_AUTO_DELIVER_MUTATION_SCOPES))) {
      issues.push(issue('invalid_combo_mutation_scope', 'Combo mutation scopes are invalid.', 'capability.allowedMutationScopes'));
    }
    if (!isOneOf(input.capability.writeMode, OPENSPEC_AUTO_DELIVER_COMBO_WRITE_MODES)) issues.push(issue('invalid_combo_write_mode', 'Combo write mode is invalid.', 'capability.writeMode'));
    if (!isOneOf(input.capability.strictResultChannel, OPENSPEC_AUTO_DELIVER_STRICT_RESULT_CHANNELS)) issues.push(issue('invalid_combo_result_channel', 'Combo strict result channel is invalid.', 'capability.strictResultChannel'));
    if (typeof input.capability.minTransportParticipants !== 'number' || input.capability.minTransportParticipants < 1) issues.push(issue('invalid_combo_min_participants', 'Combo min participants must be at least one.', 'capability.minTransportParticipants'));
    if (input.capability.supportsGenerationMetadata !== true) issues.push(issue('combo_missing_generation_metadata', 'Combo must support generation metadata.', 'capability.supportsGenerationMetadata'));
    if (input.capability.supportsStopCancellation !== true) issues.push(issue('combo_missing_stop_cancellation', 'Combo must support stop/cancel.', 'capability.supportsStopCancellation'));
    if (input.capability.stage === 'spec_audit_repair' && input.capability.requiredPermissionScope === 'analysis_only') {
      issues.push(issue('spec_combo_analysis_only', 'Spec audit-repair combo cannot be analysis-only.', 'capability.requiredPermissionScope'));
    }
    if (input.capability.stage === 'implementation_audit_repair' && input.capability.requiredPermissionScope === 'analysis_only') {
      issues.push(issue('implementation_combo_analysis_only', 'Implementation audit-repair combo cannot be analysis-only.', 'capability.requiredPermissionScope'));
    }
  }
  if (!Array.isArray(input.rounds) || input.rounds.length === 0) issues.push(issue('invalid_combo_rounds', 'Combo rounds are required.', 'rounds'));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as OpenSpecAutoDeliverComboDescriptor, issues: [] };
}
