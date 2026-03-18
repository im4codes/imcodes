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
  .description('Show all active sessions')
  .option('--project <name>', 'Filter by project')
  .action(async (opts: { project?: string }) => {
    await loadStore();
    const sessions = listSessions(opts.project);
    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }
    for (const s of sessions) {
      console.log(`${s.name}  ${s.agentType.padEnd(12)}  ${s.state}  restarts=${s.restarts}`);
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
