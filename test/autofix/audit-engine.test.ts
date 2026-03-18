import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tmux helpers before importing AuditEngine
vi.mock('../../src/agent/tmux.js', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  deleteBuffer: vi.fn(),
  showBuffer: vi.fn(),
}));

// Mock ClaudeCodeDriver
vi.mock('../../src/agent/drivers/claude-code.js', () => ({
  ClaudeCodeDriver: vi.fn().mockImplementation(() => ({})),
}));

// Mock logger to suppress output during tests
vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AuditEngine } from '../../src/autofix/audit-engine.js';
import { createTask } from '../../src/autofix/state-machine.js';
import { capturePane, sendKeys } from '../../src/agent/tmux.js';

const mockCapturePane = capturePane as ReturnType<typeof vi.fn>;
const mockSendKeys = sendKeys as ReturnType<typeof vi.fn>;

function makeTask(overrides = {}) {
  return createTask({
    title: 'Fix bug #1',
    description: 'A description of the bug',
    coderSession: 'deck_proj_w1',
    auditorSession: 'deck_proj_brain',
    projectName: 'proj',
    maxDiscussionRounds: 3,
    ...overrides,
  });
}

describe('AuditEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can be instantiated with minimal config', () => {
    const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
    const engine = new AuditEngine({ onTaskUpdate });
    expect(engine).toBeInstanceOf(AuditEngine);
  });

  describe('runDesignReview', () => {
    it('calls sendKeys on the auditor session', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      // capturePane returns coder output then auditor output (APPROVED)
      mockCapturePane
        .mockResolvedValueOnce(['coder design output line 1', 'coder design output line 2'])
        .mockResolvedValueOnce(['APPROVED: Looks good', '❯']);

      mockSendKeys.mockResolvedValue(undefined);

      const task = makeTask();
      // Task must be in design_review state to call approve_design / reject_design
      const { transition } = await import('../../src/autofix/state-machine.js');
      const reviewTask = transition(task, 'submit_design');

      await engine.runDesignReview(reviewTask);

      // sendKeys should have been called on the auditor session with a review prompt
      expect(mockSendKeys).toHaveBeenCalled();
      const [calledSession] = mockSendKeys.mock.calls[0];
      expect(calledSession).toBe('deck_proj_brain');
    });

    it('transitions task to implementing state when output contains APPROVED:', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['coder design'])
        .mockResolvedValueOnce(['APPROVED: Design is solid', '❯']);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      const reviewTask = transition(makeTask(), 'submit_design');

      const { task: updatedTask, result } = await engine.runDesignReview(reviewTask);

      expect(result.approved).toBe(true);
      expect(updatedTask.state).toBe('implementing');
    });

    it('keeps task in planning state when output contains REJECTED:', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['coder design'])
        .mockResolvedValueOnce([
          'REJECTED: Needs more detail',
          '- Missing error handling',
          '- No tests specified',
          '❯',
        ]);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      const reviewTask = transition(makeTask(), 'submit_design');

      const { task: updatedTask, result } = await engine.runDesignReview(reviewTask);

      expect(result.approved).toBe(false);
      expect(updatedTask.state).toBe('planning');
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it('sends findings back to the coder session on rejection', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['coder design'])
        .mockResolvedValueOnce([
          'REJECTED: Issues found',
          '- Missing auth check',
          '❯',
        ]);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      const reviewTask = transition(makeTask(), 'submit_design');

      await engine.runDesignReview(reviewTask);

      // sendKeys should be called twice: once to auditor with review prompt, once to coder with findings
      expect(mockSendKeys).toHaveBeenCalledTimes(2);
      const [coderSession, findingsMsg] = mockSendKeys.mock.calls[1];
      expect(coderSession).toBe('deck_proj_w1');
      expect(findingsMsg).toContain('findings');
    });

    it('calls onTaskUpdate with the updated task', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['coder design'])
        .mockResolvedValueOnce(['APPROVED: Looks great', '❯']);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      const reviewTask = transition(makeTask(), 'submit_design');

      await engine.runDesignReview(reviewTask);

      expect(onTaskUpdate).toHaveBeenCalledOnce();
      const [calledTask] = onTaskUpdate.mock.calls[0];
      expect(calledTask.state).toBe('implementing');
    });
  });

  describe('runCodeReview', () => {
    it('transitions task to approved state when output contains APPROVED:', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['diff output'])
        .mockResolvedValueOnce(['APPROVED: Code is correct', '❯']);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      let task = makeTask();
      task = transition(task, 'submit_design');
      task = transition(task, 'approve_design');
      task = transition(task, 'submit_code');

      const { task: updatedTask, result } = await engine.runCodeReview(task);

      expect(result.approved).toBe(true);
      expect(updatedTask.state).toBe('approved');
    });

    it('transitions task back to implementing when output contains REJECTED:', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['diff output'])
        .mockResolvedValueOnce([
          'REJECTED: Code has issues',
          '- Logic error in loop',
          '❯',
        ]);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      let task = makeTask();
      task = transition(task, 'submit_design');
      task = transition(task, 'approve_design');
      task = transition(task, 'submit_code');

      const { task: updatedTask, result } = await engine.runCodeReview(task);

      expect(result.approved).toBe(false);
      expect(updatedTask.state).toBe('implementing');
    });

    it('calls sendKeys on the auditor session with a code review prompt', async () => {
      const onTaskUpdate = vi.fn().mockResolvedValue(undefined);
      const engine = new AuditEngine({ onTaskUpdate });

      mockCapturePane
        .mockResolvedValueOnce(['diff output'])
        .mockResolvedValueOnce(['APPROVED: LGTM', '❯']);

      mockSendKeys.mockResolvedValue(undefined);

      const { transition } = await import('../../src/autofix/state-machine.js');
      let task = makeTask();
      task = transition(task, 'submit_design');
      task = transition(task, 'approve_design');
      task = transition(task, 'submit_code');

      await engine.runCodeReview(task);

      expect(mockSendKeys).toHaveBeenCalled();
      const [calledSession] = mockSendKeys.mock.calls[0];
      expect(calledSession).toBe('deck_proj_brain');
    });
  });
});
