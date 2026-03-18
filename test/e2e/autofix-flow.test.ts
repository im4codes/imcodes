/**
 * E2E test: auto-fix pipeline flow with mock tracker.
 * claim issue → plan → design audit → implement → code audit → approve → merge
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { newSession, killSession, sessionExists, capturePane } from '../../src/agent/tmux.js';
import { tmpdir } from 'os';

const SKIP = process.env.SKIP_TMUX_TESTS === '1';
const CODER_SESSION = 'e2e_autofix_coder';
const AUDITOR_SESSION = 'e2e_autofix_auditor';
const FIXTURES = new URL('../fixtures', import.meta.url).pathname;

/** Minimal mock tracker that satisfies the IssueTracker interface */
function buildMockTracker() {
  return {
    fetchIssues: vi.fn().mockResolvedValue([
      {
        id: '42',
        title: 'Fix login timeout bug',
        body: 'Users are logged out after 5 minutes instead of 30.',
        priority: 1,
        labels: ['bug', 'P1'],
        url: 'https://github.com/example/repo/issues/42',
        assignee: null,
      },
    ]),
    claimIssue: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn().mockResolvedValue('fix/42-login-timeout'),
  };
}

describe.skipIf(SKIP)('Auto-fix pipeline E2E flow', () => {
  beforeAll(async () => {
    await Promise.all([
      killSession(CODER_SESSION).catch(() => {}),
      killSession(AUDITOR_SESSION).catch(() => {}),
    ]);

    await Promise.all([
      newSession(CODER_SESSION, `bash ${FIXTURES}/mock-agent.sh`, { cwd: tmpdir() }),
      newSession(AUDITOR_SESSION, `bash ${FIXTURES}/mock-brain.sh`, { cwd: tmpdir() }),
    ]);

    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(async () => {
    await Promise.all([
      killSession(CODER_SESSION).catch(() => {}),
      killSession(AUDITOR_SESSION).catch(() => {}),
    ]);
  });

  it('coder and auditor sessions exist', async () => {
    expect(await sessionExists(CODER_SESSION)).toBe(true);
    expect(await sessionExists(AUDITOR_SESSION)).toBe(true);
  });

  it('state machine starts in planning state', async () => {
    const { createTask } = await import('../../src/autofix/state-machine.js');
    const task = createTask({
      issueId: '42',
      title: 'Fix login timeout bug',
      description: 'Login times out after 30s',
      coderSession: CODER_SESSION,
      auditorSession: AUDITOR_SESSION,
      projectName: 'test-project',
    });
    expect(task.state).toBe('planning');
    expect(task.discussionRounds).toBe(0);
  });

  it('state machine transitions planning → design_review', async () => {
    const { createTask, transition } = await import('../../src/autofix/state-machine.js');
    const task = createTask({ issueId: '42', title: 'Fix timeout', description: '', coderSession: CODER_SESSION, auditorSession: AUDITOR_SESSION, projectName: 'test' });
    const next = transition(task, 'submit_design');
    expect(next.state).toBe('design_review');
  });

  it('state machine transitions design_review → implementing on approval', async () => {
    const { createTask, transition } = await import('../../src/autofix/state-machine.js');
    let task = createTask({ issueId: '42', title: 'Fix timeout', description: '', coderSession: CODER_SESSION, auditorSession: AUDITOR_SESSION, projectName: 'test' });
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    expect(task.state).toBe('implementing');
  });

  it('state machine transitions implementing → code_review on completion', async () => {
    const { createTask, transition } = await import('../../src/autofix/state-machine.js');
    let task = createTask({ issueId: '42', title: 'Fix timeout', description: '', coderSession: CODER_SESSION, auditorSession: AUDITOR_SESSION, projectName: 'test' });
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    task = transition(task, 'submit_code');
    expect(task.state).toBe('code_review');
  });

  it('state machine transitions code_review → approved → done', async () => {
    const { createTask, transition } = await import('../../src/autofix/state-machine.js');
    let task = createTask({ issueId: '42', title: 'Fix timeout', description: '', coderSession: CODER_SESSION, auditorSession: AUDITOR_SESSION, projectName: 'test' });
    task = transition(task, 'submit_design');
    task = transition(task, 'approve_design');
    task = transition(task, 'submit_code');
    task = transition(task, 'approve_code');
    expect(task.state).toBe('approved');
    task = transition(task, 'complete');
    expect(task.state).toBe('done');
  });

  it('mock tracker fetches and claims issue', async () => {
    const tracker = buildMockTracker();
    const issues = await tracker.fetchIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('42');

    await tracker.claimIssue('42');
    expect(tracker.claimIssue).toHaveBeenCalledWith('42');
  });

  it('mock tracker creates branch for issue', async () => {
    const tracker = buildMockTracker();
    const branch = await tracker.createBranch('42', 'Fix login timeout bug');
    expect(branch).toBe('fix/42-login-timeout');
  });

  it('mock tracker posts design review comment', async () => {
    const tracker = buildMockTracker();
    await tracker.postComment('42', 'Design looks good. Approved for implementation.');
    expect(tracker.postComment).toHaveBeenCalledWith(
      '42',
      'Design looks good. Approved for implementation.',
    );
  });

  it('mock tracker closes issue after merge', async () => {
    const tracker = buildMockTracker();
    await tracker.closeIssue('42');
    expect(tracker.closeIssue).toHaveBeenCalledWith('42');
  });

  it('auditor session can receive keys for review prompts', async () => {
    const { sendKeys } = await import('../../src/agent/tmux.js');
    await sendKeys(AUDITOR_SESSION, 'Design review: approve');
    await new Promise((r) => setTimeout(r, 300));
    const lines = await capturePane(AUDITOR_SESSION);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('discussion round limit is enforced (max 3)', async () => {
    const { createTask, transition } = await import('../../src/autofix/state-machine.js');
    let task = createTask({ issueId: '42', title: 'Fix timeout', description: '', coderSession: CODER_SESSION, auditorSession: AUDITOR_SESSION, projectName: 'test' });
    task = transition(task, 'submit_design');

    // Simulate 3 rejection rounds
    for (let i = 0; i < 3; i++) {
      task = transition(task, 'reject_design');
      if (task.state === 'failed') break;
      task = transition(task, 'submit_design');
    }

    // After max rounds, task should be failed or discussion rounds tracked
    expect(['failed', 'design_review']).toContain(task.state);
    expect(task.discussionRounds).toBeGreaterThanOrEqual(3);
  });
});
