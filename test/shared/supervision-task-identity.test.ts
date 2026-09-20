import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_TASK_TITLE_MAX_CHARS,
  deriveSupervisionTaskTitle,
  formatSupervisionTaskIdentityHeader,
  readSupervisionTaskTitle,
} from '../../shared/supervision-task-identity.js';

describe('concise supervision task titles', () => {
  it('keeps a short objective unchanged on every shared title surface', () => {
    const objective = 'Repair delegation reply titles';
    expect(deriveSupervisionTaskTitle(objective)).toBe(objective);
    expect(readSupervisionTaskTitle(objective)).toBe(objective);
    expect(formatSupervisionTaskIdentityHeader({
      title: objective, taskId: 'tsk_short', assignmentId: 'asg_short',
    }).split('\n')[0]).toBe(`[IM.codes task] ${objective}`);
  });

  it('uses the first sentence and marks that the objective was shortened', () => {
    const objective = 'Repair the delegation reply card title. Preserve the full objective in collapsed details for diagnostics.';
    expect(deriveSupervisionTaskTitle(objective)).toBe('Repair the delegation reply card title.…');
  });

  it('cuts a long Latin objective only at a word boundary', () => {
    const objective = `Implement ${'reliable delegation routing '.repeat(12)}`.trim();
    const title = deriveSupervisionTaskTitle(objective)!;
    expect(Array.from(title).length).toBeLessThanOrEqual(SUPERVISION_TASK_TITLE_MAX_CHARS);
    expect(title).toMatch(/\w…$/u);
    expect(objective.startsWith(title.slice(0, -1))).toBe(true);
    const nextCharacter = objective[title.slice(0, -1).length];
    expect(nextCharacter).toMatch(/\s/u);
  });

  it('bounds CJK on a complete code-point boundary without replacement characters', () => {
    const objective = '修复委派回复卡片标题并保留完整目标'.repeat(20);
    const title = deriveSupervisionTaskTitle(objective)!;
    expect(Array.from(title).length).toBeLessThanOrEqual(SUPERVISION_TASK_TITLE_MAX_CHARS);
    expect(title).toMatch(/…$/u);
    expect(title).not.toContain('\uFFFD');
    expect(objective.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('recognizes a CJK sentence boundary without requiring ASCII whitespace', () => {
    const objective = '修复委派回复卡片标题。完整目标仍保留在折叠详情中。';
    expect(deriveSupervisionTaskTitle(objective)).toBe('修复委派回复卡片标题。…');
  });
});
