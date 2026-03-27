/**
 * Auto-fix pipeline CLI entry point.
 * Usage:
 *   imcodes autofix --project <name> --coder claude-code --auditor codex "task description"
 *   imcodes autofix --project <name> --tracker github|gitlab [--continuous]
 */
import type { Command } from 'commander';
import { AuditEngine } from './audit-engine.js';
import { createTask } from './state-machine.js';
import { fastPathDecision, executeDecision } from './decision-engine.js';
import { createBranch, pushBranch } from './branch-manager.js';
import { loadConfig } from '../config.js';
import { sendKeys } from '../agent/tmux.js';
import { startAutoFixProject } from '../agent/session-manager.js';
import { getProject } from '../store/project-store.js';
import logger from '../util/logger.js';

export type AgentType = 'claude-code' | 'codex' | 'opencode';
export type TrackerType = 'github' | 'gitlab' | 'none';

export interface AutoFixOptions {
  project: string;
  coder: AgentType;
  auditor: AgentType;
  tracker?: TrackerType;
  trackerUrl?: string;
  continuous?: boolean;
  maxRounds?: number;
}

/**
 * Register the autofix subcommand on a Commander instance.
 */
export function registerAutoFixCommand(program: Command): void {
  program
    .command('autofix')
    .description('Run the auto-fix pipeline')
    .option('-p, --project <name>', 'Project name')
    .option('--coder <type>', 'Coder agent type (claude-code|codex|opencode)', 'claude-code')
    .option('--auditor <type>', 'Auditor agent type (claude-code|codex|opencode)', 'codex')
    .option('--tracker <type>', 'Issue tracker type (github|gitlab|none)', 'none')
    .option('--tracker-url <url>', 'Tracker API URL (for self-hosted)')
    .option('--continuous', 'Continuously process issues from tracker')
    .option('--max-rounds <n>', 'Max discussion rounds', '3')
    .argument('[task]', 'Task description (standalone mode)')
    .action(async (taskDescription: string | undefined, opts: Record<string, string>) => {
      const config = await loadConfig();
      const projectName = opts.project ?? (config as unknown as Record<string, string>).defaultProject;

      if (!projectName) {
        console.error('--project is required');
        process.exit(1);
      }

      const autoFixOpts: AutoFixOptions = {
        project: projectName,
        coder: (opts.coder as AgentType) ?? 'claude-code',
        auditor: (opts.auditor as AgentType) ?? 'codex',
        tracker: (opts.tracker as TrackerType) ?? 'none',
        trackerUrl: opts.trackerUrl,
        continuous: opts.continuous === 'true' || opts.continuous === '',
        maxRounds: parseInt(opts.maxRounds ?? '3', 10),
      };

      if (opts.tracker !== 'none' && opts.tracker) {
        await runTrackerMode(autoFixOpts);
      } else if (taskDescription) {
        await runStandaloneMode(taskDescription, autoFixOpts);
      } else {
        console.error('Provide a task description or --tracker mode');
        process.exit(1);
      }
    });
}

// ── Standalone mode ───────────────────────────────────────────────────────────

async function runStandaloneMode(taskDescription: string, opts: AutoFixOptions): Promise<void> {
  logger.info({ project: opts.project, coder: opts.coder, auditor: opts.auditor }, 'Starting standalone auto-fix');

  const projectRecord = getProject(opts.project);
  const projectDir = projectRecord?.dir ?? process.cwd();

  const { coderSession, auditorSession } = await startAutoFixProject({
    projectName: opts.project,
    projectDir,
    coderType: opts.coder,
    auditorType: opts.auditor,
    featureBranch: 'HEAD',
  });

  let task = createTask({
    title: taskDescription.slice(0, 80),
    description: taskDescription,
    coderSession,
    auditorSession,
    projectName: opts.project,
    maxDiscussionRounds: opts.maxRounds ?? 3,
  });

  const auditEngine = new AuditEngine({
    onTaskUpdate: async (updated) => { task = updated; },
  });

  const executors = {
    sendToSession: async (session: string, text: string) => { await sendKeys(session, text); },
    runDesignReview: async (t: typeof task) => auditEngine.runDesignReview(t),
    runCodeReview: async (t: typeof task) => auditEngine.runCodeReview(t),
    pushChanges: async (_t: typeof task) => {
      logger.info({ task: _t.id }, 'Push changes (no-op in standalone mode)');
    },
    closeIssue: async (_t: typeof task) => {
      logger.info({ task: _t.id }, 'Task complete');
    },
  };

  // Run the pipeline
  while (task.state !== 'done' && task.state !== 'failed') {
    const decision = fastPathDecision(task);
    if (decision) {
      task = await executeDecision(decision, task, executors);
    } else {
      // Wait for implementing state to complete
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (task.state === 'done') {
    console.log(`\n✓ Task complete: ${task.title}`);
  } else {
    console.error(`\n✗ Task failed: ${task.error}`);
    process.exit(1);
  }
}

// ── Tracker mode ──────────────────────────────────────────────────────────────

async function runTrackerMode(opts: AutoFixOptions): Promise<void> {
  const { createTracker } = await import('../tracker/index.js');
  const tracker = createTracker(opts.tracker!, opts.trackerUrl);

  logger.info({ project: opts.project, tracker: opts.tracker }, 'Starting tracker auto-fix mode');

  do {
    const issues = await tracker.fetchIssues({ status: 'open', assignedToMe: true });
    if (issues.length === 0) {
      if (opts.continuous) {
        logger.info('No issues — waiting 60s before retry');
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      console.log('No open issues to process');
      break;
    }

    const issue = issues[0]; // Highest priority
    logger.info({ issueId: issue.id, title: issue.title }, 'Processing issue');

    await tracker.claimIssue(issue.id);

    // In tracker mode, also create a branch (before starting sessions)
    const config = await loadConfig();
    const projectRecord = getProject(opts.project);
    const cwd = projectRecord?.dir ?? process.cwd();
    const baseBranch = projectRecord?.tracker?.baseBranch ?? config.tracker?.baseBranch ?? 'main';
    const branch = await createBranch({
      issueId: issue.id,
      title: issue.title,
      baseBranch,
      cwd,
    });

    const { coderSession, auditorSession } = await startAutoFixProject({
      projectName: opts.project,
      projectDir: cwd,
      coderType: opts.coder,
      auditorType: opts.auditor,
      featureBranch: branch.name,
    });

    let task = createTask({
      title: issue.title,
      description: issue.body,
      coderSession,
      auditorSession,
      projectName: opts.project,
      issueId: issue.id,
      maxDiscussionRounds: opts.maxRounds ?? 3,
    });

    const auditEngine = new AuditEngine({
      onTaskUpdate: async (updated) => { task = updated; },
    });

    const executors = {
      sendToSession: async (session: string, text: string) => { await sendKeys(session, text); },
      runDesignReview: async (t: typeof task) => auditEngine.runDesignReview(t),
      runCodeReview: async (t: typeof task) => auditEngine.runCodeReview(t),
      pushChanges: async (t: typeof task) => {
        if (t.branch) await pushBranch(t.branch, cwd);
      },
      closeIssue: async (t: typeof task) => {
        if (t.issueId) await tracker.closeIssue(t.issueId, 'Resolved via auto-fix pipeline');
      },
    };

    while (task.state !== 'done' && task.state !== 'failed') {
      const decision = fastPathDecision(task);
      if (decision) {
        task = await executeDecision(decision, task, executors);
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (task.state === 'done') {
      console.log(`✓ Issue #${issue.id} resolved: ${issue.title}`);
    } else {
      console.error(`✗ Issue #${issue.id} failed: ${task.error}`);
      await tracker.updateStatus(issue.id, 'open');
    }
  } while (opts.continuous);
}
