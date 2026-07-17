/**
 * SessionControls DOM placement smoke test.
 *
 * Verifies the Peer Audit shortcut renders immediately before the Auto
 * shortcut and shares its visibility gate (canQuickControlSupervision). It
 * does NOT mount the full SessionControls — instead, it inspects the source
 * file for the deterministic DOM structure so the test is independent of the
 * component's many internal hooks.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src', 'components', 'SessionControls.tsx');
const source = readFileSync(SRC, 'utf8');

describe('SessionControls DOM placement (source-level)', () => {
  it('renders shortcut-btn-peer-audit immediately before shortcut-btn-auto', () => {
    const peerIdx = source.indexOf('shortcut-btn-peer-audit');
    const autoIdx = source.indexOf('shortcut-btn-auto');
    expect(peerIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeGreaterThan(-1);
    expect(peerIdx).toBeLessThan(autoIdx);
  });

  it('Peer Audit icon data-testid is peer-audit-icon', () => {
    expect(source).toContain('data-testid="peer-audit-icon"');
  });

  it('Peer Audit icon shares canQuickControlSupervision gate', () => {
    // The Peer Audit icon button is wrapped in the same canQuickControlSupervision check.
    const peerGateIdx = source.indexOf('canQuickControlSupervision &&');
    const peerBtnIdx = source.indexOf('shortcut-btn-peer-audit');
    const autoBtnIdx = source.indexOf('shortcut-btn-auto');
    // Both buttons must appear AFTER a canQuickControlSupervision && check.
    expect(peerGateIdx).toBeLessThan(peerBtnIdx);
    expect(peerGateIdx).toBeLessThan(autoBtnIdx);
  });

  it('Peer Audit icon is also gated on authoritative identity (no name fallback)', () => {
    // The icon div must check BOTH canQuickControlSupervision AND
    // auditedSessionIdentity. The auditedSessionIdentity constant is
    // produced from sessionInstanceId + runtimeEpoch sourced from
    // session_list / subsession.sync — never from session name.
    const peerBtnIdx = source.indexOf('shortcut-btn-peer-audit');
    const before = source.slice(Math.max(0, peerBtnIdx - 400), peerBtnIdx);
    expect(before).toContain('canQuickControlSupervision');
    expect(before).toContain('auditedSessionIdentity');
  });

  it('forbids name-as-identity construction (auditedSessionIdentity is null until projection exposes it)', () => {
    // The sessionName substitution that previously built sessionInstanceId from
    // session name MUST NOT exist. We assert by absence of the
    // `sessionInstanceId: subSessionId` / `sessionInstanceId: activeSession.name`
    // patterns the previous edit removed.
    expect(source).not.toMatch(/sessionInstanceId:\s*subSessionId/);
    expect(source).not.toMatch(/sessionInstanceId:\s*activeSession\?\.name/);
  });

  it('Peer Audit icon is the immediate button sibling before Auto inside autoRef', () => {
    // Both controls share one wrapper so keyboard/focus positioning and the
    // user-requested left-of-Auto placement cannot drift across reloads.
    const peerBlockIdx = source.indexOf('shortcut-btn-peer-audit');
    // Look at ~250 chars of context before to find the wrapping div.
    const beforePeer = source.slice(Math.max(0, peerBlockIdx - 400), peerBlockIdx);
    expect(beforePeer).toContain('shortcuts-model');
    expect(beforePeer).toContain('ref={autoRef}');
    const afterPeer = source.slice(peerBlockIdx, peerBlockIdx + 1000);
    expect(afterPeer.indexOf('shortcut-btn-auto')).toBeGreaterThan(0);
  });

  it('does not mutate supervision Auto color/dot', () => {
    // Find the auto-color/dot block — it must remain unchanged (no Peer Audit hooks touched it).
    // We assert that quickAutoColor is still computed from quickSupervisionMode, not from peer audit state.
    expect(source).toContain('quickAutoColor');
    expect(source).toContain('quickSupervisionMode === SUPERVISION_MODE.SUPERVISED');
  });

  it('exposes the chooser overlay at peer-audit-overlay / peer-audit-modal test ids', () => {
    expect(source).toContain('data-testid="peer-audit-overlay"');
    expect(source).toContain('data-testid="peer-audit-modal"');
    expect(source).toContain('data-testid="peer-audit-pending"');
    expect(source).toContain('data-testid="peer-audit-result"');
    expect(source).toContain('data-testid="peer-audit-error"');
  });

  it('chooser component exposes peer-audit-chooser / peer-audit-chooser-row test ids', () => {
    const chooserPath = join(__dirname, '..', 'src', 'peerAudit', 'PeerAuditAuditorChooser.tsx');
    const chooser = readFileSync(chooserPath, 'utf8');
    expect(chooser).toContain('data-testid="peer-audit-chooser"');
    expect(chooser).toContain('data-testid="peer-audit-chooser-row"');
    expect(chooser).toContain('data-testid="peer-audit-chooser-loading"');
    expect(chooser).toContain('data-testid="peer-audit-chooser-consent"');
    expect(chooser).toContain('data-testid="peer-audit-chooser-empty"');
  });
});
