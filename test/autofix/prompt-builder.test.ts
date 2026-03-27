import { describe, it, expect } from 'vitest';
import { buildPhasePrompt, buildDiscussionPrompt } from '../../src/autofix/prompt-builder.js';
import type { PromptContext } from '../../src/autofix/prompt-builder.js';

const ctx: PromptContext = {
  taskTitle: 'Fix login redirect',
  taskDescription: 'After login, users should redirect to /dashboard',
  projectName: 'my-app',
  coderAgent: 'claude-code',
  auditorAgent: 'codex',
};

describe('buildPhasePrompt', () => {
  it('planning phase includes task title and description', () => {
    const prompt = buildPhasePrompt('planning', ctx);
    expect(prompt).toContain(ctx.taskTitle);
    expect(prompt).toContain(ctx.taskDescription);
    expect(prompt).toContain(ctx.projectName);
  });

  it('planning phase mentions @w1 dispatch and @audit', () => {
    const prompt = buildPhasePrompt('planning', ctx);
    expect(prompt).toContain('@w1');
    expect(prompt).toContain('@audit');
  });

  it('design_review phase includes task title', () => {
    const prompt = buildPhasePrompt('design_review', ctx);
    expect(prompt).toContain(ctx.taskTitle);
    expect(prompt).toContain('APPROVED');
    expect(prompt).toContain('REJECTED');
  });

  it('design_review includes round info when provided', () => {
    const prompt = buildPhasePrompt('design_review', { ...ctx, discussionRound: 2, maxRounds: 3 });
    expect(prompt).toContain('Round 2/3');
  });

  it('design_review includes previous findings when provided', () => {
    const prompt = buildPhasePrompt('design_review', {
      ...ctx,
      previousFindings: ['Issue A', 'Issue B'],
    });
    expect(prompt).toContain('Issue A');
    expect(prompt).toContain('Issue B');
  });

  it('implementing phase includes task title', () => {
    const prompt = buildPhasePrompt('implementing', ctx);
    expect(prompt).toContain(ctx.taskTitle);
    expect(prompt).toContain('implement');
  });

  it('code_review phase includes APPROVED/REJECTED format', () => {
    const prompt = buildPhasePrompt('code_review', ctx);
    expect(prompt).toContain('APPROVED');
    expect(prompt).toContain('REJECTED');
  });

  it('code_review includes round info', () => {
    const prompt = buildPhasePrompt('code_review', { ...ctx, discussionRound: 1, maxRounds: 3 });
    expect(prompt).toContain('Round 1/3');
  });

  it('approved phase includes @merge instruction', () => {
    const prompt = buildPhasePrompt('approved', ctx);
    expect(prompt).toContain('@merge');
    expect(prompt).toContain(ctx.taskTitle);
  });

  it('done/failed phases return empty string', () => {
    expect(buildPhasePrompt('done', ctx)).toBe('');
    expect(buildPhasePrompt('failed', ctx)).toBe('');
  });
});

describe('buildDiscussionPrompt', () => {
  it('includes round info', () => {
    const prompt = buildDiscussionPrompt('The coder responded.', ['Finding A'], 2, 3);
    expect(prompt).toContain('Round 2/3');
  });

  it('includes coder response', () => {
    const prompt = buildDiscussionPrompt('I fixed the issue.', [], 1, 3);
    expect(prompt).toContain("I fixed the issue.");
  });

  it('includes numbered findings', () => {
    const prompt = buildDiscussionPrompt('response', ['First issue', 'Second issue'], 1, 3);
    expect(prompt).toContain('1. First issue');
    expect(prompt).toContain('2. Second issue');
  });

  it('includes APPROVED/REJECTED format', () => {
    const prompt = buildDiscussionPrompt('', [], 1, 3);
    expect(prompt).toContain('APPROVED');
    expect(prompt).toContain('REJECTED');
  });
});
