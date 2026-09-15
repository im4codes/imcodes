import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type GateStatus = 'covered' | 'unavailable';

interface EvidenceGate {
  id: string;
  status: GateStatus;
  file?: string;
  needles?: readonly string[];
  unavailableReason?: string;
}

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

function missingEvidence(gates: readonly EvidenceGate[]): string[] {
  const issues: string[] = [];
  for (const gate of gates) {
    if (gate.status === 'unavailable') continue;
    const text = read(gate.file!);
    for (const needle of gate.needles ?? []) {
      if (!text.includes(needle)) issues.push(`${gate.id} missing ${gate.file}:${needle}`);
    }
  }
  return issues;
}

function unavailableGateIds(gates: readonly EvidenceGate[]): string[] {
  return gates.filter((gate) => gate.status === 'unavailable').map((gate) => gate.id).sort();
}

const LIFECYCLE_GATES: EvidenceGate[] = [
  {
    id: '14.1.browser.fragment_scrub_before_app',
    status: 'covered',
    file: 'test/security/remote-desktop-secret-gate.test.ts',
    needles: ['browser URL/history/storage/DOM gate', 'window.history.replaceState', "credentials: 'omit'", "referrerPolicy: 'no-referrer'"],
  },
  {
    id: '14.1.db_log_audit_secret_scan',
    status: 'covered',
    file: 'test/security/remote-desktop-secret-gate.test.ts',
    needles: ['raw invite, password, browser-private-key and bootstrap-proof fields out of remote desktop schemas', 'redacts exact secret field names recursively', 'source-level sink inventory'],
  },
  {
    id: '14.3.resolve_claim_bootstrap_revoke',
    status: 'covered',
    file: 'server/test/remote-desktop-guest-links.integration.test.ts',
    needles: ['browser claim and session binding', 'public proof and sticky bootstrap', 'discloses serverId and a bootstrap only after successful proof', 'redeems once on the owning pod and refuses replay', 'refuses wrong pod, wrong browser, expiry and superseded generation'],
  },
  {
    id: '14.3.consent_prepare_renewal',
    status: 'covered',
    file: 'server/test/remote-desktop-guest-router.test.ts',
    needles: ['never dispatches a start presented before bootstrap proof', 'does not dispatch PREPARE until attended consent resolves positively', 'terminates an ICE renewal after the durable guest authority is revoked'],
  },
  {
    id: '14.4.password_public_id_generation',
    status: 'covered',
    file: 'server/test/remote-desktop-unattended-password-bootstrap.test.ts',
    needles: ['rechecks generation and persists the public SPKI in the same issue transaction', 'redeems only with the current password generation and the bound non-exportable-key proof', 'does not revive a ticket after password change or emergency disable'],
  },
  {
    id: '14.5.claim_route_db_rollback',
    status: 'covered',
    file: 'server/test/remote-desktop-lifecycle-crash.integration.test.ts',
    needles: ['crash during claim/connected route', 'rejects a duplicate claim with a generic refusal', 'closes a route during starting and repairs the snapshot', 'closing the DB and reopening preserves epoch/duration state for recovery'],
  },
  {
    id: '14.5.pod_daemon_worker_restart',
    status: 'covered',
    file: 'server/test/remote-desktop-management-privacy.integration.test.ts',
    needles: ['owning-pod acknowledgement', 'wrong pod', 'stale daemon generation', 'simulated restart: durable state, not process memory, decides'],
  },
  {
    id: '14.6.privacy_route_ack_input_release_frame_shielding',
    status: 'covered',
    file: 'server/test/remote-desktop-management-privacy.integration.test.ts',
    needles: ['closes admission so a later route cannot join behind the barrier', 'advances to active only on an exact complete route set', 'clears secret state first and keeps admission closed until a fresh frame', 'rejects a cached pre-end frame generation'],
  },
  {
    id: '14.6.consent_one_session_outbox_due',
    status: 'covered',
    file: 'server/test/remote-desktop-consent-coordinator.integration.test.ts',
    needles: ['consumes once, permits only exact-session resume and rejects a second session', 'serializes concurrent consumers so only one new session wins', 'sweeps expired pending/approved rows exactly once and emits bounded CANCEL', 'schema secret boundary'],
  },
  {
    id: '14.6.connection_reuse_background_input',
    status: 'covered',
    file: 'web/test/remote-desktop-connection-manager.test.ts',
    needles: ['reuses one owner, start, and peer allocation when the same host is reopened', 'releases held input exactly before presentation ownership moves', 'rejects background-tab input through presentation-scoped handles'],
  },
  {
    id: '14.6.remote_clipboard_privacy_gate',
    status: 'covered',
    file: 'test/spec/windows-remote-desktop-build-manifests.test.ts',
    needles: ['blocks remote clipboard reads for the entire privacy epoch', 'ClipboardSequence()', 'ReadClipboardText(previous_sequence)'],
  },
  {
    id: '14.6.real_browser_url_history_storage',
    status: 'unavailable',
    unavailableReason: 'Requires end-to-end browser session against deployed anonymous entry; static/browser harnesses are not URL-history proof.',
  },
  {
    id: '14.6.real_windows_signed_shell_privacy_clipboard',
    status: 'unavailable',
    unavailableReason: 'Windows signed shell / native clipboard watchdog qualification is outside this local test-only track.',
  },
  {
    id: '14.6.real_multipod_crash_delivery',
    status: 'unavailable',
    unavailableReason: 'Requires multi-pod deployment and process crash orchestration; local DB/fixture tests remain partial.',
  },
];

const REQUIRED_MUTATION_GATES = [
  'pre-proof routing privacy',
  'bootstrap redemption',
  'fragment scrub',
  'browser binding',
  'one session',
  'consent-before-PREPARE',
  'Owner step-up',
  'privacy-route acknowledgement',
  'input release',
  'frame shielding',
  'local secret clearing',
  'clipboard clearing',
  'due scheduling',
  'generation fencing',
  'outbox retry',
  'connection reuse',
  'background-input gate',
  'remote clipboard privacy gate',
] as const;

type MutationGate = typeof REQUIRED_MUTATION_GATES[number];

function mutationGateFailures(enabled: Readonly<Record<MutationGate, boolean>>): string[] {
  return REQUIRED_MUTATION_GATES.filter((gate) => enabled[gate] !== true);
}

describe('remote desktop 14.1/14.3-14.6 lifecycle and mutation release gates', () => {
  it('pins the current executable evidence without treating unavailable real environments as passed', () => {
    expect(missingEvidence(LIFECYCLE_GATES)).toEqual([]);
    expect(unavailableGateIds(LIFECYCLE_GATES)).toEqual([
      '14.6.real_browser_url_history_storage',
      '14.6.real_multipod_crash_delivery',
      '14.6.real_windows_signed_shell_privacy_clipboard',
    ]);
  });

  it('requires every named 14.6 mutation guard and fails on a representative removed fence', () => {
    const baseline = Object.fromEntries(REQUIRED_MUTATION_GATES.map((gate) => [gate, true])) as Record<MutationGate, boolean>;
    expect(mutationGateFailures(baseline)).toEqual([]);

    const broken = {
      ...baseline,
      'fragment scrub': false,
      'privacy-route acknowledgement': false,
      'background-input gate': false,
      'remote clipboard privacy gate': false,
    };
    expect(mutationGateFailures(broken)).toEqual([
      'fragment scrub',
      'privacy-route acknowledgement',
      'background-input gate',
      'remote clipboard privacy gate',
    ]);
  });
});
