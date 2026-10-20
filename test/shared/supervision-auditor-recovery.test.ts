import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_AUDITOR_RECOVERY_REFUSALS as REFUSALS,
  evaluateSupervisionAuditorRecoveryRouting,
  isSupervisionAuditorRecoveryRoutingConsistent,
} from '../../shared/supervision-auditor-recovery.js';

const UNAVAILABLE = { available: false as const, degradedReason: 'no_cross_vendor_configured' as const };

describe('orphaned auditor recovery routing policy', () => {
  it('admits a cross-vendor target under every policy, a task without one included', () => {
    for (const auditPolicy of ['auto_allow_degraded', 'auto_strict_cross_vendor', undefined, 'manual']) {
      expect(evaluateSupervisionAuditorRecoveryRouting({
        auditPolicy, auditedProviderFamily: 'anthropic', targetProviderFamily: 'openai',
      })).toEqual({ ok: true, auditRoutingReason: 'cross_vendor_preferred' });
    }
  });

  it('never admits a same-family target for a strict task, even with no cross-vendor available', () => {
    expect(evaluateSupervisionAuditorRecoveryRouting({
      auditPolicy: 'auto_strict_cross_vendor',
      auditedProviderFamily: 'anthropic',
      targetProviderFamily: 'anthropic',
      crossVendor: UNAVAILABLE,
    })).toEqual({ ok: false, refusal: REFUSALS.STRICT_CROSS_VENDOR_REQUIRED });
  });

  it('degrades to a same-family target only when no cross-vendor target is usable, stating why', () => {
    expect(evaluateSupervisionAuditorRecoveryRouting({
      auditPolicy: 'auto_allow_degraded',
      auditedProviderFamily: 'anthropic',
      targetProviderFamily: 'anthropic',
      crossVendor: UNAVAILABLE,
    })).toEqual({
      ok: true,
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: 'no_cross_vendor_configured',
    });
    expect(evaluateSupervisionAuditorRecoveryRouting({
      auditPolicy: 'auto_allow_degraded',
      auditedProviderFamily: 'anthropic',
      targetProviderFamily: 'anthropic',
      crossVendor: { available: true },
    })).toEqual({ ok: false, refusal: REFUSALS.CROSS_VENDOR_TARGET_AVAILABLE });
  });

  it('refuses a degradation it cannot justify, and an unknown policy', () => {
    const sameFamily = { auditedProviderFamily: 'anthropic', targetProviderFamily: 'anthropic' };
    expect(evaluateSupervisionAuditorRecoveryRouting({ auditPolicy: 'auto_allow_degraded', ...sameFamily }))
      .toEqual({ ok: false, refusal: REFUSALS.CROSS_VENDOR_AVAILABILITY_UNKNOWN });
    expect(evaluateSupervisionAuditorRecoveryRouting({
      auditPolicy: 'auto_allow_degraded',
      ...sameFamily,
      crossVendor: { available: false, degradedReason: 'made_up' } as never,
    })).toEqual({ ok: false, refusal: REFUSALS.CROSS_VENDOR_AVAILABILITY_UNKNOWN });
    // Only auto_allow_degraded may degrade: no policy, or an unknown one, never does.
    for (const auditPolicy of [undefined, 'manual', '']) {
      expect(evaluateSupervisionAuditorRecoveryRouting({ auditPolicy, ...sameFamily, crossVendor: UNAVAILABLE }))
        .toEqual({ ok: false, refusal: REFUSALS.AUDIT_POLICY_UNSUPPORTED });
    }
  });

  it('lets the registry re-check every routing statement the durable record can prove', () => {
    const consistent = (auditPolicy: string, targetProviderFamily: string, routing: Record<string, unknown>) => (
      isSupervisionAuditorRecoveryRoutingConsistent({
        auditPolicy, auditedProviderFamily: 'anthropic', targetProviderFamily, routing,
      })
    );
    expect(consistent('auto_strict_cross_vendor', 'openai', { auditRoutingReason: 'cross_vendor_preferred' })).toBe(true);
    expect(consistent('auto_allow_degraded', 'openai', { auditRoutingReason: 'cross_vendor_preferred' })).toBe(true);
    expect(consistent('auto_allow_degraded', 'anthropic', {
      auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'cross_vendor_offline',
    })).toBe(true);

    // A forged degraded statement never makes a strict same-family rebind legal.
    expect(consistent('auto_strict_cross_vendor', 'anthropic', {
      auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'cross_vendor_offline',
    })).toBe(false);
    // A degradation must name its reason, and a cross-vendor rebind must not carry one.
    expect(consistent('auto_allow_degraded', 'anthropic', { auditRoutingReason: 'same_family_degraded' })).toBe(false);
    expect(consistent('auto_allow_degraded', 'anthropic', { auditRoutingReason: 'cross_vendor_preferred' })).toBe(false);
    expect(consistent('auto_allow_degraded', 'openai', {
      auditRoutingReason: 'cross_vendor_preferred', auditDegradedReason: 'cross_vendor_offline',
    })).toBe(false);
    expect(consistent('auto_allow_degraded', 'openai', { auditRoutingReason: 'same_family_degraded' })).toBe(false);
    // A task without an automatic policy keeps cross-vendor recovery, and never degrades.
    expect(consistent('unknown', 'openai', { auditRoutingReason: 'cross_vendor_preferred' })).toBe(true);
    expect(consistent('unknown', 'anthropic', {
      auditRoutingReason: 'same_family_degraded', auditDegradedReason: 'cross_vendor_offline',
    })).toBe(false);
  });
});
