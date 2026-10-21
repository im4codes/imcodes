import { describe, expect, it } from 'vitest';
import {
  SESSION_SYSTEM_CONTRACT_VERSION,
  sessionSystemContractKey,
  shouldInjectSessionSystemContract,
} from '../../src/agent/session-system-contract.js';

describe('session system contract persistence', () => {
  it('uses a stable versioned hash and treats whitespace-only changes as unchanged', () => {
    const first = sessionSystemContractKey('IM.codes contract v1');
    expect(first).toMatch(new RegExp(`^imcodes-session-contract:v${SESSION_SYSTEM_CONTRACT_VERSION}:[0-9a-f]{64}$`));
    expect(sessionSystemContractKey('  IM.codes contract v1  ')).toBe(first);
    expect(sessionSystemContractKey('IM.codes contract v2')).not.toBe(first);
  });

  it('re-injects only when a non-empty contract is new or changed', () => {
    const first = sessionSystemContractKey('contract');
    expect(shouldInjectSessionSystemContract(undefined, 'contract')).toBe(true);
    expect(shouldInjectSessionSystemContract(first, 'contract')).toBe(false);
    expect(shouldInjectSessionSystemContract(first, 'changed contract')).toBe(true);
    expect(shouldInjectSessionSystemContract(first, '   ')).toBe(false);
    expect(shouldInjectSessionSystemContract(undefined, undefined)).toBe(false);
  });
});
