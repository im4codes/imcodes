/**
 * Structured JSON decision engine for brain auto-fix actions.
 * Fast-path rules for known states, JSON decisions for complex scenarios.
 */
import type { AutoFixTask, AutoFixState } from './state-machine.js';
import logger from '../util/logger.js';

// ── Decision types ────────────────────────────────────────────────────────────

export type ActionType =
  | 'send_to_worker'
  | 'audit'
  | 'approve_design'
  | 'approve_code'
  | 'push'
  | 'close'
  | 'wait'
  | 'fail';

export interface Decision {
  action: ActionType;
  target?: string;
  message?: string;
  reason?: string;
}

// ── Fast-path rules ───────────────────────────────────────────────────────────

/**
 * Fast-path: determine action based on task state without LLM.
 * Returns null if no fast-path applies (fall through to LLM decision).
 */
export function fastPathDecision(task: AutoFixTask): Decision | null {
  switch (task.state) {
    case 'planning':
      // Always start by sending the task to the coder
      return {
        action: 'send_to_worker',
        target: task.coderSession,
        message: buildPlanningPrompt(task),
      };

    case 'design_review':
      // Trigger design audit
      return { action: 'audit', target: task.auditorSession };

    case 'code_review':
      // Trigger code audit
      return { action: 'audit', target: task.auditorSession };

    case 'approved':
      // Push changes
      return { action: 'push', target: task.branch };

    case 'done':
      return { action: 'close' };

    case 'failed':
      return { action: 'fail', reason: task.error ?? 'Task failed' };

    default:
      return null; // implementing — wait for worker output
  }
}

/**
 * Parse a JSON decision from brain output.
 * Brain outputs: {"action": "...", "target": "...", "message": "..."}
 */
export function parseDecision(text: string): Decision | null {
  try {
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (typeof parsed.action !== 'string') return null;
    return {
      action: parsed.action as ActionType,
      target: typeof parsed.target === 'string' ? parsed.target : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Execute a decision. Returns the (potentially updated) task.
 */
export async function executeDecision(
  decision: Decision,
  task: AutoFixTask,
  executors: DecisionExecutors,
): Promise<AutoFixTask> {
  logger.info({ taskId: task.id, action: decision.action, target: decision.target }, 'Executing decision');

  switch (decision.action) {
    case 'send_to_worker':
      if (decision.target && decision.message) {
        await executors.sendToSession(decision.target, decision.message);
      }
      return task;

    case 'audit':
      if (task.state === 'design_review') {
        return (await executors.runDesignReview(task)).task;
      }
      if (task.state === 'code_review') {
        return (await executors.runCodeReview(task)).task;
      }
      return task;

    case 'approve_design':
    case 'approve_code':
      return task; // Handled by audit engine

    case 'push':
      await executors.pushChanges(task);
      return task;

    case 'close':
      await executors.closeIssue(task);
      return task;

    case 'fail':
      logger.error({ taskId: task.id, reason: decision.reason }, 'Task marked as failed');
      return { ...task, state: 'failed', error: decision.reason };

    case 'wait':
    default:
      return task;
  }
}

// ── Executor interface ────────────────────────────────────────────────────────

export interface DecisionExecutors {
  sendToSession: (sessionName: string, text: string) => Promise<void>;
  runDesignReview: (task: AutoFixTask) => Promise<{ task: AutoFixTask }>;
  runCodeReview: (task: AutoFixTask) => Promise<{ task: AutoFixTask }>;
  pushChanges: (task: AutoFixTask) => Promise<void>;
  closeIssue: (task: AutoFixTask) => Promise<void>;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildPlanningPrompt(task: AutoFixTask): string {
  return `You are tasked with: ${task.title}

${task.description}

Please start by creating a design document that includes:
1. Problem analysis
2. Proposed solution approach
3. Files to be modified/created
4. Potential risks or trade-offs
5. Testing strategy

When your design is complete, I will have it reviewed before you start coding.`;
}
