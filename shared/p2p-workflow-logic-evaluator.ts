/**
 * P2P logic-node evaluator.
 *
 * R3 v1b follow-up — pure, sandboxed evaluation of `P2pLogicNodeContract`
 * rules against the run's variable state. The evaluator is deliberately
 * tiny:
 *   - No expression interpreter, no `eval`, no template strings.
 *   - Rules are checked in declaration order; the first match wins.
 *   - `if: undefined` is an always-match rule.
 *   - When no rule matches, `default` is emitted.
 *
 * The shared evaluator is consumed both by the daemon executor (to drive
 * `logic_marker_equals` routing) and by the compiler validator (to reject
 * obviously-broken contracts at author time).
 */

import type {
  P2pLogicNodeContract,
  P2pLogicRule,
  P2pWorkflowVariableValue,
} from './p2p-workflow-types.js';

export const P2P_LOGIC_MAX_RULES = 32;
export const P2P_LOGIC_MAX_MARKER_BYTES = 128;
export const P2P_LOGIC_VISIBLE_ASCII = /^[\x21-\x7e]+$/;

export interface LogicEvalResult {
  /** Marker emitted (matched rule's `emit` or `contract.default`). */
  marker: string;
  /** Index of the matched rule, or -1 when fell through to `default`. */
  matchedRuleIndex: number;
}

export type LogicVariableSnapshot = Record<string, P2pWorkflowVariableValue | undefined>;

/**
 * Evaluate the contract against the given variables snapshot. Throws only
 * when `contract` is structurally invalid (caller should validate ahead of
 * time via {@link validateP2pLogicContract}).
 */
export function evaluateP2pLogic(
  contract: P2pLogicNodeContract,
  variables: LogicVariableSnapshot,
): LogicEvalResult {
  for (let index = 0; index < contract.rules.length; index += 1) {
    const rule = contract.rules[index];
    if (matchRule(rule, variables)) {
      return { marker: rule.emit, matchedRuleIndex: index };
    }
  }
  return { marker: contract.default, matchedRuleIndex: -1 };
}

/**
 * R3 v2 PR-ζ (B6 / A5 defence-in-depth) — Reject prototype-pollution
 * key names at evaluator read time. Logic identifier validator already
 * uses `[A-Za-z_][A-Za-z0-9_]*` which would let `__proto__` pass; this
 * extra check ensures the read silently mismatches even if a hostile
 * contract slips past compile-time validation.
 */
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function matchRule(rule: P2pLogicRule, variables: LogicVariableSnapshot): boolean {
  if (rule.if === undefined) return true;
  if (PROTOTYPE_POLLUTION_KEYS.has(rule.if.name)) return false;
  const value = variables[rule.if.name];
  if (rule.if.kind === 'variable_present') {
    return value !== undefined && value !== null;
  }
  if (rule.if.kind === 'variable_truthy') {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.length > 0;
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.length > 0;
    return false;
  }
  if (rule.if.kind === 'variable_equals') {
    if (value === undefined || value === null) return false;
    return stringifyVariable(value) === rule.if.equals;
  }
  return false;
}

/**
 * R3 v2 PR-ζ (M5 / ζ-13) — Stable, injection-safe stringification.
 * Previously `Array.isArray(value) ? value.join(',') : ...` allowed
 * `['a,b']` and `['a','b']` to compare equal under `variable_equals`.
 * `JSON.stringify` is unambiguous and the canonical encoding the
 * compiler/parser already use elsewhere.
 */
function stringifyVariable(value: P2pWorkflowVariableValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return JSON.stringify(value);
  return '';
}

export interface LogicValidationDiagnostic {
  fieldPath: string;
  summary: string;
}

/**
 * Pure structural validation for a logic contract. Returns an array of
 * diagnostics; an empty array means the contract is valid. The compiler
 * wraps these into `invalid_logic_contract` workflow diagnostics.
 */
export function validateP2pLogicContract(contract: unknown, basePath = 'logic'): LogicValidationDiagnostic[] {
  const diagnostics: LogicValidationDiagnostic[] = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    diagnostics.push({ fieldPath: basePath, summary: 'Logic contract must be an object.' });
    return diagnostics;
  }
  const obj = contract as Record<string, unknown>;
  if (!Array.isArray(obj.rules)) {
    diagnostics.push({ fieldPath: `${basePath}.rules`, summary: 'rules must be an array.' });
    return diagnostics;
  }
  if (obj.rules.length > P2P_LOGIC_MAX_RULES) {
    diagnostics.push({ fieldPath: `${basePath}.rules`, summary: `Logic node may declare at most ${P2P_LOGIC_MAX_RULES} rules.` });
  }
  if (typeof obj.default !== 'string' || !isValidMarker(obj.default)) {
    diagnostics.push({ fieldPath: `${basePath}.default`, summary: `default marker must be visible-ASCII (1–${P2P_LOGIC_MAX_MARKER_BYTES} bytes).` });
  }
  obj.rules.forEach((rule, index) => {
    diagnostics.push(...validateRule(rule, `${basePath}.rules[${index}]`));
  });
  return diagnostics;
}

function validateRule(rule: unknown, path: string): LogicValidationDiagnostic[] {
  const diagnostics: LogicValidationDiagnostic[] = [];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    diagnostics.push({ fieldPath: path, summary: 'Rule must be an object.' });
    return diagnostics;
  }
  const obj = rule as Record<string, unknown>;
  if (typeof obj.emit !== 'string' || !isValidMarker(obj.emit)) {
    diagnostics.push({ fieldPath: `${path}.emit`, summary: `emit must be visible-ASCII (1–${P2P_LOGIC_MAX_MARKER_BYTES} bytes).` });
  }
  if (obj.if === undefined) return diagnostics;
  if (!obj.if || typeof obj.if !== 'object' || Array.isArray(obj.if)) {
    diagnostics.push({ fieldPath: `${path}.if`, summary: 'if clause must be an object when present.' });
    return diagnostics;
  }
  const cond = obj.if as Record<string, unknown>;
  if (cond.kind !== 'variable_equals' && cond.kind !== 'variable_present' && cond.kind !== 'variable_truthy') {
    diagnostics.push({ fieldPath: `${path}.if.kind`, summary: `Unsupported condition kind: ${String(cond.kind)}.` });
    return diagnostics;
  }
  if (
    typeof cond.name !== 'string'
    || cond.name.length === 0
    || cond.name.length > 64
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cond.name)
    // R3 v2 PR-ζ (B6 / A5) — Block prototype-pollution key names at
    // compile time. Defence-in-depth alongside evaluator read-time skip
    // and orchestrator write-path lowercase regex.
    || PROTOTYPE_POLLUTION_KEYS.has(cond.name)
  ) {
    diagnostics.push({ fieldPath: `${path}.if.name`, summary: 'name must be a non-empty identifier (≤64 chars, [A-Za-z_][A-Za-z0-9_]*) and not a prototype-pollution key.' });
  }
  if (cond.kind === 'variable_equals') {
    if (typeof cond.equals !== 'string' || cond.equals.length > P2P_LOGIC_MAX_MARKER_BYTES) {
      diagnostics.push({ fieldPath: `${path}.if.equals`, summary: `equals must be a string ≤${P2P_LOGIC_MAX_MARKER_BYTES} bytes.` });
    }
  }
  return diagnostics;
}

function isValidMarker(value: string): boolean {
  if (value.length === 0 || value.length > P2P_LOGIC_MAX_MARKER_BYTES) return false;
  return P2P_LOGIC_VISIBLE_ASCII.test(value);
}
