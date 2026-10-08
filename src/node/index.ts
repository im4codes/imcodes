#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { bootstrapControlledNodeWithDisposition, defaultBootstrapDeps, journalPathFor, markServiceHealthy } from './bootstrap.js';
import { runComputerUseIpcHelper } from './computer-use-ipc.js';
import { createMacosRemoteDesktopProductionDependencies } from './macos-remote-desktop-production.js';
import { createControlledNodeRuntime } from './runtime.js';
import { readPreviousUpgradeFailure } from './self-upgrade.js';
import {
  createRemoteDesktopSignedShellLauncher,
  resolveRemoteDesktopAccountShellArtifact,
} from './remote-desktop-signed-shell-host.js';
import { DAEMON_VERSION } from '../util/version.js';
import logger from '../util/logger.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import {
  controlledNodeHealthLeasePath,
  createControlledNodeHealthLeasePublisher,
  createControlledNodeLivenessPublisher,
  controlledNodeLivenessBackstopStatePath,
  readLivenessBackstopLevel,
  writeLivenessBackstopLevel,
  notifySystemdWatchdog,
  controlledNodeLivenessLeasePath,
  runMacosControlledNodeHealthWatchdog,
  waitForControlledNodeOnlineLease,
} from './health-lease.js';
import { CONTROLLED_NODE_SERVICE, isProcessElevated } from './installer.js';
import {
  ControlledNodeEndpointSelector,
  controlledNodeEndpointsPath,
  readEndpointState,
  writeEndpointState,
} from './server-endpoints.js';
import { defaultCredentialPath, defaultStagedExecutablePath, persistCredential, readEnrollmentBlob } from './enrollment.js';
import { createControlledNodeIdAdopter } from './controlled-node-id-adoption.js';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT, type RemoteDesktopLocalPermissionTarget } from '../../shared/remote-desktop-local-management.js';
import { openMacosPrivacyPane } from './macos-privacy-settings.js';
import {
  applyRemoteDesktopAccessPaused,
  loadRemoteDesktopAccessPaused,
} from './remote-desktop-access-state.js';
import {
  remoteDesktopManagementUrl,
  startRemoteDesktopLocalPanel,
} from './remote-desktop-local-panel.js';
import { startAideskLocalIpcServer } from './aidesk-local-ipc-server.js';
import { ensureAideskDesktopEntry } from './aidesk-desktop-entry.js';
import { startAideskLocalUiSidecarRefresh, warmAideskLocalUiVerification } from './aidesk-local-ui-sidecar.js';
import { startMacosAideskAppRefresh } from './macos-aidesk-app-refresh.js';
import { describeLocalPanelTiming, localPanelWindowHandlers, openAideskLocalPanel } from './local-panel-window-run.js';
import { LOCAL_PANEL_TIMING } from '../../shared/local-panel-window.js';
import {
  CONSOLE_HOLD,
  consoleHoldCountdown,
  consoleHoldMode,
  consoleHoldPrompt,
  CONTROLLED_NODE_INSTALL_WARNING_SECONDS,
  controlledNodeInstallCountdown,
  controlledNodeInstallDeclined,
  controlledNodeInstallWarning,
  controlledNodeInstallStatus,
  formatInstallFailure,
  formatInstallSuccess,
  isInstallerLaunch,
} from './install-report.js';

/**
 * Whether this process is the human-run installer, and which locale to speak.
 *
 * Captured at module scope because the terminal error handler below needs it
 * too: a failure raised before `main` reaches its own reporting still has to be
 * printed as a failure block rather than a bare stderr line.
 */
const installerLocale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
};
let installerLaunch = false;

/**
 * Hold the console open so a human can actually read the outcome.
 *
 * A double-clicked Windows installer owns its console window and destroys it on
 * exit, so without this the result is unreadable no matter how well it is
 * formatted. Only ever applied to an interactive installer launch: the service
 * has no stdin, and a background process must never block on one.
 */
async function holdConsoleForReader(): Promise<void> {
  const mode = consoleHoldMode({
    installerLaunch,
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
  });
  if (mode === 'none') return;
  const locale = installerLocale();

  if (mode === 'countdown') {
    // Console present but stdin is not readable, so there is no keypress to
    // wait for. Hold anyway: an unreadable result is the same as no result.
    const seconds = Math.round(CONSOLE_HOLD.COUNTDOWN_MS / 1000);
    process.stdout.write(`\n${consoleHoldCountdown(locale, seconds)}\n`);
    await new Promise<void>((resolve) => { setTimeout(resolve, CONSOLE_HOLD.COUNTDOWN_MS); });
    return;
  }

  process.stdout.write(`\n${consoleHoldPrompt(locale)}\n`);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', finish);
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('error', finish);
      process.stdin.pause();
      resolve();
    };
    // Bounded so an unattended run still terminates, but generous: the person
    // who started this may not be sitting at the machine.
    const timer = setTimeout(finish, CONSOLE_HOLD.KEYPRESS_TIMEOUT_MS);
    // `end`/`error` matter because a closed or broken stdin would otherwise
    // leave the process waiting out the whole timeout for a key that can never
    // arrive.
    process.stdin.once('data', finish);
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
    process.stdin.resume();
  });
}

/**
 * Show the scam warning and hold it on screen before any protected write.
 *
 * A countdown rather than a typed answer, because the installer must stay
 * usable where there is no keyboard on the other end -- `ssh` without a pty,
 * fleet provisioning -- and a gate a legitimate operator cannot pass is a gate
 * that gets removed. The cost is that silence proceeds, so the warning has to
 * do the work: it names the capability, names the pretexts, and gives an action
 * ("close this window and delete the download") rather than a caution.
 *
 * Any keypress cancels. That costs an unattended install nothing and gives a
 * person being talked at by a caller a one-key way out, which is easier to do
 * than typing while someone is telling you not to.
 */
async function warnBeforeInstall(): Promise<boolean> {
  // Read straight off this installer's own trailer: the origin the human is
  // about to hand the machine to is the one fact they can independently check,
  // and a tail read must never be able to fail the install.
  const blob = await readEnrollmentBlob(process.execPath).catch(() => null);
  const serverUrl = blob?.serverUrl;
  // Naming the exact Desk is strictly better than the product label alone, but
  // only when the installer actually carries it: an older installer has no name
  // and the consent block degrades to its unnamed wording rather than implying
  // a binding it cannot evidence.
  const ownerName = blob?.ownerName?.trim() || undefined;
  const locale = installerLocale();
  process.stdout.write(`${controlledNodeInstallWarning(locale, {
    ...(serverUrl ? { serverUrl } : {}),
    ...(ownerName ? { ownerName } : {}),
  })}\n`);

  const interactive = Boolean(process.stdin.isTTY);
  return new Promise<boolean>((resolve) => {
    let left = CONTROLLED_NODE_INSTALL_WARNING_SECONDS;
    let settled = false;
    const finish = (proceed: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      process.stdin.removeListener('data', onKey);
      if (interactive && process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(proceed);
    };
    const onKey = (): void => finish(false);
    const tick = (): void => {
      process.stdout.write(`\r${controlledNodeInstallCountdown(locale, left)}   `);
      if (left <= 0) finish(true);
      left -= 1;
    };
    const ticker = setInterval(tick, 1_000);
    tick();
    // Raw mode so a single key cancels without waiting for Enter. Only a real
    // terminal has it; a pipe simply never delivers a key and the timer wins.
    if (interactive && process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', onKey);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return;
  }
  if (process.argv[2] === '--computer-use-helper') {
    const pipeFlag = process.argv.indexOf('--pipe');
    const pipe = pipeFlag >= 0 ? process.argv[pipeFlag + 1] : undefined;
    if (!pipe) throw new Error('missing --pipe for computer-use helper');
    await runComputerUseIpcHelper(pipe);
    return;
  }
  if (process.argv[2] === '--health-watchdog') {
    if (process.platform !== 'darwin') throw new Error('--health-watchdog is macOS-only');
    const result = await runMacosControlledNodeHealthWatchdog({
      journalPath: journalPathFor(),
      restartService: () => {
        execFileSync('launchctl', [
          'kickstart', '-k', `system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}`,
        ], { stdio: 'ignore' });
      },
    });
    if (result.restarted) {
      process.stderr.write(`imcodes-node: restarted unhealthy controlled node (${result.reason})\n`);
    }
    return;
  }
  if (process.argv[2] === 'set-server-url') {
    const { runServerUrlCommand } = await import('./server-url-cli.js');
    process.exitCode = await runServerUrlCommand(process.argv.slice(3), {
      isElevated: () => isProcessElevated(),
      endpointsPath: controlledNodeEndpointsPath(journalPathFor()),
      stdout: (text) => { process.stdout.write(text); },
      stderr: (text) => { process.stderr.write(text); },
    });
    return;
  }
  if (process.argv[2] === LOCAL_PANEL_TIMING.CLI_FLAG) {
    process.stdout.write(`${describeLocalPanelTiming()}\n`);
    return;
  }
  if (process.argv[2] === '--open-local-panel') {
    await openAideskLocalPanel();
    return;
  }
  // Decided before any other install work, so that a failure raised while
  // building deps is still reported as an install failure rather than a bare
  // stderr line nobody sees.
  installerLaunch = isInstallerLaunch(
    process.platform, process.execPath, defaultStagedExecutablePath(),
  );
  if (installerLaunch && !await warnBeforeInstall()) {
    process.stdout.write(`${controlledNodeInstallDeclined(installerLocale())}\n`);
    await holdConsoleForReader();
    return;
  }
  const now = Date.now();
  const deps = defaultBootstrapDeps(now);
  if (installerLaunch) {
    process.stdout.write(`${controlledNodeInstallStatus(installerLocale())}\n`);
  }
  const bootstrap = await bootstrapControlledNodeWithDisposition(deps);
  if (installerLaunch && bootstrap.disposition === 'handoff_complete'
    && (process.platform === 'win32' || process.platform === 'darwin')) {
    // Registration and Task Scheduler/launchd acceptance are not proof that
    // the staged service started or authenticated. Do not print a green
    // success block while the web UI still shows the node offline.
    await waitForControlledNodeOnlineLease(controlledNodeHealthLeasePath(deps.journalPath));
  }
  if (installerLaunch) {
    // The install is only "done" once a credential exists; report it on every
    // platform, on both the freshly-enrolled and already-enrolled paths.
    process.stdout.write(`${formatInstallSuccess(installerLocale(), {
      displayName: bootstrap.credential.displayName,
      refName: bootstrap.credential.refName,
      serverUrl: bootstrap.credential.serverUrl,
      publisherTrustError: bootstrap.publisherTrustError,
    })}\n`);
  }
  if (bootstrap.disposition === 'handoff_complete') {
    await holdConsoleForReader();
    return;
  }
  // A failing health-signal write repeats every 15 s for as long as it fails: report it once an hour, not 5,760 times a day.
  const reportHealthError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    if (warnOncePerHour('node_health_signal_publish_failed', { message })) {
      process.stderr.write(`imcodes-node: failed to publish authenticated health signal (${message})\n`);
    }
  };
  // Two signals, deliberately separate. The health lease is written ONLY on an authenticated server acknowledgement:
  // a self-upgrade judges its new node by it. The liveness publisher (the liveness lease file and, on Linux, the systemd
  // watchdog pulse) says "this process is alive and its connection machinery is working" and keeps being renewed while
  // the server is unreachable: a network outage must not make the platform watchdog kill and restart the node.
  const supportsHealthSignals = process.platform === 'linux' || process.platform === 'win32' || process.platform === 'darwin';
  const healthLease = supportsHealthSignals
    ? createControlledNodeHealthLeasePublisher(controlledNodeHealthLeasePath(deps.journalPath), { onError: reportHealthError })
    : undefined;
  const backstopStatePath = controlledNodeLivenessBackstopStatePath(deps.journalPath);
  const liveness = supportsHealthSignals
    ? createControlledNodeLivenessPublisher({
      backstopLevel: await readLivenessBackstopLevel(backstopStatePath),
      path: controlledNodeLivenessLeasePath(deps.journalPath),
      ...(process.platform === 'linux' ? { notifyWatchdog: notifySystemdWatchdog } : {}),
      onError: reportHealthError,
      onBackstop: (unackedForMs, nextLevel) => {
        logger.error({ unackedForMs, nextLevel }, 'controlled node: sockets keep opening but the server never acknowledged this node; the watchdog will restart it');
        void writeLivenessBackstopLevel(backstopStatePath, nextLevel).catch(() => {});
      },
      onBackstopCleared: () => { void writeLivenessBackstopLevel(backstopStatePath, 0).catch(() => {}); },
      onUnreachable: (silentForMs) => {
        // `runtime` exists by the time this fires (minutes after start).
        const status = runtime.connectionStatus();
        logger.warn({
          silentForMs,
          target: status.target,
          failureClass: status.failureClass,
          consecutiveFailures: status.consecutiveFailures,
        }, 'controlled node has not been acknowledged by the server for a while (the node keeps retrying; the platform watchdog is not restarting it)');
      },
    })
    : undefined;
  liveness?.start();
  // The addresses the node may dial: its enrolled one, plus root-pinned and server-advertised alternates (a damaged file = none).
  const endpointsPath = controlledNodeEndpointsPath(deps.journalPath);
  const endpoints = new ControlledNodeEndpointSelector(
    bootstrap.credential.serverUrl,
    await readEndpointState(endpointsPath),
    {
      reload: () => readEndpointState(endpointsPath),
      // The node owns advertised/lastGood/dropped; the root's pinned list is re-read from disk so a concurrent edit is never lost.
      persist: async (state) => {
        const onDisk = await readEndpointState(endpointsPath);
        await writeEndpointState(endpointsPath, { ...state, pinned: onDisk.pinned });
      },
      onRotate: ({ from, to, reason }) => {
        logger.warn({ from, to, reason }, 'controlled node switches to another server address');
      },
    },
  );
  const signedShellArtifact = resolveRemoteDesktopAccountShellArtifact();
  const macosRemoteDesktopWorker = process.platform === 'darwin'
    && (process.arch === 'arm64' || process.arch === 'x64')
    ? createMacosRemoteDesktopProductionDependencies({
      // Every failure inside the macOS adapter is reported through this, and it
      // was not wired: the adapter could fail to start, fail to find its
      // components, or fail to raise a permission prompt, and not one line
      // reached the log. That silence is why a button that did nothing looked
      // like a button nobody had pressed.
      onBackgroundError: (error) => {
        logger.warn({ err: error }, 'macOS remote-desktop adapter error');
      },
    })
    : undefined;
  const remoteDesktopAccessPaused = await loadRemoteDesktopAccessPaused();
  const adoptAssignedNodeId = bootstrap.credential.nodeId
    ? undefined
    : createControlledNodeIdAdopter({
      credential: bootstrap.credential,
      persist: (credential) => persistCredential(credential, defaultCredentialPath()),
      start: (nodeId) => startLocalManagement(nodeId),
      log: logger,
    });
  const runtime = createControlledNodeRuntime(bootstrap.credential, undefined, {
    macosRemoteDesktopWorker,
    remoteDesktopSignedShell: signedShellArtifact ? {
      available: () => true,
      executablePath: signedShellArtifact.executablePath,
      launcher: createRemoteDesktopSignedShellLauncher(signedShellArtifact),
    } : undefined,
    onAuthenticated: () => markServiceHealthy(deps.journalPath, Date.now(), {
      isStableRuntime: deps.isStableRuntime,
      inspectServiceState: deps.inspectServiceState,
    }),
    onAuthenticationError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`imcodes-node: failed to record service_healthy (${message})\n`);
    },
    onHeartbeatAck: () => {
      liveness?.recordAuthenticatedHeartbeat();
      healthLease?.recordAuthenticatedHeartbeat();
    },
    onConnectionActivity: liveness?.recordConnectionActivity,
    endpoints,
    ...(adoptAssignedNodeId ? { onAssignedIdentity: adoptAssignedNodeId } : {}),
    readPreviousUpgradeFailure: () => readPreviousUpgradeFailure(deps.journalPath),
    remoteDesktopAccessPaused,
  });
  // The local management surface (the panel the indicator opens, and the local aiDesk IPC) is keyed by the node's public ID. A node
  // enrolled before that ID existed learns it from the server's heartbeat ack and starts the surface then, in this very process.
  let localPanel: Awaited<ReturnType<typeof startRemoteDesktopLocalPanel>> | null = null;
  let localIpc: Awaited<ReturnType<typeof startAideskLocalIpcServer>> | null = null;
  async function startLocalManagement(nodeId: string): Promise<void> {
    localPanel = await startRemoteDesktopLocalPanel({
      publicNodeId: nodeId,
      serverUrl: bootstrap.credential.serverUrl,
      status: () => runtime.remoteDesktopAccessStatus(),
      extras: () => {
        const connection = runtime.connectionStatus();
        return {
          ...runtime.remoteDesktopLocalExtras(),
          version: DAEMON_VERSION,
          ...(connection.state === 'unreachable' && connection.failureClass
            ? { serverConnection: { target: connection.target, reason: connection.failureClass } }
            : {}),
        };
      },
      ...(process.platform === 'darwin' ? { openSettings: (target: RemoteDesktopLocalPermissionTarget) => openMacosPrivacyPane(target) } : {}),
      setPaused: (paused) => applyRemoteDesktopAccessPaused(
        paused,
        (next) => runtime.setRemoteDesktopAccessPaused(next),
      ),
      stopAll: () => runtime.stopAllRemoteDesktopConnections(),
      disconnect: (publicId) => runtime.stopRemoteDesktopConnection(publicId),
      ...localPanelWindowHandlers(bootstrap.credential.serverUrl, nodeId),
    }).catch((error) => {
      logger.warn({ err: error, host: REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST, port: REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT },
        'local remote-desktop management panel unavailable (the indicator will not be able to open it)');
      return null;
    });
    localIpc = await startAideskLocalIpcServer({
      publicNodeId: nodeId,
      managementUrl: remoteDesktopManagementUrl(bootstrap.credential.serverUrl, nodeId, 'manage'),
      shareUrl: remoteDesktopManagementUrl(bootstrap.credential.serverUrl, nodeId, 'share'),
      runtimeVersion: DAEMON_VERSION,
      productVersion: DAEMON_VERSION,
      status: () => runtime.remoteDesktopAccessStatus(),
      setPaused: (paused) => applyRemoteDesktopAccessPaused(
        paused,
        (next) => runtime.setRemoteDesktopAccessPaused(next),
      ),
      stopAll: () => runtime.stopAllRemoteDesktopConnections(),
      disconnect: (connectionId) => runtime.stopRemoteDesktopConnection(connectionId),
    }).catch((error) => {
      // The existing panel, admission gate and worker stay available if the
      // optional native-UI IPC surface cannot be created.
      logger.warn({ err: error }, 'local aiDesk IPC service unavailable');
      return null;
    });
  }
  if (bootstrap.credential.nodeId) await startLocalManagement(bootstrap.credential.nodeId);
  void ensureAideskDesktopEntry().then((result) => {
    if (result === 'preserved') {
      logger.warn('existing user-created aiDesk desktop entry was preserved');
    } else if (result === 'failed' || result === 'unavailable') {
      logger.warn({ result }, 'aiDesk desktop entry unavailable');
    } else if (result !== 'unchanged') {
      logger.info({ result }, 'aiDesk desktop entry updated');
    }
  }).catch((error) => {
    logger.warn({ err: error }, 'aiDesk desktop entry unavailable');
  });
  // The Windows panel window host (a signed WebView2 exe) is its own sidecar: refreshed here, apart from the node's upgrade, and never
  // able to fail the node (every outcome is a logged reason; failures back off).
  const stopAideskLocalUiRefresh = startAideskLocalUiSidecarRefresh({ credential: bootstrap.credential });
  // The installed host is verified once here, off the click path (a click then only compares the file to the proof this leaves).
  const stopAideskLocalUiWarm = warmAideskLocalUiVerification();
  // macOS: a newly installed aiDesk app only takes effect when the old menu-bar process is replaced. Done here when it is safe (no active
  // remote-desktop connection), logged by reason, capped per version; a no-op on other platforms.
  const stopMacosAideskAppRefresh = startMacosAideskAppRefresh({ activeConnections: () => runtime.remoteDesktopAccessStatus().connections.length });
  runtime.start();
  const stop = () => {
    stopAideskLocalUiRefresh();
    stopAideskLocalUiWarm();
    stopMacosAideskAppRefresh();
    void localIpc?.close().catch(() => {});
    void localPanel?.close().catch(() => {});
    runtime.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(async (error) => {
  process.exitCode = 1;
  // Always emit the machine-greppable line: logs, service managers and support
  // scripts key on it, and it stays useful when there is no console at all.
  process.stderr.write(`imcodes-node: ${error instanceof Error ? error.message : String(error)}\n`);
  if (!installerLaunch) return;
  process.stderr.write(`${formatInstallFailure(installerLocale(), process.platform, error)}\n`);
  await holdConsoleForReader();
});

export { journalPathFor };
