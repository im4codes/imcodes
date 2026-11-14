import {
  CONTROLLED_NODE_RUNTIME_ABI_PROFILE,
  type ControlledNodeAbiProfile,
} from '../../shared/controlled-node-abi.js';
import type { DesktopSetupStep } from '../../shared/desktop-setup-auth.js';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
} from '../../shared/remote-desktop-local-management.js';
import {
  defaultInstallIdentityPath,
  defaultPendingDaemonBindPath,
  enrollDirectV2,
  generateInstallIdentity,
  inspectExecutableReceipt,
  loadInstallIdentity,
  loadPendingDaemonBind,
  openVerifiedEnrollmentSource,
  persistCredential,
  persistInstallIdentity,
  persistPendingDaemonBind,
  removePendingDaemonBind,
  type ControlledNodeCredential,
  type PendingDaemonBindRecord,
  type PendingInstallIdentity,
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
  pendingBindPath?: string;
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

function canReusePendingDaemonBind(
  pendingBind: PendingDaemonBindRecord | null,
  opts: {
    relayOrigin: string;
    existingIdentity: PendingInstallIdentity | null;
    activeUserKey?: string | null;
  },
): pendingBind is PendingDaemonBindRecord {
  if (!pendingBind || !opts.existingIdentity) return false;
  if (normalizeOrigin(pendingBind.relayOrigin) !== opts.relayOrigin) return false;
  if (pendingBind.installId !== opts.existingIdentity.installId) return false;
  if (pendingBind.nodeTokenHash !== opts.existingIdentity.nodeTokenHash) return false;
  if (opts.activeUserKey) {
    if (pendingBind.activeUserKey && pendingBind.activeUserKey !== opts.activeUserKey) return false;
    if (pendingBind.prepared.activeUserKey && pendingBind.prepared.activeUserKey !== opts.activeUserKey) return false;
  }
  return true;
}

/**
 * Chained Desktop Phase 2B binding:
 * 1) Prepare Coding Daemon bind/reuse and persist pending bind record at 0600 before enrollment so retries reuse the same hostServerId.
 * 2) Stage/verify real trailer-free executable and advance install journal to files_staged (with stagedReceipt) BEFORE saving credential.json.
 * 3) Enroll Controlled Node via POST /api/enroll/v2/direct, commit daemon bind (with automatic rollback on failure), persist credential.json, advance journal to enrolled, and clear pending bind.
 */
export async function executePendingDesktopSetup({
  relayOrigin,
  apiKey,
  daemonController,
  deps,
  onStep,
}: ExecutePendingDesktopSetupInput): Promise<ControlledNodeCredential> {
  const now = deps.now ?? (() => Date.now());
  const normalizedRelayOrigin = normalizeOrigin(relayOrigin) ?? relayOrigin;
  const abiProfile = deps.abiProfile ?? CONTROLLED_NODE_RUNTIME_ABI_PROFILE;
  const sourceExecutablePath = deps.sourceExecutablePath ?? process.execPath;
  const identityPath = defaultInstallIdentityPath(deps.credentialPath);
  const pendingBindPath = deps.pendingBindPath ?? defaultPendingDaemonBindPath(deps.credentialPath);

  onStep?.('binding_daemon');
  let hostServerId: string | undefined;
  let preparedBind: PreparedDaemonBind | null = null;
  let reusedPendingBind = false;
  const existingDaemon = await daemonController.readSetupBindingInfo?.();
  if (existingDaemon?.activeUserKey === null) {
    throw new Error(REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER);
  }
  if (existingDaemon?.daemonInstalled === false) {
    throw new Error(REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED);
  }
  const existingIdentity = await loadInstallIdentity(identityPath);
  const existingPendingBind = await loadPendingDaemonBind(pendingBindPath);

  if (
    existingDaemon?.bound
    && existingDaemon.serverId
    && normalizeOrigin(existingDaemon.workerUrl) === normalizedRelayOrigin
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
  } else if (canReusePendingDaemonBind(existingPendingBind, {
    relayOrigin: normalizedRelayOrigin,
    existingIdentity,
    activeUserKey: existingDaemon?.activeUserKey,
  })) {
    preparedBind = { ...existingPendingBind.prepared };
    hostServerId = preparedBind.serverId;
    reusedPendingBind = true;
  } else {
    const bindUrl = `${normalizedRelayOrigin}/bind/${apiKey}`;
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
  const identity = existingIdentity ?? {
    ...generateInstallIdentity(),
    sourceExePath: sourceExecutablePath,
  };
  if (!existingIdentity) {
    await persistInstallIdentity(identity, identityPath);
  }

  if (preparedBind && !reusedPendingBind) {
    const activeUserKey = preparedBind.activeUserKey ?? existingDaemon?.activeUserKey ?? undefined;
    await persistPendingDaemonBind(
      {
        version: 1,
        relayOrigin: normalizedRelayOrigin,
        installId: identity.installId,
        nodeTokenHash: identity.nodeTokenHash,
        ...(activeUserKey ? { activeUserKey } : {}),
        prepared: { ...preparedBind },
        createdAt: now(),
      },
      pendingBindPath,
    );
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

  const stagedReceipt = await resolveOrStageExecutableReceipt(
    deps.stagedExecutablePath,
    identity.sourceExePath ?? sourceExecutablePath,
  );

  let journal = await advanceJournalToPhase(
    deps.journalPath,
    'files_staged',
    {
      installId: identity.installId,
      nodeTokenHash: identity.nodeTokenHash,
      sourceExePath: identity.sourceExePath ?? sourceExecutablePath,
      abiProfile,
      stagedExePath: deps.stagedExecutablePath,
      stagedReceipt,
    },
    now,
  );
  if (journal.phase === 'files_staged' && !journal.stagedReceipt) {
    journal = await writeInstallPhase(deps.journalPath, 'files_staged', {
      now: now(),
      previous: journal,
      stagedExePath: deps.stagedExecutablePath,
      stagedReceipt,
    });
  }

  const credential = await enrollDirectV2({
    relayUrl: normalizedRelayOrigin,
    apiKey,
    identity,
    hostServerId,
    abiProfile,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.arch ? { arch: deps.arch } : {}),
    ...(deps.hostname ? { hostname: deps.hostname } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });

  if (preparedBind) {
    if (!daemonController.commitBind) {
      throw new Error('daemon_bind_failed');
    }
    const commitResult = await daemonController.commitBind(preparedBind);
    if (!commitResult.ok) {
      throw new Error(commitResult.error ?? 'daemon_bind_failed');
    }
  }

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

  await removePendingDaemonBind(pendingBindPath).catch(() => {});

  return credential;
}
