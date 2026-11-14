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
  enrollDirectV2,
  generateInstallIdentity,
  loadInstallIdentity,
  persistCredential,
  persistInstallIdentity,
  type ControlledNodeCredential,
} from './enrollment.js';
import {
  INSTALL_PHASES,
  loadInstallJournal,
  phaseIndex,
  writeInstallPhase,
  type InstallJournal,
  type InstallPhase,
} from './install-journal.js';
import type { LocalDaemonController } from './local-daemon-control.js';

export interface PendingDesktopSetupDeps {
  credentialPath: string;
  journalPath: string;
  stagedExecutablePath: string;
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
  daemonController: Pick<LocalDaemonController, 'performAction' | 'readSetupBindingInfo'>;
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
      ...(i >= phaseIndex('files_staged') && extra.stagedExePath ? { stagedExePath: extra.stagedExePath } : {}),
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

/**
 * Chained Desktop Phase 2B binding:
 * 1) Bind or reuse the interactive desktop user's Coding Daemon (~/.imcodes/server.json) to obtain hostServerId.
 * 2) Enroll this machine's Controlled Node + Remote Desktop via POST /api/enroll/v2/direct with hostServerId.
 * 3) Persist credential.json + advance install journal atomically.
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

  onStep?.('binding_daemon');
  let hostServerId: string | undefined;
  const existingDaemon = await daemonController.readSetupBindingInfo?.();
  if (
    existingDaemon?.bound
    && existingDaemon.serverId
    && normalizeOrigin(existingDaemon.workerUrl) === relayOrigin
  ) {
    hostServerId = existingDaemon.serverId;
    await daemonController.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START).catch(() => {});
  } else {
    const bindUrl = `${relayOrigin}/bind/${apiKey}`;
    const bindResult = await daemonController.performAction(
      REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND,
      { bindUrl },
    );
    if (bindResult.ok) {
      const updatedDaemon = await daemonController.readSetupBindingInfo?.();
      if (updatedDaemon?.serverId) {
        hostServerId = updatedDaemon.serverId;
      }
    } else if (
      bindResult.error !== REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NOT_INSTALLED
      && bindResult.error !== REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER
    ) {
      throw new Error(bindResult.error ?? 'daemon_bind_failed');
    }
  }

  onStep?.('enrolling_node');
  const identityPath = defaultInstallIdentityPath(deps.credentialPath);
  const existingIdentity = await loadInstallIdentity(identityPath);
  const identity = existingIdentity ?? {
    ...generateInstallIdentity(),
    sourceExePath: deps.stagedExecutablePath,
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
      sourceExePath: identity.sourceExePath ?? deps.stagedExecutablePath,
      abiProfile,
    },
    now,
  );

  const credential = await enrollDirectV2({
    relayUrl: relayOrigin,
    apiKey,
    identity,
    ...(hostServerId ? { hostServerId } : {}),
    abiProfile,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.arch ? { arch: deps.arch } : {}),
    ...(deps.hostname ? { hostname: deps.hostname } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });

  const saveCredential = deps.persistCredentialFn ?? persistCredential;
  await saveCredential(credential, deps.credentialPath);

  await advanceJournalToPhase(
    deps.journalPath,
    'enrolled',
    {
      installId: identity.installId,
      nodeTokenHash: identity.nodeTokenHash,
      sourceExePath: identity.sourceExePath ?? deps.stagedExecutablePath,
      abiProfile,
      stagedExePath: deps.stagedExecutablePath,
      serverId: credential.serverId,
    },
    now,
  );

  return credential;
}
