import {
  CONTROLLED_NODE_RUNTIME_ABI_PROFILE,
  type ControlledNodeAbiProfile,
} from '../../shared/controlled-node-abi.js';
import type { DesktopSetupStep } from '../../shared/desktop-setup-auth.js';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
} from '../../shared/remote-desktop-local-management.js';
import {
  defaultInstallIdentityPath,
  enrollDirectV2,
  generateInstallIdentity,
  inspectExecutableReceipt,
  loadInstallIdentity,
  openVerifiedEnrollmentSource,
  persistCredential,
  persistInstallIdentity,
  type ControlledNodeCredential,
  type StagedExecutableReceipt,
} from './enrollment.js';
import {
  INSTALL_PHASES,
  loadInstallJournal,
  phaseIndex,
  writeInstallPhase,
  type InstallJournal,
  type InstallPhase,
} from './install-journal.js';
import type { LocalDaemonController, PreparedDaemonBind } from './local-daemon-control.js';

export interface PendingDesktopSetupDeps {
  credentialPath: string;
  journalPath: string;
  stagedExecutablePath: string;
  sourceExecutablePath?: string;
  abiProfile?: ControlledNodeAbiProfile;
  now?: () => number;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  hostname?: string;
  persistCredentialFn?: typeof persistCredential;
}

export interface ExecutePendingDesktopSetupInput {
  relayOrigin: string;
  apiKey: string;
  daemonController: Pick<LocalDaemonController, 'performAction' | 'readSetupBindingInfo' | 'prepareBind' | 'commitBind'>;
  deps: PendingDesktopSetupDeps;
  onStep?: (step: DesktopSetupStep) => void;
}

function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function advanceJournalToPhase(
  journalPath: string,
  targetPhase: InstallPhase,
  extra: Omit<Parameters<typeof writeInstallPhase>[2], 'now' | 'previous'>,
  now: () => number,
): Promise<InstallJournal> {
  let journal = await loadInstallJournal(journalPath);
  const currentIdx = phaseIndex(journal.phase);
  const targetIdx = phaseIndex(targetPhase);
  if (currentIdx >= targetIdx) return journal;
  for (let i = currentIdx + 1; i <= targetIdx; i++) {
    const phase = INSTALL_PHASES[i]!;
    const phaseMeta: Omit<Parameters<typeof writeInstallPhase>[2], 'now' | 'previous'> = {
      ...(extra.abiProfile ? { abiProfile: extra.abiProfile } : {}),
      ...(i >= phaseIndex('credential_prepared') ? {
        ...(extra.installId ? { installId: extra.installId } : {}),
        ...(extra.nodeTokenHash ? { nodeTokenHash: extra.nodeTokenHash } : {}),
        ...(extra.sourceExePath ? { sourceExePath: extra.sourceExePath } : {}),
      } : {}),
      ...(i >= phaseIndex('files_staged') ? {
        ...(extra.stagedExePath ? { stagedExePath: extra.stagedExePath } : {}),
        ...(extra.stagedReceipt ? { stagedReceipt: extra.stagedReceipt } : {}),
      } : {}),
      ...(i >= phaseIndex('enrolled') && extra.serverId ? { serverId: extra.serverId } : {}),
    };
    journal = await writeInstallPhase(journalPath, phase, {
      ...phaseMeta,
      now: now(),
      previous: journal,
    });
  }
  return journal;
}

async function resolveOrStageExecutableReceipt(
  stagedExecutablePath: string,
  sourceExecutablePath: string,
): Promise<StagedExecutableReceipt> {
  try {
    return await inspectExecutableReceipt(stagedExecutablePath, sourceExecutablePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  const source = await openVerifiedEnrollmentSource(sourceExecutablePath);
  try {
    const trailerRange = await source.readEnrollmentBlobWithRange();
    const stableSize = trailerRange ? trailerRange.trailerStart : await source.statSize();
    return await source.stageTrailerFreeExecutable(
      stagedExecutablePath,
      stableSize,
      trailerRange?.windowsAuthenticode,
    );
  } finally {
    await source.close().catch(() => {});
  }
}

/**
 * Chained Desktop Phase 2B binding:
 * 1) Prepare Coding Daemon bind/reuse and verify hostServerId + running precondition without mutating another relay's server.json prematurely.
 * 2) Enroll this machine's Controlled Node + Remote Desktop via POST /api/enroll/v2/direct with confirmed hostServerId.
 * 3) Commit Coding Daemon bind (with automatic rollback on failure), compute/stage real executable receipt, persist credential.json, and advance journal to enrolled.
 */
export async function executePendingDesktopSetup({
  relayOrigin,
  apiKey,
  daemonController,
  deps,
  onStep,
}: ExecutePendingDesktopSetupInput): Promise<ControlledNodeCredential> {
  const now = deps.now ?? (() => Date.now());
  const abiProfile = deps.abiProfile ?? CONTROLLED_NODE_RUNTIME_ABI_PROFILE;
  const sourceExecutablePath = deps.sourceExecutablePath ?? process.execPath;

  onStep?.('binding_daemon');
  let hostServerId: string | undefined;
  let preparedBind: PreparedDaemonBind | null = null;
  const existingDaemon = await daemonController.readSetupBindingInfo?.();
  if (
    existingDaemon?.bound
    && existingDaemon.serverId
    && normalizeOrigin(existingDaemon.workerUrl) === relayOrigin
  ) {
    const startResult = await daemonController.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    if (!startResult.ok) {
      throw new Error(startResult.error ?? 'daemon_start_failed');
    }
    const verifiedDaemon = await daemonController.readSetupBindingInfo?.();
    hostServerId = verifiedDaemon?.serverId ?? existingDaemon.serverId;
    if (!hostServerId) {
      throw new Error('daemon_server_id_missing');
    }
  } else {
    const bindUrl = `${relayOrigin}/bind/${apiKey}`;
    if (daemonController.prepareBind && daemonController.commitBind) {
      const prep = await daemonController.prepareBind({ bindUrl });
      if (!prep.ok) {
        throw new Error(prep.error ?? 'daemon_bind_failed');
      }
      if (!prep.prepared.serverId) {
        throw new Error('daemon_server_id_missing');
      }
      hostServerId = prep.prepared.serverId;
      preparedBind = prep.prepared;
    } else {
      const bindResult = await daemonController.performAction(
        REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND,
        { bindUrl },
      );
      if (!bindResult.ok) {
        throw new Error(bindResult.error ?? 'daemon_bind_failed');
      }
      const updatedDaemon = await daemonController.readSetupBindingInfo?.();
      hostServerId = updatedDaemon?.serverId ?? undefined;
      if (!hostServerId) {
        throw new Error('daemon_server_id_missing');
      }
    }
  }

  onStep?.('enrolling_node');
  const identityPath = defaultInstallIdentityPath(deps.credentialPath);
  const existingIdentity = await loadInstallIdentity(identityPath);
  const identity = existingIdentity ?? {
    ...generateInstallIdentity(),
    sourceExePath: sourceExecutablePath,
  };
  if (!existingIdentity) {
    await persistInstallIdentity(identity, identityPath);
  }

  await advanceJournalToPhase(
    deps.journalPath,
    'credential_prepared',
    {
      installId: identity.installId,
      nodeTokenHash: identity.nodeTokenHash,
      sourceExePath: identity.sourceExePath ?? sourceExecutablePath,
      abiProfile,
    },
    now,
  );

  const credential = await enrollDirectV2({
    relayUrl: relayOrigin,
    apiKey,
    identity,
    hostServerId,
    abiProfile,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.arch ? { arch: deps.arch } : {}),
    ...(deps.hostname ? { hostname: deps.hostname } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });

  if (preparedBind && daemonController.commitBind) {
    const commitResult = await daemonController.commitBind(preparedBind);
    if (!commitResult.ok) {
      throw new Error(commitResult.error ?? 'daemon_bind_failed');
    }
  }

  const stagedReceipt = await resolveOrStageExecutableReceipt(
    deps.stagedExecutablePath,
    identity.sourceExePath ?? sourceExecutablePath,
  );

  const saveCredential = deps.persistCredentialFn ?? persistCredential;
  await saveCredential(credential, deps.credentialPath);

  await advanceJournalToPhase(
    deps.journalPath,
    'enrolled',
    {
      installId: identity.installId,
      nodeTokenHash: identity.nodeTokenHash,
      sourceExePath: identity.sourceExePath ?? sourceExecutablePath,
      abiProfile,
      stagedExePath: deps.stagedExecutablePath,
      stagedReceipt,
      serverId: credential.serverId,
    },
    now,
  );

  return credential;
}
