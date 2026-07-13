import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapControlledNode,
  bootstrapControlledNodeWithDisposition,
  isCurrentExecutableStable,
  journalPathFor,
  type ControlledNodeBootstrapDeps,
} from '../../src/node/bootstrap.js';
import type { InstallJournal, InstallPhase, ServiceReceipt } from '../../src/node/install-journal.js';
import type {
  ControlledNodeCredential,
  PendingInstallIdentity,
  StagedExecutableReceipt,
  VerifiedEnrollmentSource,
} from '../../src/node/enrollment.js';
import type { EnrollmentBlob, EnrollmentTrailerRange } from '../../shared/remote-exec.js';

const CRED: ControlledNodeCredential = {
  serverId: 'srv-1',
  token: 'tok-local',
  serverUrl: 'https://relay',
  nodeRole: 'controlled',
};
const BLOB: EnrollmentBlob = { serverUrl: 'https://relay', enrollToken: 'e1' };
const TRAILER: EnrollmentTrailerRange = { blob: BLOB, trailerStart: 4096, trailerLength: 128 };
const IDENTITY: PendingInstallIdentity = {
  installId: 'inst-1',
  nodeToken: 'tok-local',
  nodeTokenHash: 'a'.repeat(64),
  sourceExePath: '/tmp/download/imcodes-node',
};
const STAGED_RECEIPT: StagedExecutableReceipt = {
  path: '/tmp/staged/imcodes-node',
  size: TRAILER.trailerStart,
  sha256: 'b'.repeat(64),
  sourceIdentity: { size: 4224, mtimeMs: 1, ctimeMs: 1 },
  stagedIdentity: { size: 4096, mtimeMs: 2, ctimeMs: 2 },
};
const SERVICE_RECEIPT: ServiceReceipt = {
  name: 'imcodes-node',
  platform: 'linux',
  definitionPath: '/etc/systemd/system/imcodes-node.service',
  definitionSha256: 'c'.repeat(64),
  action: '/tmp/staged/imcodes-node',
};

function makeSource(over: Partial<VerifiedEnrollmentSource> = {}): VerifiedEnrollmentSource {
  return {
    sourcePath: '/tmp/download/imcodes-node',
    identity: STAGED_RECEIPT.sourceIdentity,
    statSize: vi.fn(async () => 4224),
    readExactly: vi.fn(async () => Buffer.alloc(0)),
    readEnrollmentBlobWithRange: vi.fn(async () => TRAILER),
    stageTrailerFreeExecutable: vi.fn(async () => STAGED_RECEIPT),
    cleanupEnrollmentSource: vi.fn(async () => 'cleaned' as const),
    close: vi.fn(async () => {}),
    ...over,
  };
}

function makeDeps(over: Partial<ControlledNodeBootstrapDeps> = {}): ControlledNodeBootstrapDeps & { phases: InstallPhase[]; journal: InstallJournal } {
  const phases: InstallPhase[] = [];
  let journal: InstallJournal = { phase: 'uninstalled', updatedAt: 0 };
  const source = makeSource();
  const deps = {
    loadCredential: vi.fn(async () => null),
    openVerifiedEnrollmentSource: vi.fn(async () => source),
    loadInstallIdentity: vi.fn(async () => null),
    persistInstallIdentity: vi.fn(async () => {}),
    generateInstallIdentity: vi.fn(() => ({ ...IDENTITY })),
    redeemEnrollmentV2: vi.fn(async () => CRED),
    persistCredential: vi.fn(async () => {}),
    installDefinition: vi.fn(async () => SERVICE_RECEIPT),
    inspectDefinition: vi.fn(async (receipt: ServiceReceipt) => receipt),
    inspectServiceState: vi.fn(async () => ({
      installed: true,
      action: SERVICE_RECEIPT.action ?? null,
      effectiveAction: SERVICE_RECEIPT.action ?? null,
      loadedActionMatches: true,
      loaded: true,
      bootEnabled: true,
      principal: 'root',
      restartPolicy: 'on-failure',
      observedDefinitionSha256: SERVICE_RECEIPT.definitionSha256 ?? null,
      definitionMatches: true,
      runState: 'running' as const,
      errors: [],
      raw: 'running',
    })),
    startService: vi.fn(async () => {}),
    verifyStagedExecutable: vi.fn(async () => {}),
    isStableRuntime: vi.fn(async () => false),
    assertElevated: vi.fn(async () => {}),
    prepareCredentialDir: vi.fn(async () => {}),
    loadInstallJournal: vi.fn(async () => journal),
    writeInstallPhase: vi.fn(async (_p: string, phase: InstallPhase, extra: Partial<InstallJournal> & { previous?: InstallJournal | null; now: number }) => {
      phases.push(phase);
      const { previous: _previous, now, ...patch } = extra;
      journal = { ...(extra.previous ?? journal), ...patch, phase, updatedAt: now };
      return journal;
    }),
    journalPath: '/tmp/j.json',
    credentialPath: '/tmp/credential.json',
    stagedExecutablePath: '/tmp/staged/imcodes-node',
    sourceExecutablePath: '/tmp/download/imcodes-node',
    now: 123,
    warn: vi.fn(),
    ...over,
  } as ControlledNodeBootstrapDeps & { phases: InstallPhase[]; journal: InstallJournal };
  deps.phases = phases;
  deps.journal = journal;
  return deps;
}

describe('bootstrapControlledNode — journaled first run (10.10 + D-A v2)', () => {
  it('runs runtime only from stable executable after service start was requested', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      isStableRuntime: vi.fn(async () => true),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'service_start_requested' as InstallPhase,
        updatedAt: 5,
        stagedExePath: STAGED_RECEIPT.path,
        stagedReceipt: STAGED_RECEIPT,
        serviceName: 'imcodes-node',
        serviceReceipt: SERVICE_RECEIPT,
        serviceStartRequestedAt: 5,
      })),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result).toMatchObject({ credential: CRED, disposition: 'run_runtime' });
    expect(deps.assertElevated).not.toHaveBeenCalled();
    expect(deps.openVerifiedEnrollmentSource).not.toHaveBeenCalled();
    expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
    expect(deps.installDefinition).not.toHaveBeenCalled();
    expect(deps.inspectServiceState).toHaveBeenCalledWith(SERVICE_RECEIPT);
    expect(deps.startService).not.toHaveBeenCalled();
  });

  it('stable owner repairs durable drift, re-inspects, and never restarts itself', async () => {
    const inspectServiceState = vi.fn()
      .mockResolvedValueOnce({ installed: true, action: '/wrong', effectiveAction: '/wrong', loadedActionMatches: false, loaded: true, bootEnabled: true, principal: 'root', restartPolicy: 'on-failure', observedDefinitionSha256: 'd'.repeat(64), definitionMatches: false, runState: 'running', errors: [], raw: 'drift' })
      .mockResolvedValueOnce({ installed: true, action: SERVICE_RECEIPT.action, effectiveAction: SERVICE_RECEIPT.action, loadedActionMatches: true, loaded: true, bootEnabled: true, principal: 'root', restartPolicy: 'on-failure', observedDefinitionSha256: SERVICE_RECEIPT.definitionSha256, definitionMatches: true, runState: 'running', errors: [], raw: 'repaired' });
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      isStableRuntime: vi.fn(async () => true),
      inspectServiceState,
      loadInstallJournal: vi.fn(async () => ({
        phase: 'service_start_requested' as InstallPhase,
        updatedAt: 5,
        stagedExePath: STAGED_RECEIPT.path,
        stagedReceipt: STAGED_RECEIPT,
        serviceName: SERVICE_RECEIPT.name,
        serviceReceipt: SERVICE_RECEIPT,
        serviceStartRequestedAt: 5,
      })),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result.disposition).toBe('run_runtime');
    expect(deps.installDefinition).toHaveBeenCalledWith(STAGED_RECEIPT.path);
    expect(inspectServiceState).toHaveBeenCalledTimes(2);
    expect(deps.startService).not.toHaveBeenCalled();
  });

  it('stable owner refuses healthy when the disk definition is rewritten but the manager keeps the old action', async () => {
    // Post-rewrite the on-disk definition matches the receipt, but the service
    // MANAGER never reloaded, so its effective loaded action still lags. That
    // divergence (definitionMatches=true, loadedActionMatches=false) MUST keep
    // reconciliation unhealthy — the stable owner may repair the file but is
    // forbidden from restarting itself, so it refuses to claim persistence.
    const inspectServiceState = vi.fn()
      .mockResolvedValueOnce({ installed: true, action: '/old', effectiveAction: '/old', loadedActionMatches: false, loaded: true, bootEnabled: true, principal: 'root', restartPolicy: 'on-failure', observedDefinitionSha256: 'e'.repeat(64), definitionMatches: false, runState: 'running', errors: [], raw: 'pre-repair' })
      .mockResolvedValueOnce({ installed: true, action: SERVICE_RECEIPT.action, effectiveAction: '/old', loadedActionMatches: false, loaded: true, bootEnabled: true, principal: 'root', restartPolicy: 'on-failure', observedDefinitionSha256: SERVICE_RECEIPT.definitionSha256, definitionMatches: true, runState: 'running', errors: [], raw: 'disk-rewritten-manager-stale' });
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      isStableRuntime: vi.fn(async () => true),
      inspectServiceState,
      loadInstallJournal: vi.fn(async () => ({
        phase: 'service_start_requested' as InstallPhase,
        updatedAt: 5,
        stagedExePath: STAGED_RECEIPT.path,
        stagedReceipt: STAGED_RECEIPT,
        serviceName: SERVICE_RECEIPT.name,
        serviceReceipt: SERVICE_RECEIPT,
        serviceStartRequestedAt: 5,
      })),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result.disposition).toBe('run_runtime');
    expect(deps.installDefinition).toHaveBeenCalledWith(STAGED_RECEIPT.path);
    expect(inspectServiceState).toHaveBeenCalledTimes(2);
    // SIDE-EFFECT-FREE reconciliation: rewrote the file, never restarted itself.
    expect(deps.startService).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('remains unverified'));
  });

  it('stable owner at service_registered only persists start intent and does not restart itself', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      isStableRuntime: vi.fn(async () => true),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'service_registered' as InstallPhase,
        updatedAt: 5,
        stagedExePath: '/tmp/staged/imcodes-node',
        stagedReceipt: STAGED_RECEIPT,
        serviceName: 'imcodes-node',
        serviceReceipt: SERVICE_RECEIPT,
      })),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result).toMatchObject({ credential: CRED, disposition: 'run_runtime' });
    expect(deps.verifyStagedExecutable).toHaveBeenCalledWith(STAGED_RECEIPT);
    expect(deps.inspectDefinition).toHaveBeenCalledWith(SERVICE_RECEIPT);
    expect(deps.phases).toEqual(['service_start_requested']);
    expect(deps.startService).not.toHaveBeenCalled();
  });

  it('source process resumes service registration, writes start intent, starts service, then hands off', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'enrolled' as InstallPhase,
        updatedAt: 5,
        stagedExePath: '/tmp/staged/imcodes-node',
        stagedReceipt: STAGED_RECEIPT,
      })),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result).toMatchObject({ credential: CRED, disposition: 'handoff_complete' });
    expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
    expect(deps.installDefinition).toHaveBeenCalledWith('/tmp/staged/imcodes-node');
    expect(deps.inspectDefinition).toHaveBeenCalledWith(SERVICE_RECEIPT);
    expect(deps.startService).toHaveBeenCalledWith(SERVICE_RECEIPT);
    expect(deps.verifyStagedExecutable).toHaveBeenCalledWith(STAGED_RECEIPT);
    expect(deps.phases).toEqual(['service_registered', 'service_start_requested']);
  });

  it('first run uses the same verified source for trailer, staging, cleanup, then starts stable service', async () => {
    const order: string[] = [];
    const source = makeSource({
      readEnrollmentBlobWithRange: vi.fn(async () => { order.push('trailer'); return TRAILER; }),
      stageTrailerFreeExecutable: vi.fn(async () => { order.push('stage'); return STAGED_RECEIPT; }),
      cleanupEnrollmentSource: vi.fn(async () => { order.push('cleanup'); return 'cleaned' as const; }),
    });
    const deps = makeDeps({
      openVerifiedEnrollmentSource: vi.fn(async () => source),
      assertElevated: vi.fn(async () => { order.push('elevate'); }),
      prepareCredentialDir: vi.fn(async () => { order.push('prepare'); }),
      persistInstallIdentity: vi.fn(async () => { order.push('identity'); }),
      redeemEnrollmentV2: vi.fn(async () => { order.push('redeem'); return CRED; }),
      persistCredential: vi.fn(async () => { order.push('persist'); }),
      installDefinition: vi.fn(async () => { order.push('install'); return SERVICE_RECEIPT; }),
      inspectDefinition: vi.fn(async (receipt) => { order.push('inspect'); return receipt; }),
      startService: vi.fn(async () => { order.push('start'); }),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result).toMatchObject({ credential: CRED, disposition: 'handoff_complete' });
    expect(order).toEqual(['elevate', 'trailer', 'prepare', 'identity', 'stage', 'redeem', 'persist', 'cleanup', 'install', 'inspect', 'start']);
    expect(source.stageTrailerFreeExecutable).toHaveBeenCalledWith('/tmp/staged/imcodes-node', TRAILER.trailerStart);
    expect(source.cleanupEnrollmentSource).toHaveBeenCalledWith(TRAILER.trailerStart, TRAILER.trailerLength);
    expect(source.close).toHaveBeenCalledOnce();
    expect(deps.phases).toEqual(['elevated', 'credential_prepared', 'files_staged', 'enrolled', 'service_registered', 'service_start_requested']);
    expect(result.journal.stagedReceipt).toEqual(STAGED_RECEIPT);
    expect(result.journal.serviceReceipt).toEqual(SERVICE_RECEIPT);
    expect(result.journal.serviceStartRequestedAt).toBe(123);
  });

  it('persists install identity BEFORE redeeming (D-A ordering)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      persistInstallIdentity: vi.fn(async () => { order.push('identity'); }),
      redeemEnrollmentV2: vi.fn(async () => { order.push('redeem'); return CRED; }),
    });
    await bootstrapControlledNode(deps);
    expect(order.indexOf('identity')).toBeLessThan(order.indexOf('redeem'));
  });

  it('fails before any protected write or redeem when first launch is not elevated', async () => {
    const deps = makeDeps({
      assertElevated: vi.fn(async () => { throw new Error('requires Administrator/root'); }),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/Administrator\/root/);
    expect(deps.phases).toEqual([]);
    expect(deps.prepareCredentialDir).not.toHaveBeenCalled();
    expect(deps.persistInstallIdentity).not.toHaveBeenCalled();
    expect(deps.openVerifiedEnrollmentSource).not.toHaveBeenCalled();
    expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
  });

  it('errors (without redeeming) when there is no enrollment blob on fresh install', async () => {
    const deps = makeDeps({
      openVerifiedEnrollmentSource: vi.fn(async () => makeSource({ readEnrollmentBlobWithRange: vi.fn(async () => null) })),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/not enrolled/);
    expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
  });

  it('a persist failure after redeem leaves enrolled journal and retries on next boot', async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({ persistCredential: persist });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/could not persist/i);
    expect(deps.redeemEnrollmentV2).toHaveBeenCalledOnce();
    expect(deps.phases).toEqual(['elevated', 'credential_prepared', 'files_staged', 'enrolled']);

    const retry = makeDeps({
      loadInstallIdentity: vi.fn(async () => IDENTITY),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'enrolled' as InstallPhase,
        updatedAt: 5,
        installId: 'inst-1',
        nodeTokenHash: IDENTITY.nodeTokenHash,
        sourceExePath: IDENTITY.sourceExePath,
        serverId: 'srv-1',
        stagedExePath: '/tmp/staged/imcodes-node',
        stagedReceipt: STAGED_RECEIPT,
      })),
      persistCredential: persist,
    });
    const cred = await bootstrapControlledNode(retry);
    expect(cred).toBe(CRED);
    expect(retry.redeemEnrollmentV2).toHaveBeenCalledWith(BLOB, IDENTITY);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('journal=enrolled with persisted identity replays redeem to recover credential metadata', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => null),
      loadInstallIdentity: vi.fn(async () => IDENTITY),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'enrolled' as InstallPhase,
        updatedAt: 5,
        installId: 'inst-1',
        nodeTokenHash: IDENTITY.nodeTokenHash,
        sourceExePath: IDENTITY.sourceExePath,
        serverId: 'srv-1',
        stagedExePath: '/tmp/staged/imcodes-node',
        stagedReceipt: STAGED_RECEIPT,
        cleanupStatus: 'cleaned' as const,
      })),
    });
    const cred = await bootstrapControlledNode(deps);
    expect(cred).toBe(CRED);
    expect(deps.redeemEnrollmentV2).toHaveBeenCalledWith(BLOB, IDENTITY);
    expect(deps.phases).toEqual(['enrolled', 'service_registered', 'service_start_requested']);
  });

  it('reconciles the legitimate credential-fsync crash window one phase at a time', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      loadInstallJournal: vi.fn(async () => ({
        version: 1,
        phase: 'files_staged' as InstallPhase,
        updatedAt: 5,
        installId: IDENTITY.installId,
        nodeTokenHash: IDENTITY.nodeTokenHash,
        sourceExePath: IDENTITY.sourceExePath,
        stagedExePath: '/tmp/staged/imcodes-node',
        stagedReceipt: STAGED_RECEIPT,
      })),
    });
    await expect(bootstrapControlledNode(deps)).resolves.toBe(CRED);
    expect(deps.phases).toEqual(['enrolled', 'service_registered', 'service_start_requested']);
    expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
    expect(deps.installDefinition).toHaveBeenCalledWith('/tmp/staged/imcodes-node');
  });

  it('rejects a credential that appears before files_staged instead of inventing journal progress', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      loadInstallJournal: vi.fn(async () => ({ phase: 'elevated' as InstallPhase, updatedAt: 5 })),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/before files_staged/);
    expect(deps.installDefinition).not.toHaveBeenCalled();
    expect(deps.phases).toEqual([]);
  });

  it('installer failure does not write service_registered or start intent', async () => {
    const deps = makeDeps({
      installDefinition: vi.fn(async () => { throw new Error('schtasks failed'); }),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/schtasks failed/);
    expect(deps.phases).not.toContain('service_registered');
    expect(deps.phases).not.toContain('service_start_requested');
  });

  it('fails closed when a files_staged recovery journal has no staged receipt', async () => {
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'files_staged' as InstallPhase,
        updatedAt: 5,
        installId: IDENTITY.installId,
        nodeTokenHash: IDENTITY.nodeTokenHash,
        sourceExePath: IDENTITY.sourceExePath,
        stagedExePath: '/tmp/staged/imcodes-node',
      })),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/staged executable receipt is missing/);
    expect(deps.installDefinition).not.toHaveBeenCalled();
  });

  it('repairs a service_registered definition by reinstalling from the staged receipt before start', async () => {
    const staleReceipt: ServiceReceipt = { ...SERVICE_RECEIPT, definitionSha256: 'd'.repeat(64) };
    const deps = makeDeps({
      loadCredential: vi.fn(async () => CRED),
      loadInstallJournal: vi.fn(async () => ({
        phase: 'service_registered' as InstallPhase,
        updatedAt: 5,
        stagedExePath: '/tmp/staged/imcodes-node',
        stagedReceipt: STAGED_RECEIPT,
        serviceName: 'imcodes-node',
        serviceReceipt: staleReceipt,
      })),
      inspectDefinition: vi.fn()
        .mockRejectedValueOnce(new Error('definition hash mismatch'))
        .mockResolvedValueOnce(SERVICE_RECEIPT),
    });
    const result = await bootstrapControlledNodeWithDisposition(deps);
    expect(result.disposition).toBe('handoff_complete');
    expect(deps.installDefinition).toHaveBeenCalledWith('/tmp/staged/imcodes-node');
    expect(deps.inspectDefinition).toHaveBeenNthCalledWith(1, staleReceipt);
    expect(deps.inspectDefinition).toHaveBeenNthCalledWith(2, SERVICE_RECEIPT);
    expect(deps.phases).toEqual(['service_registered', 'service_start_requested']);
  });

  it('service start failure leaves durable start intent for crash recovery replay', async () => {
    const deps = makeDeps({
      startService: vi.fn(async () => { throw new Error('start failed'); }),
    });
    await expect(bootstrapControlledNode(deps)).rejects.toThrow(/start failed/);
    expect(deps.phases).toContain('service_registered');
    expect(deps.phases).toContain('service_start_requested');
  });

  it('reuses persisted install identity on retry instead of regenerating', async () => {
    const deps = makeDeps({
      loadInstallIdentity: vi.fn(async () => IDENTITY),
    });
    await bootstrapControlledNode(deps);
    expect(deps.generateInstallIdentity).not.toHaveBeenCalled();
    expect(deps.persistInstallIdentity).not.toHaveBeenCalled();
    expect(deps.redeemEnrollmentV2).toHaveBeenCalledWith(BLOB, IDENTITY);
  });
});

describe('journalPathFor', () => {
  it('places the journal beside the credential in the protected dir', () => {
    expect(journalPathFor('/var/lib/imcodes-node/credential.json')).toBe('/var/lib/imcodes-node/install-journal.json');
  });
});

describe('isCurrentExecutableStable', () => {
  it('requires the receipt hash and does not trust source==staged string equality', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stable-runtime-'));
    try {
      const exePath = join(dir, 'imcodes-node');
      const bytes = Buffer.from('stable-executable');
      await writeFile(exePath, bytes);
      const st = await stat(exePath);
      const receipt: StagedExecutableReceipt = {
        path: exePath,
        size: st.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceIdentity: { size: st.size + 1, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: {
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          dev: st.dev,
          ino: st.ino,
        },
      };
      await expect(isCurrentExecutableStable({ stagedReceipt: receipt }, exePath)).resolves.toBe(true);
      await writeFile(exePath, Buffer.from('changed'));
      await expect(isCurrentExecutableStable({ stagedReceipt: receipt }, exePath)).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
