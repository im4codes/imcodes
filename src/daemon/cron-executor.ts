/**
 * Daemon-side cron job executor.
 * Receives dispatched cron jobs and sends commands to target sessions.
 */
import type { CronCommandResultMessage, CronDispatchMessage, CronParticipant } from '../../shared/cron-types.js';
import {
  CRON_COMPLETION_POLICY,
  CRON_CONTROL_PROTOCOL,
  CRON_MSG,
  normalizeCronCompletionPolicy,
} from '../../shared/cron-types.js';
import { isRawCommandSessionAgentType } from '../../shared/agent-types.js';
import { getSession } from '../store/session-store.js';
import {
  ensureTransportRuntimeAvailable,
  getTransportRuntime,
  sessionName,
} from '../agent/session-manager.js';
import { detectStatusAsync, type AgentType } from '../agent/detect.js';
import { startP2pRun, type P2pTarget } from './p2p-orchestrator.js';
import { prepareAdvancedWorkflowLaunch, sendProcessSessionMessageForAutomation } from './command-handler.js';
import { timelineEmitter } from './timeline-emitter.js';
import type { TimelineEvent } from './timeline-event.js';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';

/** Default retry budget when daemon admission returns `daemon_busy`. */
const CRON_DAEMON_BUSY_DEFAULT_ATTEMPTS = 3;
const CRON_DAEMON_BUSY_DEFAULT_DELAY_MS = 5_000;
const CRON_TRANSIENT_RETRY_DELAY_MS = 60_000;
const CRON_TRANSIENT_MAX_ATTEMPTS = 3;
const CRON_COMMAND_ATTEMPT_TIMEOUT_MS = 13 * 60_000;

const BUSY_STATES = new Set(['streaming', 'thinking', 'tool_running', 'permission']);

export interface CronSendDispatchInput {
  fromSessionName: string;
  target: string;
  message: string;
  reply?: boolean;
  broadcast?: boolean;
  idempotencyKey?: string;
}

export interface CronSendDispatchResult {
  dispatchId: string;
  status?: 'dispatched' | 'partial';
  deliveries: Array<{
    target: string;
    messageId?: string;
    status?: 'delivered' | 'failed';
    error?: string;
  }>;
}

type CronSendDispatcher = (input: CronSendDispatchInput) => Promise<CronSendDispatchResult>;

let cronSendDispatcherOverride: CronSendDispatcher | null = null;
let cronProcessCommandSenderOverride: ((sessionName: string, text: string) => Promise<void>) | null = null;

export function __setCronSendDispatcherForTests(dispatcher: CronSendDispatcher | null): void {
  cronSendDispatcherOverride = dispatcher;
}

export function __setCronProcessCommandSenderForTests(
  sender: ((sessionName: string, text: string) => Promise<void>) | null,
): void {
  cronProcessCommandSenderOverride = sender;
}

export function buildSelfManagedCronPrompt(msg: CronDispatchMessage, message: string): string {
  const completionPolicy = normalizeCronCompletionPolicy(msg.completionPolicy);
  const lifecycleInstruction = completionPolicy === CRON_COMPLETION_POLICY.UNTIL_COMPLETE
    ? 'This schedule repeats until its overall goal is complete. Call cron_cancel_self with this id only when the overall goal—not merely this occurrence—is complete.'
    : 'Recurring task: complete this run and keep it scheduled. Cancel only on an explicit user request; force=true is required.';
  return `${message}\n\n<imcodes-cron-control id=${JSON.stringify(msg.jobId)} completion-policy=${JSON.stringify(completionPolicy)}>\nUse cron_update_self to change this task only when the user explicitly asks.\n${lifecycleInstruction}\nExecute only the operations explicitly requested above. Do not add web fetches, curl requests, or other network checks unless the task explicitly requests them.\nIf an explicitly requested tool returns ${CRON_CONTROL_PROTOCOL.SILENT_RESULT} as its first non-empty line, stop immediately, call no more tools, and finish this occurrence with exactly ${CRON_CONTROL_PROTOCOL.SILENT_RESULT}.\nAlways produce one final response for this occurrence.\n</imcodes-cron-control>`;
}

async function loadCronSendDispatcher(): Promise<CronSendDispatcher> {
  if (cronSendDispatcherOverride) return cronSendDispatcherOverride;
  const modulePath = './send-dispatcher.js';
  const loaded = await import(modulePath) as { dispatchCronSend?: unknown };
  if (typeof loaded.dispatchCronSend !== 'function') {
    throw new Error('cron send dispatcher integration is unavailable');
  }
  return loaded.dispatchCronSend as CronSendDispatcher;
}

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
    const command = action.selfManaged && !isRawCommandSessionAgentType(session.agentType)
      ? buildSelfManagedCronPrompt(msg, action.command)
      : action.command;

    if (session.runtimeType === 'transport') {
      let runtime = getTransportRuntime(name);
      if (!runtime?.providerSessionId) {
        logger.info({ jobId, sessionName: name }, 'Cron: transport runtime missing or unbound, restoring on demand');
        try {
          runtime = await ensureTransportRuntimeAvailable(name);
        } catch (err) {
          logger.error({ jobId, sessionName: name, err }, 'Cron: transport runtime restore failed');
          sendCommandResult(serverLink, {
            type: CRON_MSG.COMMAND_RESULT,
            jobId,
            executionId,
            status: 'error',
            detail: `Cron transport runtime restore failed for ${name}: ${formatErr(err)}`,
          });
          return;
        }
      }
      if (runtime) {
        const transportRuntime = runtime;
        const dispatchAttempt = async (attempt: number): Promise<void> => {
          if (attempt > 1 && transportRuntime.getStatus() !== 'idle') {
            await transportRuntime.cancel();
          }
          const clientMessageId = `cron:${jobId}:${executionId ?? 'dispatch'}:attempt:${attempt}`;
          const result = await transportRuntime.send(command, clientMessageId);
          if (result !== 'queued') {
            timelineEmitter.emit(name, 'user.message', { text: command, allowDuplicate: true });
          }
        };
        const collector = collectCommandResult(name, jobId, executionId, serverLink, {
          retry: dispatchAttempt,
          retryDelayMs: CRON_TRANSIENT_RETRY_DELAY_MS,
          maxAttempts: CRON_TRANSIENT_MAX_ATTEMPTS,
          maxWaitMs: CRON_COMMAND_ATTEMPT_TIMEOUT_MS,
        });
        try {
          await dispatchAttempt(1);
        } catch (err) {
          collector.cancel();
          logger.error({ jobId, sessionName: name, err }, 'Cron: transport send failed');
          sendCommandResult(serverLink, {
            type: CRON_MSG.COMMAND_RESULT,
            jobId,
            executionId,
            status: 'error',
            detail: `Cron transport send failed for ${name}: ${formatErr(err)}`,
          });
          return;
        }
      } else {
        logger.warn({ jobId, sessionName: name }, 'Cron: transport runtime unavailable after restore');
        sendCommandResult(serverLink, {
          type: CRON_MSG.COMMAND_RESULT,
          jobId,
          executionId,
          status: 'error',
          detail: `Cron transport runtime unavailable after restore for ${name}`,
        });
        return;
      }
    } else {
      const collector = collectCommandResult(name, jobId, executionId, serverLink);
      try {
        await (cronProcessCommandSenderOverride ?? sendProcessSessionMessageForAutomation)(name, command);
      } catch (error) {
        collector.cancel();
        logger.error({ jobId, sessionName: name, error }, 'Cron: process session send failed');
        sendCommandResult(serverLink, {
          type: CRON_MSG.COMMAND_RESULT,
          jobId,
          executionId,
          status: 'error',
          detail: `Cron process session send failed for ${name}: ${formatErr(error)}`,
        });
        return;
      }
    }
    return;
  }

  if (action.type === 'send') {
    logger.info({ jobId, jobName, sessionName: name, target: action.target }, 'Cron: dispatching structured send action');
    try {
      const dispatchCronSend = await loadCronSendDispatcher();
      const result = await dispatchCronSend({
        fromSessionName: name,
        target: action.target,
        message: action.message,
        ...(action.reply !== undefined ? { reply: action.reply } : {}),
        ...(action.broadcast !== undefined ? { broadcast: action.broadcast } : {}),
        ...(action.idempotencyKey ? { idempotencyKey: action.idempotencyKey } : {}),
      });
      logger.info({
        jobId,
        executionId,
        dispatchId: result.dispatchId,
        messageIds: result.deliveries.map((delivery) => delivery.messageId),
      }, 'Cron: structured send dispatched');
      sendCommandResult(serverLink, {
        type: CRON_MSG.COMMAND_RESULT,
        jobId,
        executionId,
        status: result.status ?? 'dispatched',
        detail: JSON.stringify({
          dispatchId: result.dispatchId,
          deliveries: result.deliveries,
        }),
      });
    } catch (err) {
      logger.error({ jobId, executionId, err }, 'Cron: structured send dispatch failed');
      sendCommandResult(serverLink, {
        type: CRON_MSG.COMMAND_RESULT,
        jobId,
        executionId,
        status: 'error',
        detail: `Cron structured send failed: ${formatErr(err)}`,
      });
    }
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

    // Audit:R3 hardening / task 10.2 — when the cron action carries
    // `workflowLaunchEnvelope`, route the launch through the SAME envelope
    // path as manual launches so cron inherits capability gating, policy
    // authority enforcement, and `static_policy_mismatch_recompiled` emission.
    // Legacy cron rows without an envelope continue to use the direct path.
    const initiatorRecord = getSession(name);
    const projectDir = initiatorRecord?.projectDir ?? process.cwd();
    const cronActionRecord = action as unknown as {
      workflowLaunchEnvelope?: Record<string, unknown>;
      daemonBusyRetry?: { attempts: number; delayMs: number };
    };
    const envelopeForLaunch = cronActionRecord.workflowLaunchEnvelope;

    // Audit:R3 hardening / task 10.3 — bounded daemon_busy retry. cron
    // dispatcher MUST NOT loop indefinitely: after `attempts` failures,
    // mark the job failed with a stable diagnostic. Default 3 attempts /
    // 5 s delay; overridable per cron job via `daemonBusyRetry`.
    const retry = cronActionRecord.daemonBusyRetry ?? {
      attempts: CRON_DAEMON_BUSY_DEFAULT_ATTEMPTS,
      delayMs: CRON_DAEMON_BUSY_DEFAULT_DELAY_MS,
    };

    let lastDaemonBusyAttempt = 0;
    while (lastDaemonBusyAttempt < retry.attempts) {
      lastDaemonBusyAttempt += 1;
      try {
        let run;
        if (envelopeForLaunch) {
          // Synthesize a minimal cmd Record that prepareAdvancedWorkflowLaunch
          // can parse (it only reads `p2pWorkflowLaunchEnvelope` /
          // `workflowLaunchEnvelope` and old-advanced fields).
          const fakeCmd: Record<string, unknown> = { workflowLaunchEnvelope: envelopeForLaunch };
          const prepared = await prepareAdvancedWorkflowLaunch({
            cmd: fakeCmd,
            sessionName: name,
            targets,
            userText: topic,
            projectDir,
            commandId: `cron-${jobId}-${executionId ?? 'now'}-${lastDaemonBusyAttempt}`,
            serverLink,
          });
          if (!prepared.ok) {
            // Determine whether failure is daemon_busy (retryable) or terminal.
            const busy = prepared.diagnostics.some((d) => d.code === 'daemon_busy');
            if (busy && lastDaemonBusyAttempt < retry.attempts) {
              logger.warn({ jobId, attempt: lastDaemonBusyAttempt, of: retry.attempts }, 'Cron: daemon_busy, retrying');
              await new Promise((r) => setTimeout(r, retry.delayMs));
              continue;
            }
            // Terminal failure (or budget exhausted)
            const codes = prepared.diagnostics.map((d) => d.code).join(', ');
            sendCommandResult(serverLink, {
              type: CRON_MSG.COMMAND_RESULT,
              jobId,
              executionId,
              status: 'error',
              detail: busy
                ? `Cron P2P launch exhausted ${retry.attempts} daemon_busy retries`
                : `Cron P2P launch rejected: ${codes}`,
            });
            return;
          }
          run = await startP2pRun({
            initiatorSession: name,
            targets,
            userText: topic,
            fileContents: [],
            serverLink,
            rounds: rounds ?? 1,
            launchOrigin: {
              kind: 'cron',
              commandId: `cron-${jobId}-${executionId ?? 'now'}-${lastDaemonBusyAttempt}`,
              cronJobId: jobId,
              ...(executionId ? { cronExecutionId: executionId } : {}),
            },
            advanced: {
              kind: 'envelope_compiled',
              bound: prepared.bound!,
              advancedRounds: prepared.advancedRounds,
              ...(prepared.advancedRunTimeoutMs !== undefined ? { advancedRunTimeoutMs: prepared.advancedRunTimeoutMs } : {}),
              ...(prepared.contextReducer ? { contextReducer: prepared.contextReducer } : {}),
            },
          });
        } else {
          // Legacy cron path (no envelope) — direct startP2pRun.
          run = await startP2pRun({
            initiatorSession: name,
            targets,
            userText: topic,
            fileContents: [],
            serverLink,
            rounds: rounds ?? 1,
            launchOrigin: {
              kind: 'cron',
              commandId: `cron-${jobId}-${executionId ?? 'now'}-${lastDaemonBusyAttempt}`,
              cronJobId: jobId,
              ...(executionId ? { cronExecutionId: executionId } : {}),
            },
          });
        }
        // Link cron execution to P2P discussion so frontend can navigate
        try {
          serverLink.send({ type: 'cron.p2p_linked', jobId, discussionId: run.discussionId, runId: run.id });
        } catch { /* not critical */ }
        return;
      } catch (err) {
        // startP2pRun may throw for non-busy reasons; treat as terminal.
        logger.error({ jobId, err }, 'Cron: P2P launch threw');
        sendCommandResult(serverLink, {
          type: CRON_MSG.COMMAND_RESULT,
          jobId,
          executionId,
          status: 'error',
          detail: `Cron P2P launch failed: ${formatErr(err)}`,
        });
        return;
      }
    }
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

interface CronCommandResultCollectorOptions {
  retry?: (attempt: number) => Promise<void>;
  retryDelayMs?: number;
  maxAttempts?: number;
  maxWaitMs?: number;
}

/** Collect assistant output after a cron command until session goes idle, then send result to server. */
function collectCommandResult(
  sessionId: string,
  jobId: string,
  executionId: string | undefined,
  serverLink: ServerLink,
  options: CronCommandResultCollectorOptions = {},
): { cancel(): void } {
  const MAX_DETAIL_LEN = 4000;
  // `assistant.text` is an in-place timeline projection: transport providers
  // emit cumulative streaming snapshots and then a terminal update. Appending
  // every snapshot produces `H\nHe\nHel\nHello` in cron history (and can fill
  // MAX_DETAIL_LEN before the real answer arrives). Keep only the newest
  // projection for this occurrence, preferring the terminal text when present.
  let latestAssistantText = '';
  let terminalAssistantText = '';
  let attempt = 1;
  let attemptStartTs = Date.now();
  let toolObserved = false;
  let successfulAssistantObserved = false;
  let providerErrorObserved = false;
  let recoverableProviderErrorObserved = false;
  let retryScheduled = false;
  let finished = false;
  let attemptTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unsub = () => {};

  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const maxWaitMs = Math.max(1_000, options.maxWaitMs ?? CRON_COMMAND_ATTEMPT_TIMEOUT_MS);

  const resetAttempt = () => {
    latestAssistantText = '';
    terminalAssistantText = '';
    attemptStartTs = Date.now();
    toolObserved = false;
    successfulAssistantObserved = false;
    providerErrorObserved = false;
    recoverableProviderErrorObserved = false;
    retryScheduled = false;
  };

  const cleanup = () => {
    if (attemptTimer) clearTimeout(attemptTimer);
    if (retryTimer) clearTimeout(retryTimer);
    attemptTimer = null;
    retryTimer = null;
    unsub();
  };

  const finish = (status?: 'error', fallbackDetail?: string) => {
    if (finished) return;
    finished = true;
    const detail = (terminalAssistantText.trim() || latestAssistantText.trim() || fallbackDetail || `Cron command returned no response from ${sessionId}`)
      .slice(0, MAX_DETAIL_LEN);
    logger.info({ jobId, executionId, sessionId, detailLength: detail.length, status }, 'Cron: command result captured');
    sendCommandResult(serverLink, {
      type: CRON_MSG.COMMAND_RESULT,
      jobId,
      executionId,
      ...(status ? { status } : {}),
      detail,
    });
    cleanup();
  };

  const canRetrySafely = () => (
    !!options.retry
    && attempt < maxAttempts
    && !toolObserved
    && !successfulAssistantObserved
    && (!providerErrorObserved || recoverableProviderErrorObserved)
  );

  const scheduleRetry = (reason: 'recoverable_provider_error' | 'timeout') => {
    if (finished || retryScheduled || !canRetrySafely() || !options.retry) return;
    retryScheduled = true;
    if (attemptTimer) {
      clearTimeout(attemptTimer);
      attemptTimer = null;
    }
    const nextAttempt = attempt + 1;
    logger.warn(
      { jobId, executionId, sessionId, attempt, nextAttempt, maxAttempts, retryDelayMs, reason },
      'Cron: retrying a side-effect-free transient transport failure',
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt = nextAttempt;
      resetAttempt();
      armAttemptTimeout();
      void options.retry!(attempt).catch((error) => {
        terminalAssistantText = `Cron transport retry failed for ${sessionId}: ${formatErr(error)}`;
        latestAssistantText = terminalAssistantText;
        providerErrorObserved = true;
        finish('error');
      });
    }, retryDelayMs);
    retryTimer.unref?.();
  };

  const armAttemptTimeout = () => {
    if (attemptTimer) clearTimeout(attemptTimer);
    attemptTimer = setTimeout(() => {
      logger.warn({ jobId, executionId, sessionId, attempt }, 'Cron: command result timed out');
      if (canRetrySafely()) {
        scheduleRetry('timeout');
        return;
      }
      finish('error', `Cron command timed out waiting for response from ${sessionId}`);
    }, maxWaitMs);
    attemptTimer.unref?.();
  };

  const handler = (e: TimelineEvent) => {
    if (finished || retryScheduled || e.sessionId !== sessionId) return;
    if (typeof e.ts === 'number' && e.ts < attemptStartTs) return;
    if (e.type === 'tool.call' || e.type === 'tool.result') toolObserved = true;

    if (e.type === 'assistant.text' && typeof e.payload.text === 'string') {
      latestAssistantText = e.payload.text;
      if (e.payload.streaming !== true) terminalAssistantText = e.payload.text;
      if (typeof e.payload.providerErrorCode === 'string') {
        providerErrorObserved = true;
        recoverableProviderErrorObserved = e.payload.providerErrorRecoverable === true;
      } else {
        successfulAssistantObserved = true;
      }
    }

    if (e.type === 'session.state' && e.payload.state === 'idle' && latestAssistantText.trim()) {
      if (recoverableProviderErrorObserved && canRetrySafely()) {
        scheduleRetry('recoverable_provider_error');
        return;
      }
      finish(providerErrorObserved ? 'error' : undefined);
    }
  };

  unsub = timelineEmitter.on(handler);
  armAttemptTimeout();
  return {
    cancel() {
      if (finished) return;
      finished = true;
      cleanup();
    },
  };
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
