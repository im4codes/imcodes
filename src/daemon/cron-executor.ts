/**
 * Daemon-side cron job executor.
 * Receives dispatched cron jobs and sends commands to target sessions.
 */
import type { CronCommandResultMessage, CronDispatchMessage, CronParticipant } from '../../shared/cron-types.js';
import { CRON_MSG } from '../../shared/cron-types.js';
import { sendKeys } from '../agent/tmux.js';
import { getSession } from '../store/session-store.js';
import { sessionName, getTransportRuntime } from '../agent/session-manager.js';
import { detectStatusAsync, type AgentType } from '../agent/detect.js';
import { startP2pRun, type P2pTarget } from './p2p-orchestrator.js';
import { timelineEmitter } from './timeline-emitter.js';
import type { TimelineEvent } from './timeline-event.js';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';

const BUSY_STATES = new Set(['streaming', 'thinking', 'tool_running', 'permission']);

export async function executeCronJob(msg: CronDispatchMessage, serverLink: ServerLink): Promise<void> {
  const { jobId, executionId, jobName, projectName, targetRole, targetSessionName, action } = msg;

  // Resolve target session: prefer direct session name, fall back to role-based construction
  let name: string;
  if (targetSessionName) {
    name = targetSessionName;
  } else {
    if (!/^(brain|w\d+)$/.test(targetRole)) {
      logger.warn({ jobId, targetRole }, 'Cron: invalid target role');
      sendCommandResult(serverLink, {
        type: CRON_MSG.COMMAND_RESULT,
        jobId,
        executionId,
        status: 'error',
        detail: `Cron target role is invalid: ${targetRole}`,
      });
      return;
    }
    name = sessionName(projectName, targetRole as 'brain' | `w${number}`);
  }

  const session = getSession(name);
  if (!session) {
    logger.warn({ jobId, sessionName: name }, 'Cron: target session not found, skipping');
    sendCommandResult(serverLink, {
      type: CRON_MSG.COMMAND_RESULT,
      jobId,
      executionId,
      status: 'error',
      detail: `Cron target session not found: ${name}`,
    });
    return;
  }

  // Cross-project guard: verify sub-session belongs to the expected project
  if (targetSessionName && session.parentSession) {
    const expectedPrefix = `deck_${projectName}_`;
    if (!session.parentSession.startsWith(expectedPrefix)) {
      logger.warn({ jobId, targetSessionName, projectName, parentSession: session.parentSession }, 'Cron: cross-project sub-session targeting blocked');
      sendCommandResult(serverLink, {
        type: CRON_MSG.COMMAND_RESULT,
        jobId,
        executionId,
        status: 'error',
        detail: `Cron target session ${targetSessionName} does not belong to project ${projectName}`,
      });
      return;
    }
  }

  // Busy check — skip tmux detection for transport sessions
  if (session.runtimeType === 'transport') {
    logger.debug({ jobId, sessionName: name }, 'Cron: transport session, skipping busy check');
  } else {
    try {
      const status = await detectStatusAsync(name, session.agentType as AgentType);
      if (BUSY_STATES.has(status)) {
        logger.info({ jobId, sessionName: name, status }, 'Cron: session busy, skipping');
        sendCommandResult(serverLink, {
          type: CRON_MSG.COMMAND_RESULT,
          jobId,
          executionId,
          status: 'skipped_busy',
          detail: `Cron target session is busy: ${name} (${status})`,
        });
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
          const result = await runtime.send(action.command);
          if (result !== 'queued') {
            timelineEmitter.emit(name, 'user.message', { text: action.command, allowDuplicate: true });
          }
        } catch (err) {
          logger.error({ jobId, sessionName: name, err }, 'Cron: transport send failed');
          sendCommandResult(serverLink, {
            type: CRON_MSG.COMMAND_RESULT,
            jobId,
            executionId,
            status: 'error',
            detail: `Cron transport send failed for ${name}: ${formatErr(err)}`,
          });
        }
      } else {
        logger.warn({ jobId, sessionName: name }, 'Cron: transport provider not connected');
        sendCommandResult(serverLink, {
          type: CRON_MSG.COMMAND_RESULT,
          jobId,
          executionId,
          status: 'error',
          detail: `Cron transport provider not connected for ${name}`,
        });
      }
    } else {
      await sendKeys(name, action.command, { cwd: session.projectDir });
      timelineEmitter.emit(name, 'user.message', { text: action.command, allowDuplicate: true });
    }

    // Capture agent response: collect assistant.text events until session goes idle
    collectCommandResult(name, jobId, executionId, serverLink);
    return;
  }

  if (action.type === 'p2p') {
    const { topic, mode, rounds } = action;

    // Resolve participants: support both legacy string[] and new discriminated entries
    const resolveParticipant = (p: CronParticipant | string): string => {
      if (typeof p === 'string') return sessionName(projectName, p as 'brain' | `w${number}`);
      return p.type === 'session' ? p.value : sessionName(projectName, p.value as 'brain' | `w${number}`);
    };

    const allParticipants: (CronParticipant | string)[] = [
      ...(action.participantEntries ?? []),
      ...(action.participants ?? []),
    ];

    const seen = new Set<string>();
    const targets: P2pTarget[] = allParticipants
      .map(p => ({ session: resolveParticipant(p), mode }))
      .filter(t => {
        if (seen.has(t.session)) return false;
        seen.add(t.session);
        return !!getSession(t.session);
      });

    if (targets.length === 0) {
      logger.warn({ jobId, jobName }, 'Cron: no valid P2P participants, skipping');
      sendCommandResult(serverLink, {
        type: CRON_MSG.COMMAND_RESULT,
        jobId,
        executionId,
        status: 'error',
        detail: 'Cron P2P job has no valid participants',
      });
      return;
    }

    logger.info({ jobId, jobName, initiator: name, targets: targets.length, mode }, 'Cron: starting P2P discussion');
    const run = await startP2pRun({
      initiatorSession: name,
      targets,
      userText: topic,
      fileContents: [],
      serverLink,
      rounds: rounds ?? 1,
    });
    // Link cron execution to P2P discussion so frontend can navigate
    try {
      serverLink.send({ type: 'cron.p2p_linked', jobId, discussionId: run.discussionId, runId: run.id });
    } catch { /* not critical */ }
    return;
  }

  logger.warn({ jobId, actionType: (action as Record<string, unknown>).type }, 'Cron: unknown action type');
  sendCommandResult(serverLink, {
    type: CRON_MSG.COMMAND_RESULT,
    jobId,
    executionId,
    status: 'error',
    detail: `Cron action type is unknown: ${String((action as Record<string, unknown>).type ?? 'unknown')}`,
  });
}

/** Collect assistant output after a cron command until session goes idle, then send result to server. */
function collectCommandResult(sessionId: string, jobId: string, executionId: string | undefined, serverLink: ServerLink): void {
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min max
  const MAX_DETAIL_LEN = 4000;
  const collected: string[] = [];
  const startTs = Date.now();

  const handler = (e: TimelineEvent) => {
    if (e.sessionId !== sessionId) return;
    // Skip events from before this cron dispatch (prevents capturing stale output)
    if (e.ts < startTs) return;
    if (Date.now() - startTs > MAX_WAIT_MS) {
      logger.warn({ jobId, executionId, sessionId }, 'Cron: command result timed out');
      sendCommandResult(serverLink, {
        type: CRON_MSG.COMMAND_RESULT,
        jobId,
        executionId,
        status: 'error',
        detail: `Cron command timed out waiting for response from ${sessionId}`,
      });
      cleanup();
      return;
    }

    if (e.type === 'assistant.text' && typeof e.payload.text === 'string') {
      collected.push(e.payload.text);
    }

    if (e.type === 'session.state' && e.payload.state === 'idle' && collected.length > 0) {
      const detail = collected.join('\n').slice(0, MAX_DETAIL_LEN);
      logger.info({ jobId, executionId, sessionId, detailLength: detail.length }, 'Cron: command result captured');
      sendCommandResult(serverLink, { type: CRON_MSG.COMMAND_RESULT, jobId, executionId, detail });
      cleanup();
    }
  };

  const unsub = timelineEmitter.on(handler);
  const timer = setTimeout(cleanup, MAX_WAIT_MS);

  function cleanup() {
    clearTimeout(timer);
    unsub();
  }
}

function sendCommandResult(serverLink: ServerLink, msg: CronCommandResultMessage, attempt = 1): void {
  try {
    serverLink.send(msg);
    logger.info({ jobId: msg.jobId, executionId: msg.executionId, attempt, status: msg.status }, 'Cron: command result sent');
  } catch (err) {
    const maxAttempts = 12;
    logger.warn({ jobId: msg.jobId, executionId: msg.executionId, attempt, err }, 'Cron: command result send failed');
    if (attempt >= maxAttempts) return;
    const delayMs = Math.min(30_000, 1000 * attempt);
    setTimeout(() => sendCommandResult(serverLink, msg, attempt + 1), delayMs);
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
