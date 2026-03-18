/**
 * Auto-fix pipeline state machine.
 * States: planning → design_review → implementing → code_review → approved → done | failed
 * In tracker mode, 'done' triggers branch merge + issue close.
 */

export type AutoFixState =
  | 'planning'
  | 'design_review'
  | 'implementing'
  | 'code_review'
  | 'approved'
  | 'done'
  | 'failed';

export interface AutoFixTask {
  id: string;
  issueId?: string;
  title: string;
  description: string;
  state: AutoFixState;
  discussionRounds: number;
  maxDiscussionRounds: number;
  coderSession: string;
  auditorSession: string;
  projectName: string;
  branch?: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

// ── State transitions ─────────────────────────────────────────────────────────

type Transition =
  | 'start_planning'
  | 'submit_design'
  | 'approve_design'
  | 'reject_design'
  | 'start_implementing'
  | 'submit_code'
  | 'approve_code'
  | 'reject_code'
  | 'complete'
  | 'fail';

const VALID_TRANSITIONS: Record<AutoFixState, Transition[]> = {
  planning:      ['submit_design', 'fail'],
  design_review: ['approve_design', 'reject_design', 'fail'],
  implementing:  ['submit_code', 'fail'],
  code_review:   ['approve_code', 'reject_code', 'fail'],
  approved:      ['complete', 'fail'],
  done:          [],
  failed:        [],
};

const STATE_AFTER: Record<Transition, AutoFixState> = {
  start_planning:    'planning',
  submit_design:     'design_review',
  approve_design:    'implementing',
  reject_design:     'planning',
  start_implementing:'implementing',
  submit_code:       'code_review',
  approve_code:      'approved',
  reject_code:       'implementing',
  complete:          'done',
  fail:              'failed',
};

// ── Guards ────────────────────────────────────────────────────────────────────

export class StateMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateMachineError';
  }
}

export function canTransition(task: AutoFixTask, transition: Transition): boolean {
  return VALID_TRANSITIONS[task.state].includes(transition);
}

export function transition(task: AutoFixTask, tr: Transition): AutoFixTask {
  if (!canTransition(task, tr)) {
    throw new StateMachineError(
      `Invalid transition "${tr}" from state "${task.state}" for task "${task.id}"`,
    );
  }

  const newState = STATE_AFTER[tr];
  const updated = { ...task, state: newState, updatedAt: Date.now() };

  // Track discussion rounds
  if (tr === 'reject_design' || tr === 'reject_code') {
    updated.discussionRounds = task.discussionRounds + 1;

    if (updated.discussionRounds > task.maxDiscussionRounds) {
      return { ...updated, state: 'failed', error: `Max discussion rounds (${task.maxDiscussionRounds}) exceeded` };
    }
  }

  return updated;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createTask(opts: {
  id?: string;
  title: string;
  description: string;
  coderSession: string;
  auditorSession: string;
  projectName: string;
  issueId?: string;
  maxDiscussionRounds?: number;
}): AutoFixTask {
  return {
    id: opts.id ?? `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    issueId: opts.issueId,
    title: opts.title,
    description: opts.description,
    state: 'planning',
    discussionRounds: 0,
    maxDiscussionRounds: opts.maxDiscussionRounds ?? 3,
    coderSession: opts.coderSession,
    auditorSession: opts.auditorSession,
    projectName: opts.projectName,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}
