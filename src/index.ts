#!/usr/bin/env node
import { Command } from 'commander';
import { startup, shutdown } from './daemon/lifecycle.js';
import { startProject, stopProject, sessionName } from './agent/session-manager.js';
import { loadStore, listSessions } from './store/session-store.js';
import { sendKeys } from './agent/tmux.js';
import { bindFlow } from './bind/bind-flow.js';
import logger from './util/logger.js';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { existsSync, realpathSync, readFileSync } from 'fs';
import { resolve, join, dirname } from 'path';

const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

const program = new Command()
  .name('imcodes')
  .description('Remote AI coding agent controller')
  .version(version);

program
  .command('start')
  .description('Start the daemon (connect to CF server, restore sessions)')
  .action(async () => {
    await startup();
    logger.info('Daemon running. Press Ctrl+C to stop.');
    // Keep process alive — signal handlers in lifecycle.ts handle exit
    await new Promise(() => {});
  });

program
  .command('stop')
  .description('Stop the daemon gracefully')
  .action(async () => {
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
        await loadStore();
        await startProject({ name, dir, brainType: opts.brain as 'claude-code' | 'codex' | 'opencode', workerTypes });
        console.log(`Started project ${name}: brain + ${workerTypes.length} worker(s)`);
      }),
  )
  .addCommand(
    new Command('stop')
      .description('Stop all sessions for a project')
      .argument('<name>', 'Project name')
      .action(async (name: string) => {
        await loadStore();
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
    const { DAEMON_VERSION } = await import('./util/version.js');

    await loadStore();
    const sessions = listSessions(opts.project);
    const creds = await loadCredentials();
    const liveTmux = await tmuxList().catch(() => [] as string[]);
    const liveSet = new Set(liveTmux);

    // Check daemon process status
    let daemonPid: string | null = null;
    let daemonRunning = false;
    try {
      const out = execSync('systemctl --user show imcodes --property=MainPID --value 2>/dev/null', { encoding: 'utf8' }).trim();
      if (out && out !== '0') { daemonPid = out; daemonRunning = true; }
    } catch { /* not using systemd or not installed */ }
    if (!daemonRunning) {
      try {
        const out = execSync('pgrep -f "imcodes start" 2>/dev/null', { encoding: 'utf8' }).trim();
        if (out) { daemonPid = out.split('\n')[0]; daemonRunning = true; }
      } catch { /* not running */ }
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
  .description('Send a message to a session')
  .argument('<session>', 'Session name (e.g. deck_myapp_brain) or project:role (e.g. myapp:w1)')
  .argument('<message...>', 'Message text')
  .action(async (session: string, messageParts: string[]) => {
    const message = messageParts.join(' ');
    // Support shorthand "project:role"
    const name = session.includes(':')
      ? sessionName(session.split(':')[0], session.split(':')[1] as 'brain' | `w${number}`)
      : session;
    await sendKeys(name, message);
    console.log(`Sent to ${name}`);
  });

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
  .command('service')
  .description('Manage the imcodes system service')
  .addCommand(
    new Command('restart')
      .description('Rebuild and restart the imcodes daemon service')
      .option('--no-build', 'Skip rebuild step')
      .action(async (opts: { build: boolean }) => {
        const realScript = realpathSync(process.argv[1]);
        const projectRoot = resolve(realScript, '../..'); // dist/index.js → project root

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
          execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
          console.log('Done.');
        } else if (platform === 'linux') {
          const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
          const isUserService = existsSync(userService);
          console.log('Restarting via systemd...');
          if (isUserService) {
            execSync('systemctl --user daemon-reload && systemctl --user restart imcodes', { stdio: 'inherit' });
          } else {
            execSync('sudo systemctl daemon-reload && sudo systemctl restart imcodes', { stdio: 'inherit' });
          }
          console.log('Done.');
        } else {
          console.error(`Unsupported platform: ${platform}`);
          process.exit(1);
        }
      }),
  );

program
  .command('restart')
  .description('Restart the imcodes daemon service')
  .action(() => {
    const platform = process.platform;
    if (platform === 'darwin') {
      const plist = resolve(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
      if (!existsSync(plist)) { console.error(`Plist not found: ${plist}`); process.exit(1); }
      console.log('Restarting via launchctl...');
      execSync(`launchctl unload "${plist}"`, { stdio: 'inherit' });
      execSync(`launchctl load "${plist}"`, { stdio: 'inherit' });
    } else if (platform === 'linux') {
      const userService = resolve(homedir(), '.config/systemd/user/imcodes.service');
      const isUserService = existsSync(userService);
      console.log('Restarting via systemd...');
      if (isUserService) {
        execSync('systemctl --user restart imcodes', { stdio: 'inherit' });
      } else {
        execSync('sudo systemctl restart imcodes', { stdio: 'inherit' });
      }
    } else {
      console.error(`Unsupported platform: ${platform}`); process.exit(1);
    }
    console.log('Done.');
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
