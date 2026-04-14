import { describe, expect, it } from 'vitest';
import { getSharedContextCutoverFlags, legacyInjectionDisabled } from '../../src/context/shared-context-flags.js';

describe('shared-context cutover flags', () => {
  it('defaults cutover flags to enabled while keeping legacy injection enabled until explicitly disabled', () => {
    const flags = getSharedContextCutoverFlags({});
    expect(flags).toMatchObject({
      identityShadow: true,
      localStaging: true,
      materialization: true,
      remoteReplication: true,
      controlPlane: true,
      runtimeSend: true,
      legacyInjectionDisabled: false,
      shadowDiagnostics: false,
    });
  });

  it('parses explicit boolean env overrides', () => {
    const flags = getSharedContextCutoverFlags({
      IMCODES_SHARED_CONTEXT_RUNTIME_SEND: 'false',
      IMCODES_SHARED_CONTEXT_SHADOW_DIAGNOSTICS: 'true',
      IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED: '1',
    });
    expect(flags.runtimeSend).toBe(false);
    expect(flags.shadowDiagnostics).toBe(true);
    expect(flags.legacyInjectionDisabled).toBe(true);
    expect(legacyInjectionDisabled({
      IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED: 'yes',
    })).toBe(true);
  });
});
