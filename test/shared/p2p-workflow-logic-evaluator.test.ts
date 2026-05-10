/**
 * R3 v1b follow-up — Logic node evaluator unit tests.
 *
 * Exercises {@link evaluateP2pLogic} (deterministic rule selection +
 * default fallback) and {@link validateP2pLogicContract} (compile-time
 * shape enforcement). The compiler integration test in
 * `test/shared/p2p-workflow-compiler.test.ts` covers the wiring; this
 * file pins the evaluator semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  P2P_LOGIC_MAX_RULES,
  P2P_LOGIC_MAX_MARKER_BYTES,
  evaluateP2pLogic,
  validateP2pLogicContract,
} from '../../shared/p2p-workflow-logic-evaluator.js';
import type { P2pLogicNodeContract } from '../../shared/p2p-workflow-types.js';

describe('evaluateP2pLogic', () => {
  it('returns default when there are no rules', () => {
    const result = evaluateP2pLogic({ rules: [], default: 'fallback' }, {});
    expect(result.marker).toBe('fallback');
    expect(result.matchedRuleIndex).toBe(-1);
  });

  it('returns the first always-match rule (if: undefined) before later rules', () => {
    const contract: P2pLogicNodeContract = {
      rules: [
        { emit: 'first' },
        { if: { kind: 'variable_equals', name: 'x', equals: '1' }, emit: 'second' },
      ],
      default: 'never',
    };
    const result = evaluateP2pLogic(contract, { x: '1' });
    expect(result.marker).toBe('first');
    expect(result.matchedRuleIndex).toBe(0);
  });

  it('matches variable_equals against stringified value (number → string coercion)', () => {
    const contract: P2pLogicNodeContract = {
      rules: [{ if: { kind: 'variable_equals', name: 'count', equals: '3' }, emit: 'three' }],
      default: 'other',
    };
    expect(evaluateP2pLogic(contract, { count: 3 }).marker).toBe('three');
    expect(evaluateP2pLogic(contract, { count: 4 }).marker).toBe('other');
  });

  it('matches variable_equals on string array via JSON encoding (R3 v2 PR-ζ M5)', () => {
    // Updated for PR-ζ ζ-13: array stringification switched from
    // ambiguous `value.join(',')` to canonical `JSON.stringify(value)`
    // so `['a','b']` and `['a,b']` no longer collide.
    const contract: P2pLogicNodeContract = {
      rules: [{ if: { kind: 'variable_equals', name: 'tags', equals: '["a","b"]' }, emit: 'pair' }],
      default: 'no',
    };
    expect(evaluateP2pLogic(contract, { tags: ['a', 'b'] }).marker).toBe('pair');
    // Inverse — the comma-joined ambiguous form NO LONGER matches.
    expect(evaluateP2pLogic({ ...contract, rules: [{ if: { kind: 'variable_equals', name: 'tags', equals: 'a,b' }, emit: 'pair' }] }, { tags: ['a', 'b'] }).marker).toBe('no');
    // And `['a,b']` no longer collides with `['a','b']`.
    expect(evaluateP2pLogic(contract, { tags: ['a,b'] }).marker).toBe('no');
  });

  it('variable_present returns true for empty string but false for undefined / null', () => {
    const contract: P2pLogicNodeContract = {
      rules: [{ if: { kind: 'variable_present', name: 'maybe' }, emit: 'present' }],
      default: 'absent',
    };
    expect(evaluateP2pLogic(contract, { maybe: '' }).marker).toBe('present');
    expect(evaluateP2pLogic(contract, { maybe: undefined }).marker).toBe('absent');
    expect(evaluateP2pLogic(contract, {}).marker).toBe('absent');
  });

  it('variable_truthy follows the documented JS-truthy semantics', () => {
    const contract: P2pLogicNodeContract = {
      rules: [{ if: { kind: 'variable_truthy', name: 'v' }, emit: 'yes' }],
      default: 'no',
    };
    expect(evaluateP2pLogic(contract, { v: 'hello' }).marker).toBe('yes');
    expect(evaluateP2pLogic(contract, { v: '' }).marker).toBe('no');
    expect(evaluateP2pLogic(contract, { v: 1 }).marker).toBe('yes');
    expect(evaluateP2pLogic(contract, { v: 0 }).marker).toBe('no');
    expect(evaluateP2pLogic(contract, { v: true }).marker).toBe('yes');
    expect(evaluateP2pLogic(contract, { v: false }).marker).toBe('no');
    expect(evaluateP2pLogic(contract, { v: ['x'] }).marker).toBe('yes');
    expect(evaluateP2pLogic(contract, { v: [] }).marker).toBe('no');
  });

  it('falls through to default when no rule matches', () => {
    const contract: P2pLogicNodeContract = {
      rules: [
        { if: { kind: 'variable_equals', name: 'x', equals: '1' }, emit: 'one' },
        { if: { kind: 'variable_equals', name: 'x', equals: '2' }, emit: 'two' },
      ],
      default: 'other',
    };
    expect(evaluateP2pLogic(contract, { x: '3' }).marker).toBe('other');
  });
});

describe('validateP2pLogicContract', () => {
  it('accepts a minimal valid contract', () => {
    expect(validateP2pLogicContract({ rules: [], default: 'fallback' })).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateP2pLogicContract('not an object')).toContainEqual(
      expect.objectContaining({ fieldPath: 'logic' }),
    );
  });

  it('rejects non-array rules', () => {
    expect(validateP2pLogicContract({ rules: 'oops', default: 'x' })).toContainEqual(
      expect.objectContaining({ fieldPath: 'logic.rules' }),
    );
  });

  it('rejects > P2P_LOGIC_MAX_RULES rules', () => {
    const rules = Array.from({ length: P2P_LOGIC_MAX_RULES + 1 }, (_, i) => ({ emit: `marker-${i}` }));
    const diagnostics = validateP2pLogicContract({ rules, default: 'd' });
    expect(diagnostics).toContainEqual(expect.objectContaining({ fieldPath: 'logic.rules' }));
  });

  it('rejects empty default marker', () => {
    expect(validateP2pLogicContract({ rules: [], default: '' })).toContainEqual(
      expect.objectContaining({ fieldPath: 'logic.default' }),
    );
  });

  it('rejects multi-byte default marker (visible-ASCII only)', () => {
    expect(validateP2pLogicContract({ rules: [], default: '中文' })).toContainEqual(
      expect.objectContaining({ fieldPath: 'logic.default' }),
    );
  });

  it('rejects oversize default marker', () => {
    const huge = 'x'.repeat(P2P_LOGIC_MAX_MARKER_BYTES + 1);
    expect(validateP2pLogicContract({ rules: [], default: huge })).toContainEqual(
      expect.objectContaining({ fieldPath: 'logic.default' }),
    );
  });

  it('rejects rule with non-identifier variable name', () => {
    const diagnostics = validateP2pLogicContract({
      rules: [{ if: { kind: 'variable_equals', name: '1bad', equals: 'a' }, emit: 'x' }],
      default: 'd',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ fieldPath: 'logic.rules[0].if.name' }));
  });

  it('rejects unsupported condition kind', () => {
    const diagnostics = validateP2pLogicContract({
      rules: [{ if: { kind: 'eval', name: 'x' }, emit: 'x' }],
      default: 'd',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ fieldPath: 'logic.rules[0].if.kind' }));
  });

  it('rejects rule with empty emit', () => {
    const diagnostics = validateP2pLogicContract({
      rules: [{ emit: '' }],
      default: 'd',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ fieldPath: 'logic.rules[0].emit' }));
  });
});
