import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync as existsSyncFs } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { execSync } from 'child_process';
import logger from '../util/logger.js';
import { BACKEND } from '../agent/tmux.js';
import { restartWindowsDaemon } from '../util/windows-daemon.js';
import { resolveDaemonLaunchTarget, renderSystemdExecStart, renderPlistProgramArguments } from '../util/launch-target.js';
import { enableSystemdUserLinger, formatSystemdLingerFailureMessage } from '../util/systemd-linger.js';

const CREDS_DIR = join(homedir(), '.imcodes');
const CREDS_PATH = join(CREDS_DIR, 'server.json');
const PLIST_LABEL = 'imcodes.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const OLD_PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', 'cc.imcodes.daemon.plist');

interface ServerCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
  serverName: string;
  boundAt: number;
}

/**
 * Main entry point.
 * Usage: imcodes bind https://app.im.codes/bind/<apiKey> [device-name]
 */
export async function bindFlow(bindUrl: string, deviceName?: string, _opts?: { force?: boolean }): Promise<void> {
  // Parse the bind URL
  let url: URL;
  try {
    url = new URL(bindUrl);
  } catch {
    console.error('Invalid URL. Usage: imcodes bind https://app.im.codes/bind/<api-key> [device-name]');
    process.exit(1);
  }

  const pathParts = url.pathname.split('/').filter(Boolean); // ['bind', '<apiKey>']
  if (pathParts[0] !== 'bind' || !pathParts[1]) {
    console.error('Invalid bind URL format. Expected: https://<worker>/bind/<api-key>');
    process.exit(1);
  }

  const apiKey = pathParts[1];
  const workerUrl = url.origin;
  const serverName = deviceName ?? hostname();

  // Check if already bound
  const existing = await loadCredentials();
  if (existing && existing.workerUrl === workerUrl) {
    // Verify if current token is still valid
    const verifyRes = await fetch(`${workerUrl}/api/bind/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: existing.serverId, token: existing.token }),
    }).catch(() => null);

    if (verifyRes?.ok) {
      // Already bound — auto-rebind to update the token and name
      console.log(`Already bound as "${existing.serverName}". Re-binding as "${serverName}"...`);
      const rebindRes = await fetch(`${workerUrl}/api/bind/rebind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ serverId: existing.serverId, serverName }),
      });
      if (!rebindRes.ok) {
        const body = await rebindRes.text().catch(() => '');
        console.error(`Rebind failed: ${rebindRes.status} ${body}`);
        process.exit(1);
      }
      const { token } = await rebindRes.json() as { token: string };
      const creds: ServerCredentials = { serverId: existing.serverId, token, workerUrl, serverName, boundAt: Date.now() };
      await mkdir(CREDS_DIR, { recursive: true });
      await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
      console.log(`\nRe-bound! Device "${serverName}" updated.`);
      await ensureServiceInstalled();
      restartDaemon();
      return;
    }
    // Token invalid (server deleted) — fall through to normal bind but keep same serverId not possible,
    // so just create a new server entry
    console.log('Previous bind is no longer valid (server was deleted). Creating new server entry...');
  }

  console.log(`Binding "${serverName}" to ${workerUrl}...`);

  // One-shot bind — no code dance needed
  const res = await fetch(`${workerUrl}/api/bind/direct`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ serverName }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Bind failed: ${res.status} ${body}`);
    process.exit(1);
  }

  const { serverId, token } = await res.json() as { serverId: string; token: string };

  // Save credentials (0600 permissions)
  const creds: ServerCredentials = { serverId, token, workerUrl, serverName, boundAt: Date.now() };
  await mkdir(CREDS_DIR, { recursive: true });
  await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  logger.info({ serverId, serverName }, 'Daemon bound');

  await ensureServiceInstalled();

  console.log(`\nBound! Device "${serverName}" is ready.`);
  console.log(`Open ${workerUrl} to see it online.`);
}

function restartDaemon(): void {
  try {
    if (process.platform === 'darwin') {
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
      execSync(`launchctl unload "${plist}" 2>/dev/null; launchctl load -w "${plist}"`, { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      const userService = join(homedir(), '.config/systemd/user/imcodes.service');
      if (existsSyncFs(userService)) {
        execSync('systemctl --user restart imcodes', { stdio: 'ignore' });
      } else {
        throw new Error('No user service found');
      }
    } else if (process.platform === 'win32') {
      if (!restartWindowsDaemon()) throw new Error('watchdog not available');
    }
    console.log('Daemon restarted.');
  } catch {
    console.log('Could not restart daemon automatically. Run "imcodes restart" manually.');
  }
}

// writeWindowsWatchdogFiles now delegates to the centralized launch-artifacts module.
async function writeWindowsWatchdogFiles(): Promise<void> {
  const { resolveLaunchPaths, writeWatchdogCmd, writeVbsLauncher, rotateWatchdogLog } = await import('../util/windows-launch-artifacts.js');
  const paths = resolveLaunchPaths();
  await writeWatchdogCmd(paths);
  await writeVbsLauncher(paths);
  await rotateWatchdogLog(paths);
}

async function installWindowsStartup(): Promise<void> {
  await writeWindowsWatchdogFiles();

  // Remove legacy Startup folder CMD/VBS if present
  const startupDir = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  for (const old of ['imcodes-daemon.cmd', 'imcodes-daemon.vbs']) {
    try { await import('fs/promises').then((fs) => fs.unlink(join(startupDir, old))); } catch { /* ignore */ }
  }

  // Replace legacy ONLOGON-only registrations with a durable Task Scheduler
  // definition: boot + logon + one-minute liveness trigger, direct ownership
  // of the waiting VBS/watchdog process, and failure restart policy.
  const { installWindowsScheduledTask, resolveLaunchPaths } = await import('../util/windows-launch-artifacts.js');
  const paths = resolveLaunchPaths();
  if (!installWindowsScheduledTask(paths)) {
    // schtasks may require elevation — fall back to startup folder CMD
    console.warn('Task Scheduler registration failed (may need admin). Falling back to Startup folder.');
    await mkdir(startupDir, { recursive: true });
    const cmdPath = join(startupDir, 'imcodes-daemon.cmd');
    const cmd = `@echo off\r\nchcp 65001 >nul 2>&1\r\nstart "" /min wscript "${paths.vbsPath}"\r\n`;
    await writeFile(cmdPath, cmd, 'utf8');
    return;
  }
}

/** Ensure terminal backend + system service are installed. Shared by bind and re-bind. */
async function ensureServiceInstalled(): Promise<void> {
  if (process.platform === 'win32') {
    if ((BACKEND as string) !== 'conpty') {
      await ensureWezTerm();
    }
    // ConPTY is built-in on Windows 10+, nothing to install
  } else {
    await ensureTmux();
  }

  if (process.platform === 'darwin') {
    await installLaunchAgent();
    console.log('\nDaemon installed as a launch agent — starts automatically on login.');
  } else if (process.platform === 'linux') {
    await installSystemdService();
    console.log('\nDaemon installed as a systemd user service — starts automatically on login.');
  } else if (process.platform === 'win32') {
    await installWindowsStartup();
    console.log('\nDaemon installed as a scheduled watchdog — starts at boot/logon and self-recovers.');
    // Immediately start the daemon (don't wait for next login).  Use the
    // single reusable ensureDaemonRunning() that handles all edge cases:
    // orphan daemons holding the named pipe, crash-loop watchdogs, etc.
    const { ensureDaemonRunning } = await import('../util/windows-daemon.js');
    if (ensureDaemonRunning(process.pid)) {
      console.log('Daemon started.');
    } else {
      console.log('Note: Daemon task installed but did not become healthy; run "imcodes repair-watchdog" as administrator.');
    }
  } else {
    console.log('\nRun "imcodes start" to start the daemon.');
  }
}

async function ensureWezTerm(): Promise<void> {
  try {
    execSync('wezterm --version', { stdio: 'ignore' });
    return;
  } catch {
    // not found
  }
  console.error('\n╭─────────────────────────────────────────────────────╮');
  console.error('│  WezTerm is required on Windows                     │');
  console.error('╰─────────────────────────────────────────────────────╯');
  console.error('\nInstall via winget (recommended):');
  console.error('  winget install wez.wezterm\n');
  console.error('Or via Chocolatey:');
  console.error('  choco install wezterm\n');
  console.error('Or download manually:');
  console.error('  https://wezfurlong.org/wezterm/installation.html\n');
  console.error('After installing, add WezTerm to PATH:');
  console.error('  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\\Program Files\\WezTerm", "User")\n');
  console.error('Then restart your terminal and re-run:');
  console.error('  imcodes bind <url>\n');
  process.exit(1);
}

async function ensureTmux(): Promise<void> {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return; // already installed
  } catch {
    // not found
  }

  if (process.platform === 'darwin') {
    // Check brew is available
    try {
      execSync('which brew', { stdio: 'ignore' });
    } catch {
      console.error('tmux not found and Homebrew is not installed. Please install tmux manually: https://formulae.brew.sh/formula/tmux');
      process.exit(1);
    }
    console.log('tmux not found — installing via Homebrew...');
    execSync('brew install tmux', { stdio: 'inherit' });
    console.log('tmux installed.');
  } else {
    console.error('tmux not found. Please install it with your package manager (e.g. apt install tmux).');
    process.exit(1);
  }
}

async function installLaunchAgent(): Promise<void> {
  const logPath = join(CREDS_DIR, 'daemon.log');
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

  // Prefer the self-healing launcher when this install ships it. See
  // `src/util/launch-target.ts` for rationale.
  const target = resolveDaemonLaunchTarget();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${renderPlistProgramArguments(target)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
    <!-- See bind-flow.ts.installSystemdService for rationale on these flags
         (V8 lazy-GC + heap-limit OOM cascade observed on production daemons). -->
    <key>NODE_OPTIONS</key>
    <string>--expose-gc --max-old-space-size=8192</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;

  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(PLIST_PATH, plist, 'utf8');

  // Migrate: unload and remove old cc.imcodes.daemon plist if present
  const { existsSync, unlinkSync } = await import('fs');
  if (existsSync(OLD_PLIST_PATH)) {
    try { execSync(`launchctl unload "${OLD_PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ok */ }
    try { unlinkSync(OLD_PLIST_PATH); } catch { /* ok */ }
    console.log('Removed old cc.imcodes.daemon.plist');
  }

  // Unload existing (ignore error), then load fresh
  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ok */ }
  execSync(`launchctl load -w "${PLIST_PATH}"`);
  console.log(`Launch agent loaded: ${PLIST_PATH}`);
}

async function installSystemdService(): Promise<void> {
  const logPath = join(CREDS_DIR, 'daemon.log');
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(serviceDir, 'imcodes.service');

  // Prefer the self-healing launcher when this install ships it. See
  // `src/util/launch-target.ts` for rationale.
  const target = resolveDaemonLaunchTarget();

  const unit = `[Unit]
Description=IM.codes Daemon
After=network.target

[Service]
ExecStart=${renderSystemdExecStart(target)}
Restart=always
RestartSec=5
KillMode=process
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${homedir()}
# --expose-gc lets the daemon's startGcPoller proactively trigger major
# GC, keeping RSS bounded near the live working set. Without this flag,
# V8 lazy major GC lets old-gen garbage accumulate to many GB before
# collection. Observed 779 MB of unreachable garbage freed in a single
# GC cycle on a self-hosted production daemon (211, 2026-05-10),
# correlating with the OOM cascade behind the always-offline symptom.
# --max-old-space-size=8192 raises the V8 heap ceiling from the 4 GB
# default so transient working-set spikes (transformers tokenizer,
# large timeline batches) cannot OOM during the GC poll interval.
# Both can be overridden via a drop-in.
Environment="NODE_OPTIONS=--expose-gc --max-old-space-size=8192"
# MALLOC_ARENA_MAX=2 caps glibc's per-thread malloc arenas. On multi-core
# hosts glibc permits up to 8×cores arenas; native thread pools
# (onnxruntime embedding inference, sharp/libvips image work) scatter
# allocations across ~64 MB arenas that are never returned to the OS, so
# RSS plateaus near ~1 GB while V8 heapUsed is only ~250 MB and forced GC
# cannot move it (measured on 215, 24 cores, 2026-05-31). Caps the count
# at 2. glibc-only (no-op on macOS) and unsettable from JS — glibc reads
# it at process init — so it MUST live in the unit environment.
Environment="MALLOC_ARENA_MAX=2"
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  await mkdir(serviceDir, { recursive: true });
  await writeFile(servicePath, unit, 'utf8');

  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync('systemctl --user enable --now imcodes', { stdio: 'inherit' });

  const linger = enableSystemdUserLinger();
  if (linger.ok) {
    console.log(`Systemd user-linger enabled for ${linger.user} (daemon survives logout).`);
  } else {
    console.log(`Note: ${formatSystemdLingerFailureMessage(linger.user)}`);
    console.log('The daemon may stop when you log out until this is fixed.');
  }
  console.log(`Systemd user service installed: ${servicePath}`);
}

export async function loadCredentials(): Promise<ServerCredentials | null> {
  try {
    const raw = await readFile(CREDS_PATH, 'utf8');
    return JSON.parse(raw) as ServerCredentials;
  } catch {
    return null;
  }
}
