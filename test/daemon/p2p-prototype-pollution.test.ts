/**
 * R3 v2 PR-ζ — Prototype-pollution + variable-cap regression tests.
 *
 * Pins the runtime semantics of the orchestrator's variable write path
 * (defence-in-depth alongside the parser's regex / size caps and the
 * compile-time logic identifier validator).
 */
import { describe, expect, it } from 'vitest';
import {
  P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS,
  P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES,
  P2P_WORKFLOW_VARIABLE_NAME_PATTERN,
} from '../../shared/p2p-workflow-constants.js';
import {
  evaluateP2pLogic,
  validateP2pLogicContract,
} from '../../shared/p2p-workflow-logic-evaluator.js';

describe('P2P workflow variable name pattern (R3 v2 PR-ζ ζ-2)', () => {
  it('matches lowercase identifiers up to 64 chars', () => {
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('verdict')).toBe(true);
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('round_count')).toBe(true);
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('a')).toBe(true);
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('a'.repeat(64))).toBe(true);
  });

  it('rejects prototype-pollution names', () => {
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('__proto__')).toBe(false);
    // `constructor` starts with lowercase letter so it WOULD match the
    // base pattern — but the orchestrator and logic evaluator reject it
    // explicitly via a deny-set. We document here that the pattern alone
    // cannot rule it out.
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('constructor')).toBe(true);
  });

  it('rejects uppercase, leading digit, and over-length names', () => {
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('Verdict')).toBe(false);
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('1tag')).toBe(false);
    expect(P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test('a'.repeat(65))).toBe(false);
  });

  it('exposes the documented array caps', () => {
    expect(P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS).toBe(64);
    expect(P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES).toBe(8 * 1024);
  });
});

describe('Logic evaluator prototype-key defence (R3 v2 PR-ζ ζ-12)', () => {
  it('compile-time validator rejects __proto__ / constructor / prototype', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const diags = validateP2pLogicContract({
        rules: [{ if: { kind: 'variable_equals', name: bad, equals: 'x' }, emit: 'go' }],
        default: 'no',
      });
      expect(diags.find((d) => d.fieldPath.endsWith('.if.name'))).toBeDefined();
    }
  });

  it('runtime evaluator returns false for prototype-key reads even if a hostile contract slips past validation', () => {
    // Bypass the validator and feed a hostile contract directly.
    const hostile = {
      rules: [{ if: { kind: 'variable_equals' as const, name: '__proto__', equals: '[object Object]' }, emit: 'pollute' }],
      default: 'safe',
    };
    const result = evaluateP2pLogic(hostile, {});
    expect(result.marker).toBe('safe');
    expect(result.matchedRuleIndex).toBe(-1);
  });
});

describe('Logic evaluator stable array stringification (R3 v2 PR-ζ ζ-13)', () => {
  it('canonical JSON encoding distinguishes ["a","b"] from ["a,b"]', () => {
    const contract = {
      rules: [{ if: { kind: 'variable_equals' as const, name: 'tags', equals: '["a","b"]' }, emit: 'pair' }],
      default: 'no',
    };
    expect(evaluateP2pLogic(contract, { tags: ['a', 'b'] }).marker).toBe('pair');
    expect(evaluateP2pLogic(contract, { tags: ['a,b'] }).marker).toBe('no');
  });
});
