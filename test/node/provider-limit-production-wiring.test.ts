import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as supervisionConfig from '../../shared/supervision-config.js';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * Source with comments removed.
 *
 * The layering rules below are about what the CODE depends on. A comment naming
 * a vendor value is documentation of why a rule exists -- often the most useful
 * line in the file -- and stripping that explanation to satisfy a grep would
 * trade a real explanation for an imaginary violation.
 */
const readCode = (path: string): string => read(path)
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/(^|[^:])\/\/.*$/gmu, '$1');

/**
 * LAYERING invariants only.
 *
 * This file used to assert the call graph with string matches, as a stand-in
 * for behavioural tests that could not run while the tree had unresolved
 * conflict markers. Those tests now exist and actually execute
 * (`delegation-send-gate`, `delegation-limit-combinations`,
 * `execution-clone-admission`), and a source match is NOT a gate -- it passes
 * on code that compiles and never runs.
 *
 * What remains are the properties behaviour genuinely cannot express: rules
 * about WHERE code may live and how many places may know a thing. A test can
 * observe that a limit was applied; it cannot observe that only one function
 * was able to apply it, or that no second copy of a vendor's vocabulary has
 * appeared elsewhere. Those are the invariants that decay silently, so they are
 * the ones worth pinning here.
 */
describe('provider limit layering', () => {
  const claudeAdapter = read('src/agent/providers/claude-code-sdk.ts');
  const claudeRateLimit = read('src/agent/claude-rate-limit.ts');
  const sessionManager = read('src/agent/session-manager.ts');
  const sessionStore = read('src/store/session-store.ts');
  const sendTool = read('src/daemon/send-tool.ts');
  const admission = read('src/daemon/delegation-admission.ts');
  const sharedProtocol = read('shared/delegation-availability.ts');
  const code = {
    sessionManager: readCode('src/agent/session-manager.ts'),
    sessionStore: readCode('src/store/session-store.ts'),
    sendTool: readCode('src/daemon/send-tool.ts'),
    admission: readCode('src/daemon/delegation-admission.ts'),
    sharedProtocol: readCode('shared/delegation-availability.ts'),
  };

  it('does not publish a second dead delegation eligibility evaluator', () => {
    expect('evaluateSupervisionDelegationEligibility' in supervisionConfig).toBe(false);
  });

  it('decides a limit in exactly one function', () => {
    // Two writers of `providerLimit` is two rules for when an agent may be
    // taken out of service, and the one that ran last wins silently. Both
    // writers route through `resolveProviderLimitUpdate`, so "only
    // provider-native evidence may limit an agent" stays checkable in one
    // place instead of one place per provider.
    expect([...sessionStore.matchAll(/^export function resolveProviderLimitUpdate\(/gmu)])
      .toHaveLength(1);
    const writers = [...sessionStore.matchAll(/\brecord\.providerLimit\s*=(?!=)/gu)];
    expect(writers).toHaveLength(1);
    // `=(?!=)` so a comparison is not counted as a write -- otherwise the guard
    // fails on correct code and gets "fixed" by loosening it.
    for (const [name, source] of [
      ['session-manager', sessionManager],
      ['claude adapter', claudeAdapter],
      ['send-tool', sendTool],
      ['admission', admission],
    ] as const) {
      expect(source, `${name} writes providerLimit directly`)
        .not.toMatch(/\.providerLimit\s*=(?!=)/u);
    }
  });

  it('keeps each vendor spelling inside that vendor adapter', () => {
    // `status` / `rateLimitType` / `resetsAt` are Claude's words. If they leak
    // upward, every new provider adds another dialect to the central layer and
    // the canonical signal stops being canonical.
    expect(claudeRateLimit).toContain('export function claudeRateLimitSignal');
    for (const vendorField of ['rateLimitType', 'resetsAt', 'allowed_warning']) {
      for (const [name, source] of [
        ['session-manager', code.sessionManager],
        ['session-store', code.sessionStore],
        ['send-tool', code.sendTool],
        ['admission', code.admission],
        ['shared protocol', code.sharedProtocol],
      ] as const) {
        expect(source, `${name} knows Claude's ${vendorField}`).not.toContain(vendorField);
      }
    }
  });

  it('never lets a prose-matched provider code reach the delegation layer', () => {
    // opencode-sdk and kimi-sdk derive PROVIDER_ERROR_CODES.RATE_LIMITED by
    // regexing an exception message. Those are display/retry concerns: a string
    // containing "429" is not a provider refusing you, and must not be able to
    // take an agent out of service.
    for (const [name, source] of [
      ['session-manager', sessionManager],
      ['session-store', sessionStore],
      ['send-tool', sendTool],
      ['admission', admission],
    ] as const) {
      expect(source, `${name} consumes RATE_LIMITED`).not.toContain('RATE_LIMITED');
    }
  });

  it('spells each refusal exactly once across the protocol', () => {
    // `target_limited` and `target_unavailable` reach callers as MCP reasons
    // AND as delegation constants. A second literal is a second spelling of one
    // refusal, and a consumer matching the wrong one fails open.
    for (const literal of ["'target_limited'", "'target_unavailable'"]) {
      for (const [name, source] of [
        ['shared protocol', sharedProtocol],
        ['send-tool', sendTool],
        ['admission', admission],
      ] as const) {
        expect([...source.matchAll(new RegExp(literal, 'gu'))], `${name} restates ${literal}`)
          .toHaveLength(0);
      }
    }
  });

  it('computes a limit deadline in exactly one function', () => {
    // Two deadline computations is how a target gets reported limited by one
    // code path and usable by another at the very same instant -- which is
    // precisely what happened before this was unified.
    expect([...sharedProtocol.matchAll(/^export function delegationLimitDeadline\(/gmu)])
      .toHaveLength(1);
    // Nobody re-derives the fallback arithmetic on their own.
    for (const [name, source] of [
      ['send-tool', sendTool],
      ['admission', admission],
      ['session-store', sessionStore],
    ] as const) {
      expect(source, `${name} re-derives the fallback window`)
        .not.toContain('DELEGATION_LIMIT_FALLBACK_TTL_MS');
    }
  });

  it('keeps admission out of the control plane', () => {
    // Stopping a session stuck behind a provider limit is exactly when an
    // operator most needs the button to work. send_stop is control, not
    // delegation, and must never be refused for quota.
    const stopStart = sendTool.indexOf('export async function dispatchSendStop');
    const stopEnd = sendTool.indexOf('\nexport ', stopStart + 1);
    const stopBody = sendTool.slice(stopStart, stopEnd === -1 ? undefined : stopEnd);
    expect(stopStart).toBeGreaterThan(-1);
    expect(stopBody).not.toContain('evaluateDelegationAdmission');
    expect(stopBody).not.toContain('TARGET_LIMITED');
    expect(stopBody).not.toContain('TARGET_UNAVAILABLE');
  });

  it('has no second copy of the admission decision', () => {
    // The P2P orchestrator bypassed the gate entirely because the rule lived
    // inside `send-tool` rather than in a service every producer imports. A
    // reimplementation anywhere else recreates that bypass.
    expect([...admission.matchAll(/^export function evaluateDelegationAdmission\(/gmu)])
      .toHaveLength(1);
    for (const consumer of ['src/daemon/send-tool.ts', 'src/daemon/execution-clone-orchestration.ts']) {
      expect(read(consumer), `${consumer} does not import the admission service`)
        .toContain("from './delegation-admission.js'");
    }
    // Only the service resolves availability; consumers ask it, not the
    // protocol directly.
    expect([...admission.matchAll(/resolveDelegationTargets\(/gu)]).toHaveLength(1);
  });
});
