#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { bootstrapControlledNodeWithDisposition, defaultBootstrapDeps, journalPathFor, markServiceHealthy } from './bootstrap.js';
import { runComputerUseIpcHelper } from './computer-use-ipc.js';
import { createControlledNodeRuntime } from './runtime.js';
import { DAEMON_VERSION } from '../util/version.js';
import {
  controlledNodeHealthLeasePath,
  createControlledNodeHealthLeasePublisher,
  createSystemdWatchdogNotifier,
  runMacosControlledNodeHealthWatchdog,
} from './health-lease.js';
import { CONTROLLED_NODE_SERVICE } from './installer.js';
import { controlledNodeInstallStatus, isWindowsInstallerLaunch } from './windows-install-ui.js';

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
  const now = Date.now();
  const deps = defaultBootstrapDeps(now);
  if (isWindowsInstallerLaunch(process.platform, deps.sourceExecutablePath, deps.stagedExecutablePath)) {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    process.stdout.write(`${controlledNodeInstallStatus(locale)}\n`);
  }
  const bootstrap = await bootstrapControlledNodeWithDisposition(deps);
  if (bootstrap.disposition === 'handoff_complete') return;
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
  const runtime = createControlledNodeRuntime(bootstrap.credential, undefined, {
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

void main().catch((error) => {
  process.stderr.write(`imcodes-node: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export { journalPathFor };
