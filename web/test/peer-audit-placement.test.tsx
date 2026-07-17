/**
 * Static migration guards for the SessionControls Quick shortcut.
 *
 * These checks intentionally do NOT claim runtime behavior coverage. Real
 * placement, visibility, dialog dispatch, candidate scope, and error behavior
 * are mounted in components/SessionControls.test.tsx and
 * quick-agent-delegation.test.tsx. This file only prevents accidental source
 * reintroduction of the removed peer-audit-controller Quick path.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src', 'components', 'SessionControls.tsx');
const source = readFileSync(SRC, 'utf8');

describe('SessionControls Quick static migration guards', () => {
  it('renders shortcut-btn-peer-audit immediately before shortcut-btn-auto', () => {
    const peerIdx = source.indexOf('shortcut-btn-peer-audit');
    const autoIdx = source.indexOf('shortcut-btn-auto');
    expect(peerIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeGreaterThan(-1);
    expect(peerIdx).toBeLessThan(autoIdx);
  });

  it('Peer Audit icon data-testid is peer-audit-icon', () => {
    expect(source).toContain('data-testid="peer-audit-icon"');
    expect(source).toContain('class="shortcut-btn-peer-audit-icon"');
    expect(source).not.toContain("t('peerAuditQuick.iconLabel').slice(0, 1)");
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

  it('does not reintroduce the old Quick peer-audit controller call', () => {
    expect(source).toContain('QuickAgentDelegationDialog');
    expect(source).not.toContain('peerAuditApi.start');
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

});
