/**
 * Daemon-side cron job executor.
 * Receives dispatched cron jobs and sends commands to target sessions.
 */
import type { CronDispatchMessage } from '../../shared/cron-types.js';
import { sendKeys } from '../agent/tmux.js';
import { getSession } from '../store/session-store.js';
import { sessionName, getTransportRuntime } from '../agent/session-manager.js';
import { detectStatusAsync, type AgentType } from '../agent/detect.js';
import { startP2pRun, type P2pTarget } from './p2p-orchestrator.js';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';

const BUSY_STATES = new Set(['streaming', 'thinking', 'tool_running', 'permission']);

export async function executeCronJob(msg: CronDispatchMessage, serverLink: ServerLink): Promise<void> {
  const { jobId, jobName, projectName, targetRole, action } = msg;

  if (!/^(brain|w\d+)$/.test(targetRole)) {
    logger.warn({ jobId, targetRole }, 'Cron: invalid target role');
    return;
  }

  const name = sessionName(projectName, targetRole as 'brain' | `w${number}`);
  const session = getSession(name);
  if (!session) {
    logger.warn({ jobId, sessionName: name }, 'Cron: target session not found, skipping');
    return;
  }

  // Busy check — skip tmux detection for transport sessions
  if (session.runtimeType === 'transport') {
    logger.debug({ jobId, sessionName: name }, 'Cron: transport session, skipping busy check');
  } else {
    try {
      const status = await detectStatusAsync(name, session.agentType as AgentType);
      if (BUSY_STATES.has(status)) {
        logger.info({ jobId, sessionName: name, status }, 'Cron: session busy, skipping');
        return;
      }
    } catch (err) {
      logger.warn({ jobId, sessionName: name, err }, 'Cron: status detection failed, proceeding');
    }
  }

  if (action.type === 'command') {
    logger.info({ jobId, jobName, sessionName: name, command: action.command.slice(0, 80) }, 'Cron: sending command');

    if (session.runtimeType === 'transport') {
      const runtime = getTransportRuntime(name);
      if (runtime) {
        try {
          await runtime.send(action.command);
        } catch (err) {
          logger.error({ jobId, sessionName: name, err }, 'Cron: transport send failed');
        }
      } else {
        logger.warn({ jobId, sessionName: name }, 'Cron: transport provider not connected');
      }
    } else {
      await sendKeys(name, action.command, { cwd: session.projectDir });
    }
    return;
  }

  if (action.type === 'p2p') {
    const { topic, mode, participants, rounds } = action;

    const targets: P2pTarget[] = (participants ?? [])
      .map(role => ({
        session: sessionName(projectName, role as 'brain' | `w${number}`),
        mode,
      }))
      .filter(t => !!getSession(t.session));

    if (targets.length === 0) {
      logger.warn({ jobId, jobName }, 'Cron: no valid P2P participants, skipping');
      return;
    }

    logger.info({ jobId, jobName, initiator: name, targets: targets.length, mode }, 'Cron: starting P2P discussion');
    await startP2pRun(name, targets, topic, [], serverLink, rounds ?? 1);
    return;
  }

  logger.warn({ jobId, actionType: (action as Record<string, unknown>).type }, 'Cron: unknown action type');
}
