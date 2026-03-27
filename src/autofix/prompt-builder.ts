/**
 * Phase-specific prompt builders for auto-fix pipeline.
 * Each phase gets a tailored system prompt that focuses the agent's behavior.
 */
import type { AutoFixState } from './state-machine.js';

export interface PromptContext {
  taskTitle: string;
  taskDescription: string;
  projectName: string;
  coderAgent: string;
  auditorAgent: string;
  discussionRound?: number;
  maxRounds?: number;
  previousFindings?: string[];
  workerList?: string[];
}

/**
 * Build phase-specific prompt for the brain/auditor agent.
 */
export function buildPhasePrompt(phase: AutoFixState, ctx: PromptContext): string {
  switch (phase) {
    case 'planning':
      return buildPlanningPrompt(ctx);
    case 'design_review':
      return buildDesignReviewPrompt(ctx);
    case 'implementing':
      return buildImplementingPrompt(ctx);
    case 'code_review':
      return buildCodeReviewPrompt(ctx);
    case 'approved':
      return buildApprovedPrompt(ctx);
    default:
      return '';
  }
}

function buildPlanningPrompt(ctx: PromptContext): string {
  return `# Auto-Fix Pipeline — Planning Phase

You are the brain coordinating an auto-fix task.

**Task:** ${ctx.taskTitle}
**Project:** ${ctx.projectName}
**Coder agent:** ${ctx.coderAgent} (session: ${ctx.coderAgent})
**Auditor agent:** ${ctx.auditorAgent} (session: ${ctx.auditorAgent})

**Instructions:**
1. Send the task description to the coder worker using @w1
2. Tell the coder to create a design document first, before any code changes
3. Wait for the coder to complete the design (you'll see @status idle)
4. Then trigger a design review with @audit w1

**Task description to send:**
${ctx.taskDescription}`;
}

function buildDesignReviewPrompt(ctx: PromptContext): string {
  const roundInfo = ctx.discussionRound
    ? ` (Round ${ctx.discussionRound}/${ctx.maxRounds})`
    : '';

  return `# Auto-Fix Pipeline — Design Review${roundInfo}

You are reviewing a design proposal from the coder.

**Task:** ${ctx.taskTitle}
${ctx.previousFindings?.length ? `\n**Previous findings addressed:**\n${ctx.previousFindings.join('\n')}` : ''}

**Your review should evaluate:**
- Is the technical approach sound?
- Are security implications considered?
- Are edge cases handled?
- Is it consistent with existing architecture?

**Decision format:**
- If acceptable: \`APPROVED: <brief summary>\`
- If changes needed: \`REJECTED: <specific issues as bullet points>\``;
}

function buildImplementingPrompt(ctx: PromptContext): string {
  return `# Auto-Fix Pipeline — Implementation Phase

The design has been approved. Now implement the solution.

**Task:** ${ctx.taskTitle}
**Project:** ${ctx.projectName}

**Instructions:**
1. Follow the approved design document
2. Implement the changes with proper error handling
3. Write or update tests for the changed code
4. Run the test suite to verify nothing is broken
5. When complete, notify the brain (write a completion report)

Your completion report should include:
- Files modified/created
- Tests added/updated
- Any deviations from the design (if necessary)`;
}

function buildCodeReviewPrompt(ctx: PromptContext): string {
  const roundInfo = ctx.discussionRound
    ? ` (Round ${ctx.discussionRound}/${ctx.maxRounds})`
    : '';

  return `# Auto-Fix Pipeline — Code Review${roundInfo}

You are reviewing the implementation from the coder.

**Task:** ${ctx.taskTitle}
${ctx.previousFindings?.length ? `\n**Previous issues to verify are fixed:**\n${ctx.previousFindings.join('\n')}` : ''}

**Your review should evaluate:**
- Does it correctly implement the requirements?
- Are there bugs or logic errors?
- Security issues? (injection, auth bypass, data exposure, secret leaks)
- Are tests sufficient?
- Code quality and maintainability?

**Decision format:**
- If acceptable: \`APPROVED: <brief summary>\`
- If changes needed: \`REJECTED: <specific issues as bullet points>\``;
}

function buildApprovedPrompt(ctx: PromptContext): string {
  return `# Auto-Fix Pipeline — Approved

The implementation has been approved!

**Task:** ${ctx.taskTitle}
**Project:** ${ctx.projectName}

**Next steps:**
1. Push the changes to the feature branch
2. ${ctx.taskDescription.includes('tracker') ? 'Close the issue in the tracker' : 'Mark the task as complete'}

Use @merge to push and merge the changes.`;
}

/**
 * Build a discussion prompt for a rejection round.
 */
export function buildDiscussionPrompt(
  coderResponse: string,
  findings: string[],
  round: number,
  maxRounds: number,
): string {
  return `# Round ${round}/${maxRounds} Discussion

**Coder's response:**
${coderResponse}

**Original findings:**
${findings.map((f, i) => `${i + 1}. ${f}`).join('\n')}

**Re-evaluation:**
Evaluate if the coder's response adequately addresses each finding.
If all issues are resolved: \`APPROVED: <summary>\`
If issues remain: \`REJECTED: <remaining issues>\``;
}
