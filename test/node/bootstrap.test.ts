import { describe, it, expect, vi } from 'vitest';
import { bootstrapControlledNode, journalPathFor, type ControlledNodeBootstrapDeps } from '../../src/node/bootstrap.js';
import type { InstallJournal, InstallPhase } from '../../src/node/install-journal.js';
import type { ControlledNodeCredential } from '../../src/node/enrollment.js';
import type { EnrollmentBlob } from '../../shared/remote-exec.js';

const CRED: ControlledNodeCredential = { serverId: 'srv-1', token: 'tok-1', serverUrl: 'https://relay', nodeRole: 'controlled' } as ControlledNodeCredential;
const BLOB: EnrollmentBlob = { serverUrl: 'https://relay', enrollToken: 'e1' } as EnrollmentBlob;

function makeDeps(over: Partial<ControlledNodeBootstrapDeps> = {}): ControlledNodeBootstrapDeps & { phases: InstallPhase[] } {
  const phases: InstallPhase[] = [];
  let journal: InstallJournal = { phase: 'uninstalled', updatedAt: 0 };
  const deps = {
    loadCredential: vi.fn(async () => null),
    readEnrollmentBlob: vi.fn(async () => BLOB),
    redeemEnrollment: vi.fn(async () => CRED),
    persistCredential: vi.fn(async () => {}),
    burnEnrollmentBlob: vi.fn(async () => {}),
    prepareCredentialDir: vi.fn(async () => {}),
    loadInstallJournal: vi.fn(async () => journal),
    writeInstallPhase: vi.fn(async (_p: string, phase: InstallPhase) => { phases.push(phase); journal = { phase, updatedAt: 1 }; }),
    journalPath: '/tmp/j.json',
    now: 123,
    warn: vi.fn(),
    ...over,
  } as ControlledNodeBootstrapDeps & { phases: InstallPhase[] };
  deps.phases = phases;
  return deps;
}

describe('bootstrapControlledNode — journaled first run (10.10)', () => {
  it('normal boot returns the already-persisted credential without redeeming', async () => {
    const deps = makeDeps({ loadCredential: vi.fn(async () => CRED) });
    const cred = await bootstrapControlledNode(deps);
    expect(cred).toBe(CRED);
    expect(deps.redeemEnrollment).not.toHaveBeenCalled();
    expect(deps.prepareCredentialDir).not.toHaveBeenCalled();
  });

  it('first run prepares + secures the credential dir BEFORE redeeming (N5 ordering)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      prepareCredentialDir: vi.fn(async () => { order.push('prepare'); }),
      redeemEnrollment: vi.fn(async () => { order.push('redeem'); return CRED; }),
      persistCredential: vi.fn(async () => { order.push('persist'); }),
    });
    const cred = await bootstrapControlledNode(deps);
    expect(cred).toBe(CRED);
    expect(order).toEqual(['prepare', 'redeem', 'persist']);
    // credential_prepared must be journaled before enrolled.
    expect(deps.phases).toEqual(['credential_prepared', 'enrolled', 'service_registered']);
    expect(deps.burnEnrollmentBlob).toHaveBeenCalledOnce();
  });

  it('errors (without redeeming) when there is no enrollment blob', async () => {
    const deps = makeDeps({ readEnrollmentBlob: vi.fn(async () => null) });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/not enrolled/);
    expect(deps.redeemEnrollment).not.toHaveBeenCalled();
  });

  it('a persist failure after redeem backs off and STOPS (marks enrolled, does not burn)', async () => {
    const deps = makeDeps({ persistCredential: vi.fn(async () => { throw new Error('EACCES'); }) });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/could not persist/i);
    expect(deps.redeemEnrollment).toHaveBeenCalledOnce();
    // 'enrolled' is journaled before the failed persist so the next boot detects the used token.
    expect(deps.phases).toEqual(['credential_prepared', 'enrolled']);
    expect(deps.burnEnrollmentBlob).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalled();
  });

  it('a re-run after a persist failure (journal=enrolled, no credential) REFUSES to re-redeem the used token', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => null),
      loadInstallJournal: vi.fn(async () => ({ phase: 'enrolled' as InstallPhase, updatedAt: 5 })),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/refusing to re-redeem/i);
    expect(deps.redeemEnrollment).not.toHaveBeenCalled();
    expect(deps.readEnrollmentBlob).not.toHaveBeenCalled();
  });
});

describe('journalPathFor', () => {
  it('places the journal beside the credential in the protected dir', () => {
    expect(journalPathFor('/var/lib/imcodes-node/credential.json')).toBe('/var/lib/imcodes-node/install-journal.json');
  });
});
