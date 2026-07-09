import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { buildAliasSendAudit } from '../../src/daemon/alias-audit.js';

// RV-C: the audit anchor records WHICH aliases a send referenced and a hash of
// their resolved values — so "what did `;;(name)` actually deliver to the agent"
// is auditable — WITHOUT ever persisting or emitting the plaintext value.
describe('buildAliasSendAudit (RV-C alias send audit anchor)', () => {
  it('returns the referenced names (first-occurrence order) and a hex sha256', () => {
    const audit = buildAliasSendAudit('deploy ;;(host) as ;;(user)', {
      host: 'prod.example.com',
      user: 'deployer',
    });
    expect(audit).toBeDefined();
    expect(audit?.names).toEqual(['host', 'user']);
    expect(audit?.resolvedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a STABLE hash for the same names+values regardless of marker/map order', () => {
    const a = buildAliasSendAudit('a ;;(x) b ;;(y)', { x: 'X-VALUE', y: 'Y-VALUE' });
    // Different marker order in the text and different key order in the map.
    const b = buildAliasSendAudit('a ;;(y) b ;;(x)', { y: 'Y-VALUE', x: 'X-VALUE' });
    expect(a?.resolvedHash).toBe(b?.resolvedHash);
    // The value-order-independent hash still records per-text reference order in `names`.
    expect(a?.names).toEqual(['x', 'y']);
    expect(b?.names).toEqual(['y', 'x']);
  });

  it('hashes the canonical sorted {name: value} map (never the plaintext)', () => {
    const value = 'super-secret-value';
    const audit = buildAliasSendAudit('run ;;(token)', { token: value });
    const expected = createHash('sha256')
      .update(JSON.stringify({ token: value }), 'utf8')
      .digest('hex');
    expect(audit?.resolvedHash).toBe(expected);
    // The hash is not the plaintext value in any form.
    expect(audit?.resolvedHash).not.toContain(value);
    // And the audit object as a whole must not carry the plaintext value anywhere.
    expect(JSON.stringify(audit)).not.toContain(value);
  });

  it('changes the hash when a resolved value changes (tamper/injection is detectable)', () => {
    const before = buildAliasSendAudit('use ;;(host)', { host: 'prod.example.com' });
    const after = buildAliasSendAudit('use ;;(host)', { host: 'evil.example.com' });
    expect(before?.resolvedHash).not.toBe(after?.resolvedHash);
    expect(before?.names).toEqual(after?.names); // same reference, different value
  });

  it('only hashes the REFERENCED names — unrelated aliases in the map do not affect the hash', () => {
    const referenced = buildAliasSendAudit('ping ;;(host)', { host: 'prod.example.com' });
    const withExtra = buildAliasSendAudit('ping ;;(host)', {
      host: 'prod.example.com',
      unrelated: 'other-secret',
    });
    expect(referenced?.resolvedHash).toBe(withExtra?.resolvedHash);
    expect(withExtra?.names).toEqual(['host']);
  });

  it('returns undefined when there are no markers', () => {
    expect(buildAliasSendAudit('plain message, no markers', { host: 'x' })).toBeUndefined();
  });

  it('returns undefined when markers exist but none are resolved', () => {
    expect(buildAliasSendAudit('deploy ;;(host) now', {})).toBeUndefined();
    expect(buildAliasSendAudit('deploy ;;(host) now', { other: 'x' })).toBeUndefined();
  });

  it('anchors only the resolved subset when some referenced markers are unresolved', () => {
    const audit = buildAliasSendAudit('deploy ;;(host) as ;;(user)', { host: 'prod.example.com' });
    expect(audit?.names).toEqual(['host']);
    const expected = createHash('sha256')
      .update(JSON.stringify({ host: 'prod.example.com' }), 'utf8')
      .digest('hex');
    expect(audit?.resolvedHash).toBe(expected);
  });

  it('deduplicates repeated markers (a name appears once in the anchor)', () => {
    const audit = buildAliasSendAudit(';;(host) then ;;(host) again', { host: 'prod.example.com' });
    expect(audit?.names).toEqual(['host']);
  });
});
