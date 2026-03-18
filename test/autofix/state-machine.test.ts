import { describe, it, expect } from 'vitest';
import {
  createTask,
  transition,
  canTransition,
  StateMachineError,
} from '../../src/autofix/state-machine.js';

function makeTask(overrides = {}) {
  return createTask({
    title: 'Fix bug #42',
    description: 'Description of bug',
    coderSession: 'deck_proj_w1',
    auditorSession: 'deck_proj_brain',
    projectName: 'proj',
    maxDiscussionRounds: 3,
    ...overrides,
  });
}

describe('createTask', () => {
  it('starts in planning state', () => {
    const task = makeTask();
    expect(task.state).toBe('planning');
  });

  it('assigns auto-generated id if not provided', () => {
    const task = makeTask();
    expect(task.id).toMatch(/^task_\d+_/);
  });

  it('uses provided id', () => {
    const task = makeTask({ id: 'fixed-id' });
    expect(task.id).toBe('fixed-id');
  });

  it('defaults maxDiscussionRounds to 3', () => {
    const task = createTask({
      title: 't', description: 'd',
      coderSession: 's1', auditorSession: 's2', projectName: 'p',
    });
    expect(task.maxDiscussionRounds).toBe(3);
  });
});

describe('canTransition', () => {
  it('allows valid transitions', () => {
    const task = makeTask();
    expect(canTransition(task, 'submit_design')).toBe(true);
    expect(canTransition(task, 'fail')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    const task = makeTask();
    expect(canTransition(task, 'approve_code')).toBe(false);
    expect(canTransition(task, 'complete')).toBe(false);
  });
});

describe('transition', () => {
  it('planning → design_review on submit_design', () => {
    const task = makeTask();
    const next = transition(task, 'submit_design');
    expect(next.state).toBe('design_review');
  });

  it('design_review → implementing on approve_design', () => {
    const task = transition(makeTask(), 'submit_design');
    const next = transition(task, 'approve_design');
    expect(next.state).toBe('implementing');
  });

  it('design_review → planning on reject_design', () => {
    const task = transition(makeTask(), 'submit_design');
    const next = transition(task, 'reject_design');
    expect(next.state).toBe('planning');
    expect(next.discussionRounds).toBe(1);
  });

  it('implementing → code_review on submit_code', () => {
    let task = makeTask();
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    const next = transition(task, 'submit_code');
    expect(next.state).toBe('code_review');
  });

  it('code_review → approved on approve_code', () => {
    let task = makeTask();
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    task = transition(task, 'submit_code');
    const next = transition(task, 'approve_code');
    expect(next.state).toBe('approved');
  });

  it('approved → done on complete', () => {
    let task = makeTask();
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    task = transition(task, 'submit_code');
    task = transition(task, 'approve_code');
    const next = transition(task, 'complete');
    expect(next.state).toBe('done');
  });

  it('any state → failed on fail', () => {
    const task = makeTask();
    expect(transition(task, 'fail').state).toBe('failed');
  });

  it('throws StateMachineError on invalid transition', () => {
    const task = makeTask();
    expect(() => transition(task, 'approve_code')).toThrow(StateMachineError);
    expect(() => transition(task, 'approve_code')).toThrow(/Invalid transition/);
  });

  it('done state has no valid transitions', () => {
    let task = makeTask();
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    task = transition(task, 'submit_code');
    task = transition(task, 'approve_code');
    task = transition(task, 'complete');
    expect(() => transition(task, 'fail')).toThrow(StateMachineError);
  });

  it('increments discussion rounds on reject', () => {
    let task = makeTask({ maxDiscussionRounds: 3 });
    task = transition(task, 'submit_design');
    task = transition(task, 'reject_design'); // round 1
    expect(task.discussionRounds).toBe(1);
    task = transition(task, 'submit_design');
    task = transition(task, 'reject_design'); // round 2
    expect(task.discussionRounds).toBe(2);
  });

  it('fails task when max discussion rounds exceeded', () => {
    let task = makeTask({ maxDiscussionRounds: 2 });
    task = transition(task, 'submit_design');
    task = transition(task, 'reject_design'); // round 1
    task = transition(task, 'submit_design');
    task = transition(task, 'reject_design'); // round 2
    // round 2 = max, next reject should fail
    task = transition(task, 'submit_design');
    const failed = transition(task, 'reject_design'); // round 3 → exceeded
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/Max discussion rounds/);
  });
});
