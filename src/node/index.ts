#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { bootstrapControlledNodeWithDisposition, defaultBootstrapDeps, journalPathFor, markServiceHealthy } from './bootstrap.js';
import { runComputerUseIpcHelper } from './computer-use-ipc.js';
import { createMacosRemoteDesktopProductionDependencies } from './macos-remote-desktop-production.js';
import { createControlledNodeRuntime } from './runtime.js';
import {
  createRemoteDesktopSignedShellLauncher,
  resolveRemoteDesktopAccountShellArtifact,
} from './remote-desktop-signed-shell-host.js';
import { DAEMON_VERSION } from '../util/version.js';
import {
  controlledNodeHealthLeasePath,
  createControlledNodeHealthLeasePublisher,
  createSystemdWatchdogNotifier,
  runMacosControlledNodeHealthWatchdog,
} from './health-lease.js';
import { CONTROLLED_NODE_SERVICE } from './installer.js';
import { defaultStagedExecutablePath, readEnrollmentBlob } from './enrollment.js';
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
  const serverUrl = await readEnrollmentBlob(process.execPath)
    .then((blob) => blob?.serverUrl)
    .catch(() => undefined);
  const locale = installerLocale();
  process.stdout.write(`${controlledNodeInstallWarning(locale, {
    ...(serverUrl ? { serverUrl } : {}),
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
  const reportHealthError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`imcodes-node: failed to publish authenticated health signal (${message})\n`);
  };
  const healthLease = process.platform === 'linux'
    ? createSystemdWatchdogNotifier({ onError: reportHealthError })
    : process.platform === 'win32' || process.platform === 'darwin'
      ? createControlledNodeHealthLeasePublisher(controlledNodeHealthLeasePath(deps.journalPath), {
        onError: reportHealthError,
      })
      : undefined;
  const signedShellArtifact = resolveRemoteDesktopAccountShellArtifact();
  const macosRemoteDesktopWorker = process.platform === 'darwin'
    && (process.arch === 'arm64' || process.arch === 'x64')
    ? createMacosRemoteDesktopProductionDependencies()
    : undefined;
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
    onHeartbeatAck: healthLease?.recordAuthenticatedHeartbeat,
  });
  runtime.start();
  const stop = () => {
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
