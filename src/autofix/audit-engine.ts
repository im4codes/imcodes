/**
 * Cross-agent audit orchestration.
 * Coder (brain/worker) produces designs/code → Auditor reviews → discussion rounds.
 */
import type { AutoFixTask } from './state-machine.js';
import { transition } from './state-machine.js';
import { capturePane, sendKeys } from '../agent/tmux.js';
import logger from '../util/logger.js';

export interface AuditResult {
  approved: boolean;
  findings: string[];
  summary: string;
}

export interface AuditEngineOptions {
  onTaskUpdate: (task: AutoFixTask) => Promise<void>;
}

export class AuditEngine {
  constructor(private opts: AuditEngineOptions) {}

  /**
   * Run design review: capture coder output, send to auditor, parse result.
   */
  async runDesignReview(task: AutoFixTask): Promise<{ task: AutoFixTask; result: AuditResult }> {
    logger.info({ taskId: task.id, state: task.state }, 'Running design review');

    // Capture coder's design document
    const coderOutput = await this.captureAgentOutput(task.coderSession);

    // Send to auditor for design review
    const reviewPrompt = buildDesignReviewPrompt(task.title, coderOutput);
    await sendKeys(task.auditorSession, reviewPrompt);

    // Wait for auditor to complete (up to 120s)
    const auditorOutput = await this.waitForIdle(task.auditorSession, 120_000);
    const result = parseAuditResult(auditorOutput);

    // Transition state
    let updatedTask: AutoFixTask;
    if (result.approved) {
      updatedTask = transition(task, 'approve_design');
      logger.info({ taskId: task.id }, 'Design approved');
    } else {
      updatedTask = transition(task, 'reject_design');
      // Send findings back to coder
      const findingsMsg = `Design review findings:\n${result.findings.join('\n')}\n\nPlease revise.`;
      await sendKeys(task.coderSession, findingsMsg);
      logger.info({ taskId: task.id, findings: result.findings.length }, 'Design rejected — findings sent to coder');
    }

    await this.opts.onTaskUpdate(updatedTask);
    return { task: updatedTask, result };
  }

  /**
   * Run code review: capture diff/output, send to auditor, parse result.
   */
  async runCodeReview(task: AutoFixTask): Promise<{ task: AutoFixTask; result: AuditResult }> {
    logger.info({ taskId: task.id, state: task.state }, 'Running code review');

    const coderOutput = await this.captureAgentOutput(task.coderSession);
    const reviewPrompt = buildCodeReviewPrompt(task.title, task.description, coderOutput);
    await sendKeys(task.auditorSession, reviewPrompt);

    const auditorOutput = await this.waitForIdle(task.auditorSession, 120_000);
    const result = parseAuditResult(auditorOutput);

    let updatedTask: AutoFixTask;
    if (result.approved) {
      updatedTask = transition(task, 'approve_code');
      logger.info({ taskId: task.id }, 'Code approved');
    } else {
      updatedTask = transition(task, 'reject_code');
      const findingsMsg = `Code review findings:\n${result.findings.join('\n')}\n\nPlease address these issues.`;
      await sendKeys(task.coderSession, findingsMsg);
      logger.info({ taskId: task.id, findings: result.findings.length }, 'Code rejected — findings sent to coder');
    }

    await this.opts.onTaskUpdate(updatedTask);
    return { task: updatedTask, result };
  }

  private async captureAgentOutput(sessionName: string): Promise<string> {
    const lines = await capturePane(sessionName);
    return (lines as unknown as string[]).join('\n');
  }

  private async waitForIdle(sessionName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const lines = await capturePane(sessionName);
      const linesArr = lines as unknown as string[];
      const lastLine = linesArr[linesArr.length - 1] ?? '';
      if (lastLine.includes('❯') || lastLine.includes('λ') || lastLine.includes('>')) {
        return linesArr.join('\n');
      }
    }
    logger.warn({ sessionName, timeoutMs }, 'waitForIdle timeout');
    const lines = await capturePane(sessionName);
    return (lines as unknown as string[]).join('\n');
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildDesignReviewPrompt(title: string, coderOutput: string): string {
  return `Please review this design proposal for: "${title}"

${coderOutput}

Evaluate:
1. Is the approach technically sound?
2. Are there security concerns?
3. Are edge cases handled?
4. Is it consistent with the existing architecture?

Respond with:
- APPROVED: <brief summary> (if the design is acceptable)
- REJECTED: <list of issues, one per line> (if changes are needed)`;
}

function buildCodeReviewPrompt(title: string, description: string, coderOutput: string): string {
  return `Please review the code implementation for: "${title}"

Task description: ${description}

Implementation output:
${coderOutput}

Evaluate:
1. Does it correctly implement the requirements?
2. Are there bugs or logic errors?
3. Security issues? (injection, auth bypass, data exposure)
4. Code quality and test coverage?

Respond with:
- APPROVED: <brief summary> (if the implementation is acceptable)
- REJECTED: <list of specific issues, one per line> (if changes are needed)`;
}

function parseAuditResult(output: string): AuditResult {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);

  // Look for APPROVED/REJECTED decision
  const approvedLine = lines.find((l) => l.toUpperCase().startsWith('APPROVED'));
  const rejectedLine = lines.find((l) => l.toUpperCase().startsWith('REJECTED'));

  if (approvedLine) {
    const summary = approvedLine.replace(/^APPROVED:?\s*/i, '').trim();
    return { approved: true, findings: [], summary };
  }

  if (rejectedLine) {
    // Collect findings (lines after REJECTED: that start with - or number)
    const rejectedIdx = lines.indexOf(rejectedLine);
    const findings = lines.slice(rejectedIdx + 1).filter((l) => l.startsWith('-') || /^\d+\./.test(l));
    const summary = rejectedLine.replace(/^REJECTED:?\s*/i, '').trim();
    return { approved: false, findings, summary };
  }

  // Default to rejected if no clear decision
  return { approved: false, findings: ['No clear decision in audit output'], summary: 'Unclear audit result' };
}
