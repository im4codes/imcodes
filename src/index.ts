#!/usr/bin/env node
// ── GLOBAL ERROR HANDLERS — registered FIRST, before anything else ────────
// The daemon must NEVER die from an unhandled error. node-pty in particular
// throws synchronously from socket event handlers (e.g. resize on a dead pty)
// which propagates as uncaughtException.  These handlers MUST be installed
// before any module imports that might trigger such errors.
//
// We use console.error here (not the pino logger) because the logger module
// hasn't been loaded yet at this point.  These are global last-resort
// handlers; structured logging is fine to skip — what matters is that the
// process does NOT exit.
/**
 * Forward an error to all connected browsers via the global ServerLink.
 * Falls back to console-only when the link isn't ready yet.  This is the
 * single channel for surfacing uncaught daemon errors to end users so they
 * are never left wondering "why isn't anything working?".
 */
function forwardDaemonError(kind: 'uncaughtException' | 'unhandledRejection' | 'warning', err: unknown): void {
  const link = (globalThis as typeof globalThis & {
    __imcodesGlobalServerLink?: { send: (msg: unknown) => void };
  }).__imcodesGlobalServerLink;
  if (!link) return;
  try {
    const message = err instanceof Error
      ? err.message
      : (err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err));
    const stack = err instanceof Error ? err.stack : undefined;
    link.send({
      type: 'daemon.error',
      kind,
      message,
      stack,
      ts: Date.now(),
    });
  } catch {
    // ServerLink not connected — only console will show this error
  }
}

process.on('uncaughtException', (err) => {
  console.error('[imcodes-daemon] UNCAUGHT EXCEPTION (daemon stays alive):', err && (err.stack ?? err));
  forwardDaemonError('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[imcodes-daemon] UNHANDLED REJECTION (daemon stays alive):', reason);
  forwardDaemonError('unhandledRejection', reason);
});
// Also catch warnings — node-pty sometimes emits MaxListenersExceededWarning
// which we want to log but not crash on.
process.on('warning', (warning) => {
  console.warn('[imcodes-daemon] warning:', warning.name, warning.message);
  // Don't forward warnings — too noisy.
});

import { Command } from 'commander';
// These modules are imported lazily to avoid eager tmux backend detection on Windows.
// Commands like `bind` don't need tmux/conpty and shouldn't crash when node-pty is missing.
// Use dynamic import() at point of use instead of top-level imports.
import { bindFlow } from './bind/bind-flow.js';
import logger from './util/logger.js';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { existsSync, realpathSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';

import { PROJECT_ROOT } from './util/project-root.js';

const { version } = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };

/** Kill any lingering imcodes daemon processes after launchctl unload.
 *  Uses PID file (~/.imcodes/daemon.pid) for reliable targeting. */
function killStaleImcodesProcesses(): void {
  const pidPath = resolve(homedir(), '.imcodes', 'daemon.pid');
  let pid: number | null = null;
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    pid = parseInt(raw, 10);
    if (!pid || pid <= 0 || pid === process.pid) return;
  } catch { return; /* no PID file — nothing to kill */ }

  // Check if process is actually alive
  try { process.kill(pid, 0); } catch { return; /* already gone */ }

  try { process.kill(pid, 'SIGTERM'); } catch { return; }

  // Wait up to 3s for process to exit
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; /* exited */ }
    execSync('sleep 0.1');
  }
  // Force kill if still alive
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Ensure plist/systemd service uses --foreground. Patches in-place if missing. */
function ensureServiceForeground(): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
    if (!existsSync(plist)) return;
    const content = readFileSync(plist, 'utf8');
    if (content.includes('--foreground')) return;
    // Inject --foreground after <string>start</string>
    const patched = content.replace(
      /(<string>start<\/string>)\s*(<\/array>)/,
      '$1\n    <string>--foreground</string>\n  $2',
    );
    if (patched !== content) {
      writeFileSync(plist, patched, 'utf8');
      console.log('Patched plist: added --foreground');
    }
  } else if (platform === 'linux') {
    const svc = resolve(homedir(), '.config/systemd/user/imcodes.service');
    if (!existsSync(svc)) return;
    const content = readFileSync(svc, 'utf8');
    if (content.includes('--foreground')) return;
    const patched = content.replace(/^(ExecStart=.*imcodes start)$/m, '$1 --foreground');
    if (patched !== content) {
      writeFileSync(svc, patched, 'utf8');
      try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch { /* ok */ }
      console.log('Patched systemd service: added --foreground');
    }
  }
}

const program = new Command()
  .name('imcodes')
  .description('Remote AI coding agent controller')
  .version(version);

program.exitOverride();

program
  .command('start')
  .description('Start the daemon via system service (launchd/systemd)')
  .option('--foreground', 'Run in foreground (for service managers, not manual use)')
  .action(async (opts: { foreground?: boolean }) => {
    if (!opts.foreground) {
      // Before delegating to service manager, ensure service file has --foreground
      ensureServiceForeground();
    }
    if (opts.foreground) {
      // Acquire single-instance lock before installing global error handlers
      // so duplicate-instance errors propagate cleanly instead of being swallowed.
      const { startup } = await import('./daemon/lifecycle.js');
      try {
        await startup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already running')) {
          // Duplicate instance: this is the ONLY startup error that should exit.
          console.error(msg);
          process.exit(1);
        }
        // All other startup errors: log + keep the daemon alive.
        // Exiting here would cause systemd to rapid-restart in a crash loop
        // (see pre-fix daemon.log — 479 fatal errors, all transient tmux issues).
        // Subsystems that failed to initialize will retry lazily when used.
        // Uncaught errors hitting the global handlers at the top of this file
        // are the backstop for any post-startup crashes.
        logger.error({ err }, 'startup() failed — daemon stays alive with degraded state');
        forwardDaemonError('uncaughtException', err);
      }
      // Called by launchd/systemd plist/unit — run inline.
      // Global error handlers are registered at the top of this file.
      logger.info('Daemon running. Press Ctrl+C to stop.');
      await new Promise(() => {});
      return;
    }

    // Interactive: delegate to system service to avoid duplicate processes
    const platform = process.platform;
    if (platform === 'darwin') {
      const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
      if (!existsSync(plist)) {
        console.error(`No service installed. Run 'imcodes service install' first, or use 'imcodes start --foreground'.`);
        process.exit(1);
      }
      try { execSync(`launchctl unload "${plist}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* may not be loaded */ }
      execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
      console.log('Daemon started via launchctl.');
    } else if (platform === 'linux') {
      const userService = existsSync(resolve(homedir(), '.config/systemd/user/imcodes.service'));
      if (userService) {
        execSync('systemctl --user start imcodes', { stdio: 'inherit' });
      } else {
        console.error(`No user service installed. Run 'imcodes bind' or 'imcodes service install' first, or use 'imcodes start --foreground'.`);
        process.exit(1);
      }
      console.log('Daemon started via systemd.');
    } else {
      // Fallback: run inline
      const { startup: startupInline } = await import('./daemon/lifecycle.js');
      await startupInline();
      logger.info('Daemon running. Press Ctrl+C to stop.');
      await new Promise(() => {});
    }
  });

program
  .command('stop')
  .description('Stop the daemon gracefully')
  .action(async () => {
    const { shutdown } = await import('./daemon/lifecycle.js');
    await shutdown(0);
  });

program
  .command('project')
  .description('Manage projects')
  .addCommand(
    new Command('start')
      .description('Start brain + workers for a project')
      .argument('<name>', 'Project name')
      .argument('<dir>', 'Project directory')
      .option('--brain <type>', 'Brain agent type', 'claude-code')
      .option('--workers <types>', 'Comma-separated worker types', 'claude-code')
      .action(async (name: string, dir: string, opts: { brain: string; workers: string }) => {
        const workerTypes = opts.workers.split(',').map((t) => t.trim()) as ('claude-code' | 'codex' | 'opencode')[];
        const { loadStore } = await import('./store/session-store.js');
        await loadStore();
        const { startProject } = await import('./agent/session-manager.js');
        await startProject({ name, dir, brainType: opts.brain as 'claude-code' | 'codex' | 'opencode', workerTypes });
        console.log(`Started project ${name}: brain + ${workerTypes.length} worker(s)`);
      }),
  )
  .addCommand(
    new Command('stop')
      .description('Stop all sessions for a project')
      .argument('<name>', 'Project name')
      .action(async (name: string) => {
        const { loadStore } = await import('./store/session-store.js');
        await loadStore();
        const { stopProject } = await import('./agent/session-manager.js');
        await stopProject(name);
        console.log(`Stopped project ${name}`);
      }),
  );

program
  .command('status')
  .description('Show daemon status and all active sessions')
  .option('--project <name>', 'Filter by project')
  .option('--json', 'Output as JSON')
  .action(async (opts: { project?: string; json?: boolean }) => {
    const { loadCredentials } = await import('./bind/bind-flow.js');
    const { listSessions: tmuxList } = await import('./agent/tmux.js');
    const { loadStore, listSessions } = await import('./store/session-store.js');

    await loadStore();
    const sessions = listSessions(opts.project);
    const creds = await loadCredentials();
    let liveSet = new Set<string>();
    try {
      const liveTmux = await tmuxList();
      liveSet = new Set(liveTmux);
    } catch { /* tmux/wezterm not available — skip live check */ }

    // Check daemon process status
    let daemonPid: string | null = null;
    let daemonRunning = false;
    const pidFile = join(homedir(), '.imcodes', 'daemon.pid');
    try {
      const storedPid = readFileSync(pidFile, 'utf8').trim();
      if (storedPid) {
        daemonPid = storedPid;
        // Check if process is actually running
        try {
          process.kill(parseInt(storedPid, 10), 0);
          daemonRunning = true;
        } catch (err: any) {
          // On Windows, EPERM means the process IS alive but was spawned in
          // a different security context (e.g. VBS/watchdog detached launch).
          // Treating EPERM as "dead" causes `imcodes status` to show "stopped"
          // when the daemon is actually running fine.
          if (err?.code === 'EPERM') {
            daemonRunning = true;
          }
          // ESRCH = no such process = actually dead
        }
      }
    } catch { /* no PID file */ }
    // Fallback: systemd (Linux only)
    if (!daemonRunning && process.platform === 'linux') {
      try {
        const out = execSync('systemctl --user show imcodes --property=MainPID --value 2>/dev/null', { encoding: 'utf8' }).trim();
        if (out && out !== '0') { daemonPid = out; daemonRunning = true; }
      } catch { /* not using systemd */ }
    }

    if (opts.json) {
      console.log(JSON.stringify({
        daemon: { version, running: daemonRunning, pid: daemonPid, server: creds ? { url: creds.workerUrl, serverId: creds.serverId } : null },
        sessions: sessions.map((s) => ({ ...s, tmuxAlive: liveSet.has(s.name) })),
      }, null, 2));
      return;
    }

    // Daemon info
    console.log(`\x1b[1mIM.codes Daemon v${version}\x1b[0m`);
    console.log(`  Status:  ${daemonRunning ? `\x1b[32mrunning\x1b[0m (pid ${daemonPid})` : '\x1b[31mstopped\x1b[0m'}`);
    if (creds) {
      console.log(`  Server:  ${creds.workerUrl}`);
      console.log(`  ID:      ${creds.serverId}`);
    } else {
      console.log(`  Server:  \x1b[33mnot bound\x1b[0m (run \`imcodes bind <url>\`)`);
    }
    console.log();

    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }

    // Group by project
    const byProject = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const key = s.name.startsWith('deck_sub_') ? '(sub-sessions)' : s.projectName;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }

    for (const [project, group] of byProject) {
      console.log(`\x1b[1m${project}\x1b[0m`);
      for (const s of group) {
        const alive = liveSet.has(s.name);
        const stateColor = s.state === 'running' || s.state === 'idle' ? (alive ? '\x1b[32m' : '\x1b[33m') : s.state === 'error' ? '\x1b[31m' : '\x1b[90m';
        const tmuxTag = alive ? '' : ' \x1b[33m(no tmux)\x1b[0m';
        const ver = s.agentVersion ? ` ${s.agentVersion}` : '';
        const parent = s.parentSession ? ` \x1b[90m← ${s.parentSession}\x1b[0m` : '';
        const restarts = s.restarts > 0 ? ` \x1b[33mrestarts=${s.restarts}\x1b[0m` : '';
        console.log(`  ${s.name.padEnd(35)} ${s.agentType.padEnd(12)}${ver.padEnd(10)} ${stateColor}${s.state}\x1b[0m${tmuxTag}${restarts}${parent}`);
      }
      console.log();
    }
  });

program
  .command('send')
  .description('Send a message to a session (via hook server IPC or direct tmux)')
  .argument('[target]', 'Target: label, session name, or project:role')
  .argument('[message...]', 'Message text')
  .option('--files <paths>', 'Comma-separated file paths to include')
  .option('--all', 'Broadcast to all sibling sessions')
  .option('--type <agentType>', 'Target by agent type instead of label')
  .option('--list', 'List available sibling sessions')
  .option('--reply', 'Ask the target to send its response back')
  .option('--no-reply', 'Disable automatic reply instruction (default)')
  .action(async (target: string | undefined, messageParts: string[] | undefined, opts: { files?: string; all?: boolean; type?: string; list?: boolean; reply?: boolean }) => {
    const { detectSenderSession } = await import('./util/detect-session.js');

    // ── --list mode: show available siblings ───────────────────────────────
    if (opts.list) {
      // Try hook server first, fall back to session store
      const hookPort = readHookPort();
      if (hookPort) {
        try {
          const res = await postToHookServer(hookPort, '/list', {
            from: await detectSenderSession().catch(() => ''),
          });
          if (res.ok && Array.isArray(res.sessions)) {
            if (res.sessions.length === 0) {
              console.log('No sibling sessions found.');
            } else {
              for (const s of res.sessions as Array<{ name: string; label?: string; agentType: string; state: string }>) {
                const label = s.label ? ` (${s.label})` : '';
                console.log(`  ${s.name.padEnd(35)} ${s.agentType.padEnd(14)} ${s.state}${label}`);
              }
            }
            return;
          }
        } catch {
          // Hook server unavailable — fall back to direct store read
        }
      }

      // Direct store fallback
      const { loadStore, listSessions } = await import('./store/session-store.js');
      await loadStore();
      let from: string | undefined;
      try { from = await detectSenderSession(); } catch { /* unknown sender */ }
      const allSessions = listSessions();
      const sender = from ? allSessions.find((s) => s.name === from) : undefined;
      const siblings = sender
        ? allSessions.filter((s) => s.parentSession === sender.parentSession && s.name !== sender.name)
        : allSessions;

      if (siblings.length === 0) {
        console.log('No sibling sessions found.');
        return;
      }
      for (const s of siblings) {
        const label = s.label ? ` (${s.label})` : '';
        console.log(`  ${s.name.padEnd(35)} ${s.agentType.padEnd(14)} ${s.state}${label}`);
      }
      return;
    }

    // ── Send mode ──────────────────────────────────────────────────────────

    // When --all or --type is used, target positional arg is not a target but part of the message.
    // Reassemble: "imcodes send --all hello world" → target="hello", messageParts=["world"]
    let message: string;
    let resolvedTarget: string | undefined;
    if (opts.all || opts.type) {
      // No target needed — all positional args form the message
      const parts = [target, ...(messageParts ?? [])].filter(Boolean);
      message = parts.join(' ');
      resolvedTarget = undefined;
    } else {
      if (!target) {
        console.error('Error: target is required unless --all or --type is specified.');
        process.exit(1);
      }
      resolvedTarget = target;
      message = messageParts?.join(' ') ?? '';
    }

    if (!message) {
      console.error('Error: message is required.');
      process.exit(1);
    }

    // Parse --files into array
    const files = opts.files ? opts.files.split(',').map((f) => f.trim()).filter(Boolean) : undefined;

    // Try hook server IPC first (preferred — daemon handles target resolution, queuing, etc.)
    const hookPort = readHookPort();
    if (hookPort) {
      try {
        const from = await detectSenderSession().catch(() => 'cli');

        // --reply: append callback instruction so the target knows to reply
        if (opts.reply) {
          message += `\n\nAfter completing the above task, send your response using: imcodes send --no-reply "${from}" "Task: <brief summary of the request>\nResult: <your response>"`;
        }

        if (opts.all) {
          // Broadcast mode
          const res = await postToHookServer(hookPort, '/send', {
            from,
            to: '*',
            message,
            ...(files ? { files } : {}),
            depth: 0,
          });
          printSendResult(res);
          return;
        }

        if (opts.type) {
          // Target by agent type
          const res = await postToHookServer(hookPort, '/send', {
            from,
            to: opts.type,
            message,
            ...(files ? { files } : {}),
            depth: 0,
          });
          printSendResult(res);
          return;
        }

        // Standard target (label or session name)
        const res = await postToHookServer(hookPort, '/send', {
          from,
          to: resolvedTarget!,
          message,
          ...(files ? { files } : {}),
          depth: 0,
        });
        printSendResult(res);
        return;
      } catch (err) {
        // Hook server unavailable — fall back to direct tmux send
        logger.debug({ err }, 'Hook server unavailable, falling back to direct send');
      }
    }

    // Fallback: direct tmux sendKeys (original behavior for backward compat)
    console.warn('Warning: hook server unavailable — using direct send (no --files, --all, --type, queue, or label resolution).');
    if (!resolvedTarget) {
      console.error('Error: target is required for direct send (hook server not available).');
      process.exit(1);
    }
    // Support shorthand "project:role"
    const { sessionName } = await import('./agent/session-manager.js');
    const name = resolvedTarget.includes(':')
      ? sessionName(resolvedTarget.split(':')[0], resolvedTarget.split(':')[1] as 'brain' | `w${number}`)
      : resolvedTarget;
    const { sendKeys } = await import('./agent/tmux.js');
    await sendKeys(name, message);
    console.log(`Sent to ${name}`);
  });

/** Read hook server port from ~/.imcodes/hook-port. Returns null if unavailable. */
function readHookPort(): number | null {
  try {
    const portPath = join(homedir(), '.imcodes', 'hook-port');
    const raw = readFileSync(portPath, 'utf8').trim();
    const port = parseInt(raw, 10);
    return Number.isFinite(port) && port > 1024 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** POST JSON to the hook server and return parsed response. */
async function postToHookServer(port: number, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const http = await import('http');
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseBody) as Record<string, unknown>);
          } catch {
            reject(new Error(`Invalid JSON response: ${responseBody}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Print the result of a /send call to stdout. */
function printSendResult(res: Record<string, unknown>): void {
  if (res.ok) {
    // Broadcast response: delivered/queued are arrays
    if (Array.isArray(res.delivered)) {
      if (res.delivered.length > 0) console.log(`Sent to ${res.delivered.length} sessions: ${(res.delivered as string[]).join(', ')}`);
      if (Array.isArray(res.queued) && res.queued.length > 0) console.log(`Queued for ${res.queued.length}: ${(res.queued as string[]).join(', ')}`);
      if (Array.isArray(res.errors) && res.errors.length > 0) console.warn(`Errors: ${(res.errors as string[]).join('; ')}`);
    } else if (res.queued) {
      console.log(`Message queued for ${res.target ?? 'target'} (agent busy).`);
    } else {
      console.log(`Sent to ${res.target ?? 'target'}.`);
    }
  } else {
    console.error(`Error: ${res.error ?? 'unknown error'}`);
    if (Array.isArray(res.available) && res.available.length > 0) {
      console.error('Available targets:');
      for (const t of res.available) {
        console.error(`  ${t}`);
      }
    }
    process.exit(1);
  }
}

program
  .command('bind')
  .description('Bind this machine to IM.codes')
  .argument('<url>', 'Bind URL from the IM.codes dashboard (https://app.im.codes/bind/<api-key>)')
  .argument('[device-name]', 'Friendly name for this device (default: hostname)')
  .option('--force', 'Re-bind even if already bound (replaces existing server entry)')
  .action(async (url: string, deviceName?: string, opts?: { force?: boolean }) => {
    await bindFlow(url, deviceName, { force: opts?.force });
  });

program
  .command('setup')
  .description('Deploy IM.codes server + daemon on this machine (Docker required)')
  .requiredOption('--domain <domain>', 'Domain name for HTTPS (e.g. imc.example.com)')
  .option('--force', 'Overwrite existing setup')
  .action(async (opts: { domain: string; force?: boolean }) => {
    const { setupFlow } = await import('./setup/setup-flow.js');
    await setupFlow(opts.domain, { force: opts.force });
  });

program
  .command('service')
  .description('Manage the imcodes system service')
  .addCommand(
    new Command('restart')
      .description('Rebuild and restart the imcodes daemon service')
      .option('--no-build', 'Skip rebuild step')
      .action(async (opts: { build: boolean }) => {
        ensureServiceForeground();
        const projectRoot = PROJECT_ROOT;

        if (opts.build) {
          console.log('Building...');
          try {
            execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
          } catch {
            console.error('Build failed, aborting restart.');
            process.exit(1);
          }
        }

        const platform = process.platform;

        if (platform === 'darwin') {
          const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
          if (!existsSync(plist)) {
            console.error(`Plist not found: ${plist}`);
            process.exit(1);
          }
          console.log('Restarting via launchctl...');
          execSync(`launchctl unload "${plist}"`, { stdio: 'inherit' });
          // Wait for old process to fully exit before starting new one
          killStaleImcodesProcesses();
          execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
          console.log('Done.');
        } else if (platform === 'linux') {
          const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
          const isUserService = existsSync(userService);
          console.log('Restarting via systemd...');
          if (isUserService) {
            execSync('systemctl --user daemon-reload && systemctl --user restart imcodes', { stdio: 'inherit' });
          } else {
            console.error('No user service found. Run "imcodes bind" to install.');
            process.exit(1);
          }
          console.log('Done.');
        } else {
          console.error(`Unsupported platform: ${platform}`);
          process.exit(1);
        }
      }),
  );

program
  .command('upgrade')
  .description('Upgrade imcodes to latest version and restart daemon')
  .option('--version <ver>', 'Install specific version instead of latest')
  .action((opts: { version?: string }) => {
    const pkg = opts.version ? `imcodes@${opts.version}` : 'imcodes@latest';
    const platform = process.platform;

    // Detect package manager: npm global or from a git clone?
    const selfPath = realpathSync(process.argv[1]);
    const isGlobal = selfPath.includes('node_modules');

    console.log(`Upgrading to ${pkg}...`);

    // Step 1: Install new version (do NOT kill daemon — upgrade may be running from
    // a daemon-managed session, so killing it would kill ourselves).
    if (isGlobal) {
      const npmBin = resolve(dirname(process.execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
      const npmCmd = existsSync(npmBin) ? npmBin : 'npm';
      try {
        execSync(`"${npmCmd}" install -g ${pkg}`, { stdio: 'inherit' });
      } catch {
        console.error('npm install failed.');
        process.exit(1);
      }
    } else {
      const projectRoot = PROJECT_ROOT;
      try {
        if (platform === 'win32') {
          execSync('git pull', { cwd: projectRoot, stdio: 'inherit' });
          execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
        } else {
          execSync('git pull && npm run build', { cwd: projectRoot, stdio: 'inherit' });
        }
      } catch {
        console.error('Git pull / build failed.');
        process.exit(1);
      }
    }

    // Show new version
    try {
      if (platform === 'win32') {
        const newVer = execSync(`"${selfPath}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        console.log(`Upgraded to v${newVer}`);
      } else {
        const newVer = execSync(`${selfPath} --version 2>/dev/null || echo unknown`, { encoding: 'utf8' }).trim();
        console.log(`Upgraded to v${newVer}`);
      }
    } catch { /* ignore */ }

    // Step 2: Restart daemon so it picks up the new code.
    // The daemon's own watchdog loop will relaunch with the new version after exit.
    ensureServiceForeground();
    if (platform === 'darwin') {
      const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
      if (existsSync(plist)) {
        console.log('Restarting daemon via launchctl...');
        try { execSync(`launchctl unload "${plist}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* ok */ }
        killStaleImcodesProcesses();
        execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
      }
    } else if (platform === 'linux') {
      const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
      if (existsSync(userService)) {
        console.log('Restarting daemon via systemd...');
        execSync('systemctl --user daemon-reload && systemctl --user restart imcodes', { stdio: 'inherit' });
      } else {
        console.log('No user service found. Skipping restart — run "imcodes bind" to install.');
      }
    } else if (platform === 'win32') {
      // Kill daemon process — watchdog will auto-relaunch with new version in ~5s.
      console.log('Restarting daemon (watchdog will relaunch with new version)...');
      const pidFile = resolve(homedir(), '.imcodes', 'daemon.pid');
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid && pid !== process.pid) {
          try { execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore' }); } catch { /* not running */ }
        }
      } catch { /* no PID file */ }
    }
    console.log('Done.');
  });

program
  .command('restart')
  .description('Restart the imcodes daemon service')
  .action(async () => {
    ensureServiceForeground();
    const platform = process.platform;
    if (platform === 'darwin') {
      const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
      if (!existsSync(plist)) { console.error(`Plist not found: ${plist}`); process.exit(1); }
      console.log('Restarting via launchctl...');
      execSync(`launchctl unload "${plist}"`, { stdio: 'inherit' });
      killStaleImcodesProcesses();
      execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
    } else if (platform === 'linux') {
      const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
      const isUserService = existsSync(userService);
      console.log('Restarting via systemd...');
      if (isUserService) {
        execSync('systemctl --user restart imcodes', { stdio: 'inherit' });
      } else {
        console.error('No user service found. Run "imcodes bind" to install.');
        process.exit(1);
      }
    } else if (platform === 'win32') {
      // Use the single reusable ensureDaemonRunning() that handles all
      // edge cases: orphan daemons holding the named pipe, crash-loop
      // watchdogs from the BOM bug, missing PID files, etc.
      const { ensureDaemonRunning } = await import('./util/windows-daemon.js');
      if (!ensureDaemonRunning(process.pid)) {
        console.error('Watchdog not found. Run "imcodes bind" first.');
        process.exit(1);
      }
      console.log('Daemon restarted (orphans cleared, fresh watchdog launched).');
    } else {
      console.error(`Unsupported platform: ${platform}`); process.exit(1);
    }
    console.log('Done.');
  });

program
  .command('connect')
  .description('Connect to a transport provider')
  .argument('<provider>', 'Provider name (e.g. openclaw)')
  .option('--url <url>', 'Provider URL (default: auto-detect)')
  .option('--token <token>', 'Auth token (default: auto-detect from provider config)')
  .option('--insecure', 'Allow non-TLS connections to remote hosts')
  .action(async (provider: string, opts: { url?: string; token?: string; insecure?: boolean }) => {
    if (provider !== 'openclaw') {
      console.error(`Unknown provider: ${provider}. Supported providers: openclaw`);
      process.exit(1);
    }

    const { resolveToken, saveConfig } = await import('./agent/openclaw-config.js');

    // Resolve URL
    const url = opts.url ?? 'ws://127.0.0.1:18789';

    // Check non-localhost + non-TLS without --insecure
    const isLocalhost = url.startsWith('ws://127.') || url.startsWith('ws://localhost') || url.startsWith('ws://[::1]');
    const isTLS = url.startsWith('wss://');
    if (!isLocalhost && !isTLS && !opts.insecure) {
      console.error(`Error: Non-TLS connection to a remote host requires --insecure flag.`);
      console.error(`  URL: ${url}`);
      console.error(`  Use --insecure to allow, or change the URL to wss://`);
      process.exit(1);
    }

    // Resolve token
    const token = resolveToken(opts.token);
    if (!token) {
      console.error(`Error: No auth token found.`);
      console.error(`  Provide one via --token, OPENCLAW_GATEWAY_TOKEN env var,`);
      console.error(`  or place it in ~/.openclaw/openclaw.json → gateway.auth.token`);
      process.exit(1);
    }

    // Save config — daemon's autoReconnectProviders reads this on startup
    await saveConfig({ url, token });
    console.log(`Config saved. Restarting daemon...`);
    ensureServiceForeground();
    const platform = process.platform;
    if (platform === 'darwin') {
      const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
      if (existsSync(plist)) {
        try { execSync(`launchctl unload "${plist}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* ok */ }
        killStaleImcodesProcesses();
        execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
      }
    } else if (platform === 'linux') {
      const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
      if (existsSync(userService)) {
        execSync('systemctl --user restart imcodes', { stdio: 'inherit' });
      } else {
        console.log('No user service found. Run "imcodes restart" manually after installing with "imcodes bind".');
      }
    }
    console.log(`Connected to ${provider}.`);
  });

program
  .command('disconnect')
  .description('Disconnect from a transport provider')
  .argument('<provider>', 'Provider name (e.g. openclaw)')
  .action(async (provider: string) => {
    if (provider !== 'openclaw') {
      console.error(`Unknown provider: ${provider}. Supported providers: openclaw`);
      process.exit(1);
    }

    const { removeConfig } = await import('./agent/openclaw-config.js');

    // Remove saved config so daemon won't auto-reconnect
    await removeConfig();

    // Restart daemon to drop the active connection
    console.log(`Restarting daemon to disconnect...`);
    ensureServiceForeground();
    const platform = process.platform;
    if (platform === 'darwin') {
      const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
      if (existsSync(plist)) {
        try { execSync(`launchctl unload "${plist}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* ok */ }
        killStaleImcodesProcesses();
        execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
      }
    } else if (platform === 'linux') {
      const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
      if (existsSync(userService)) {
        execSync('systemctl --user restart imcodes', { stdio: 'inherit' });
      } else {
        console.log('No user service found. Run "imcodes restart" manually after installing with "imcodes bind".');
      }
    }
    console.log(`Disconnected from ${provider}.`);
  });

program
  .command('repair-watchdog')
  .alias('r')
  .description('Regenerate Windows daemon watchdog files and (re)start the watchdog (alias: r)')
  .action(async () => {
    if (process.platform !== 'win32') {
      console.log('This command is only needed on Windows.');
      return;
    }
    const { regenerateAllArtifacts } = await import('./util/windows-launch-artifacts.js');
    await regenerateAllArtifacts();
    // Use the single reusable ensureDaemonRunning() that handles every
    // edge case (orphan daemons, crash-loop watchdogs, stale PID files).
    const { ensureDaemonRunning } = await import('./util/windows-daemon.js');
    if (ensureDaemonRunning(process.pid)) {
      console.log('Watchdog files regenerated and daemon restarted.');
    } else {
      console.log('Watchdog files regenerated. Daemon will start on next login (Startup shortcut).');
    }
  });

// ── Memory search CLI ────────────────────────────────────────────────────────

const memoryCmd = program
  .command('memory')
  .description('Search and inspect local agent memory');

memoryCmd
  .command('search [query]')
  .description('Search local memory (processed summaries and raw events)')
  .option('--format <format>', 'Output format: json, document, table', 'table')
  .option('--repo <repo>', 'Filter by canonical repository ID')
  .option('--class <class>', 'Filter by projection class: recent_summary, durable_memory_candidate')
  .option('--raw', 'Include raw unprocessed events', false)
  .option('--limit <n>', 'Maximum results', '50')
  .action(async (query: string | undefined, opts: Record<string, string | boolean>) => {
    const { searchLocalMemory, formatSearchResults } = await import('./context/memory-search.js');
    const result = searchLocalMemory({
      query: query || undefined,
      repo: typeof opts.repo === 'string' ? opts.repo : undefined,
      projectionClass: typeof opts.class === 'string' ? opts.class as 'recent_summary' | 'durable_memory_candidate' : undefined,
      includeRaw: opts.raw === true,
      limit: Number(opts.limit) || 50,
    });
    const format = (typeof opts.format === 'string' ? opts.format : 'table') as 'json' | 'document' | 'table';
    console.log(formatSearchResults(result, format));
  });

memoryCmd
  .command('list')
  .description('List recent processed memory summaries')
  .option('--format <format>', 'Output format: json, document, table', 'table')
  .option('--repo <repo>', 'Filter by canonical repository ID')
  .option('--limit <n>', 'Maximum results', '20')
  .action(async (opts: Record<string, string>) => {
    const { searchLocalMemory, formatSearchResults } = await import('./context/memory-search.js');
    const result = searchLocalMemory({
      repo: opts.repo || undefined,
      limit: Number(opts.limit) || 20,
    });
    const format = (opts.format || 'table') as 'json' | 'document' | 'table';
    console.log(formatSearchResults(result, format));
  });

memoryCmd
  .command('stats')
  .description('Show aggregate memory statistics')
  .option('--format <format>', 'Output format: json, table', 'table')
  .option('--repo <repo>', 'Filter by canonical repository ID')
  .action(async (opts: Record<string, string>) => {
    const { searchLocalMemory } = await import('./context/memory-search.js');
    const result = searchLocalMemory({
      repo: opts.repo || undefined,
      includeRaw: true,
      limit: 0,
    });
    const { stats } = result;
    if (opts.format === 'json') {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(`Total records:      ${stats.totalRecords}`);
      console.log(`Recent summaries:   ${stats.recentSummaryCount}`);
      console.log(`Durable candidates: ${stats.durableCandidateCount}`);
      console.log(`Projects:           ${stats.projectCount}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const exitCode = typeof err === 'object' && err && 'exitCode' in err
    ? Number((err as { exitCode?: unknown }).exitCode)
    : null;
  const code = typeof err === 'object' && err && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : '';

  if (exitCode === 0 || code === 'commander.help' || code === 'commander.version') {
    process.exitCode = 0;
    return;
  }

  logger.error({ err }, 'Fatal error');
  process.exit(exitCode && exitCode > 0 ? exitCode : 1);
});
