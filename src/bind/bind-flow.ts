import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync as existsSyncFs, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { execSync } from 'child_process';
import logger from '../util/logger.js';

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
export async function bindFlow(bindUrl: string, deviceName?: string, opts?: { force?: boolean }): Promise<void> {
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
      await ensureTmux();
      await restartDaemon();
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

  // Install terminal multiplexer if missing (tmux on Unix, WezTerm on Windows)
  if (process.platform !== 'win32') {
    await ensureTmux();
  }

  // Install system service
  if (process.platform === 'darwin') {
    await installLaunchAgent();
    console.log('\nDaemon installed as a launch agent — starts automatically on login.');
  } else if (process.platform === 'linux') {
    await installSystemdService();
    console.log('\nDaemon installed as a systemd user service — starts automatically on login.');
  } else if (process.platform === 'win32') {
    await installWindowsStartup();
    console.log('\nDaemon installed as a startup shortcut — starts automatically on login.');
  } else {
    console.log('\nRun "imcodes start" to start the daemon.');
  }

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
        execSync('sudo systemctl restart imcodes', { stdio: 'ignore' });
      }
    } else if (process.platform === 'win32') {
      // Kill existing daemon via PID file (safe — doesn't affect other Node processes)
      const pidFile = join(homedir(), '.imcodes', 'daemon.pid');
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid) execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore' });
      } catch { /* not running */ }
      // Relaunch via startup script
      const startupCmd = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'imcodes-daemon.cmd');
      if (existsSyncFs(startupCmd)) {
        execSync(`"${startupCmd}"`, { stdio: 'ignore' });
      }
    }
    console.log('Daemon restarted.');
  } catch {
    console.log('Could not restart daemon automatically. Run "imcodes restart" manually.');
  }
}

async function installWindowsStartup(): Promise<void> {
  // Create a CMD batch in the user's Startup folder (less likely to trigger AV than VBS)
  const startupDir = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  await mkdir(startupDir, { recursive: true });
  // Remove old VBS if present (migration from previous approach)
  const oldVbs = join(startupDir, 'imcodes-daemon.vbs');
  try { await import('fs/promises').then((fs) => fs.unlink(oldVbs)); } catch { /* ignore */ }
  const cmdPath = join(startupDir, 'imcodes-daemon.cmd');
  // Use process.execPath for reliable Node resolution (works with nvm, pnpm, etc.)
  const nodeExe = process.execPath;
  const imcodesScript = join(__dirname, '..', 'index.js');
  const cmd = `@echo off\r\nstart /min "" "${nodeExe}" "${imcodesScript}" start\r\n`;
  await writeFile(cmdPath, cmd, 'utf8');
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
  const nodeExec = process.execPath;
  const script = process.argv[1];
  const logPath = join(CREDS_DIR, 'daemon.log');
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${script}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
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
  const nodeExec = process.execPath;
  const script = process.argv[1];
  const logPath = join(CREDS_DIR, 'daemon.log');
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(serviceDir, 'imcodes.service');

  const unit = `[Unit]
Description=IM.codes Daemon
After=network.target

[Service]
ExecStart=${nodeExec} ${script} start --foreground
Restart=always
RestartSec=5
KillMode=process
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${homedir()}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  await mkdir(serviceDir, { recursive: true });
  await writeFile(servicePath, unit, 'utf8');

  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync('systemctl --user enable --now imcodes', { stdio: 'inherit' });
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
