import { describe, it, expect, vi } from 'vitest';
import {
  fastPathDecision,
  parseDecision,
  executeDecision,
  type DecisionExecutors,
} from '../../src/autofix/decision-engine.js';
import { createTask } from '../../src/autofix/state-machine.js';
import type { AutoFixTask } from '../../src/autofix/state-machine.js';

function makeTask(stateOverride: AutoFixTask['state'] = 'planning'): AutoFixTask {
  const t = createTask({
    title: 'Fix bug',
    description: 'desc',
    coderSession: 'deck_proj_w1',
    auditorSession: 'deck_proj_brain',
    projectName: 'proj',
  });
  return { ...t, state: stateOverride };
}

const noopExecutors: DecisionExecutors = {
  sendToSession: vi.fn().mockResolvedValue(undefined),
  runDesignReview: vi.fn().mockResolvedValue({ task: makeTask('design_review') }),
  runCodeReview: vi.fn().mockResolvedValue({ task: makeTask('code_review') }),
  pushChanges: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
};

describe('fastPathDecision', () => {
  it('planning → send_to_worker', () => {
    const d = fastPathDecision(makeTask('planning'));
    expect(d?.action).toBe('send_to_worker');
    expect(d?.target).toBe('deck_proj_w1');
    expect(d?.message).toBeTruthy();
  });

  it('design_review → audit', () => {
    const d = fastPathDecision(makeTask('design_review'));
    expect(d?.action).toBe('audit');
  });

  it('code_review → audit', () => {
    const d = fastPathDecision(makeTask('code_review'));
    expect(d?.action).toBe('audit');
  });

  it('approved → push', () => {
    const d = fastPathDecision(makeTask('approved'));
    expect(d?.action).toBe('push');
  });

  it('done → close', () => {
    const d = fastPathDecision(makeTask('done'));
    expect(d?.action).toBe('close');
  });

  it('failed → fail', () => {
    const task = { ...makeTask('failed'), error: 'something went wrong' };
    const d = fastPathDecision(task);
    expect(d?.action).toBe('fail');
    expect(d?.reason).toBe('something went wrong');
  });

  it('implementing → null (wait for worker output)', () => {
    const d = fastPathDecision(makeTask('implementing'));
    expect(d).toBeNull();
  });
});

describe('parseDecision', () => {
  it('parses valid JSON decision', () => {
    const text = 'Some context\n{"action":"approve_design","reason":"Looks good"}\nMore text';
    const d = parseDecision(text);
    expect(d?.action).toBe('approve_design');
    expect(d?.reason).toBe('Looks good');
  });

  it('returns null for no JSON', () => {
    expect(parseDecision('No JSON here')).toBeNull();
  });

  it('returns null for JSON without action field', () => {
    expect(parseDecision('{"foo":"bar"}')).toBeNull();
  });

  it('parses with optional fields', () => {
    const d = parseDecision('{"action":"send_to_worker","target":"deck_proj_w1","message":"Do this"}');
    expect(d?.action).toBe('send_to_worker');
    expect(d?.target).toBe('deck_proj_w1');
    expect(d?.message).toBe('Do this');
  });

  it('handles malformed JSON gracefully', () => {
    expect(parseDecision('{action:"bad"}')).toBeNull();
  });
});

describe('executeDecision', () => {
  it('send_to_worker calls sendToSession', async () => {
    const executors = { ...noopExecutors, sendToSession: vi.fn().mockResolvedValue(undefined) };
    const task = makeTask('planning');
    await executeDecision({ action: 'send_to_worker', target: 'deck_proj_w1', message: 'Do task' }, task, executors);
    expect(executors.sendToSession).toHaveBeenCalledWith('deck_proj_w1', 'Do task');
  });

  it('audit with design_review state calls runDesignReview', async () => {
    const executors = { ...noopExecutors, runDesignReview: vi.fn().mockResolvedValue({ task: makeTask() }) };
    await executeDecision({ action: 'audit' }, makeTask('design_review'), executors);
    expect(executors.runDesignReview).toHaveBeenCalledOnce();
  });

  it('audit with code_review state calls runCodeReview', async () => {
    const executors = { ...noopExecutors, runCodeReview: vi.fn().mockResolvedValue({ task: makeTask() }) };
    await executeDecision({ action: 'audit' }, makeTask('code_review'), executors);
    expect(executors.runCodeReview).toHaveBeenCalledOnce();
  });

  it('push calls pushChanges', async () => {
    const executors = { ...noopExecutors, pushChanges: vi.fn().mockResolvedValue(undefined) };
    await executeDecision({ action: 'push' }, makeTask('approved'), executors);
    expect(executors.pushChanges).toHaveBeenCalledOnce();
  });

  it('close calls closeIssue', async () => {
    const executors = { ...noopExecutors, closeIssue: vi.fn().mockResolvedValue(undefined) };
    await executeDecision({ action: 'close' }, makeTask('done'), executors);
    expect(executors.closeIssue).toHaveBeenCalledOnce();
  });

  it('fail returns task with failed state and error', async () => {
    const result = await executeDecision(
      { action: 'fail', reason: 'Too many rounds' },
      makeTask('code_review'),
      noopExecutors,
    );
    expect(result.state).toBe('failed');
    expect(result.error).toBe('Too many rounds');
  });

  it('wait returns task unchanged', async () => {
    const task = makeTask('implementing');
    const result = await executeDecision({ action: 'wait' }, task, noopExecutors);
    expect(result).toEqual(task);
  });
});
