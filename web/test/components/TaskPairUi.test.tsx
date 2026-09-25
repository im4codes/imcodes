/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { TaskPairSettingsSection, type TaskPairSettingsValue } from '../../src/components/TaskPairSettingsSection.js';
import { TASK_PAIR_DEFAULT_ALLOWLIST, TASK_PAIR_STATUSES } from '../../../shared/task-pair.js';

describe('TaskPairEventChip', () => {
  afterEach(() => cleanup());

  it('shows the task, writer, verb, new status and non-zero severity counts', () => {
    const { container } = render(<TaskPairEventChip eventId="e1" payload={{
      taskId: 'T42', title: 'Fix login', writer: 'deck_sub_aud', verb: 'REWORK', toStatus: 'rework',
      severityCounts: { P0: 1, P1: 0, P2: 2, P3: 0, P4: 0 }, verdictJudgement: 'consistent', unusual: false,
    }} />);
    const chip = container.querySelector('.task-pair-chip')!;
    expect(chip.getAttribute('data-task-id')).toBe('T42');
    expect(chip.textContent).toContain('T42 · Fix login');
    expect(chip.textContent).toContain('taskPair.chip:{"writer":"deck_sub_aud","verb":"taskPair.verb.rework"}');
    expect(chip.textContent).toContain('taskPair.status.rework');
    expect(chip.textContent).toContain('taskPair.severity:{"level":"P0","count":1}');
    expect(chip.textContent).toContain('taskPair.severity:{"level":"P2","count":2}');
    expect(chip.textContent).not.toContain('"level":"P1"');
    expect(chip.textContent).not.toContain('taskPair.verdict_held');
  });

  it('marks a held verdict and an unusual event, and names the daemon', () => {
    const { container } = render(<TaskPairEventChip eventId="e2" payload={{
      taskId: 'T42', writer: 'daemon', verb: 'PASS', verdictJudgement: 'inconsistent', unusual: true,
    }} />);
    const chip = container.querySelector('.task-pair-chip')!;
    expect(chip.classList.contains('task-pair-chip--held')).toBe(true);
    expect(chip.textContent).toContain('taskPair.verdict_held');
    expect(chip.textContent).toContain('taskPair.unusual');
    expect(chip.textContent).toContain('"writer":"taskPair.daemon"');
  });
});

describe('TaskPairEventChip status colours', () => {
  afterEach(() => cleanup());
  const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
  const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');
  /** The `--task-pair-status-text` value a status class sets, e.g. `var(--status-pass-text)`. */
  const statusTextToken = (status: string): string | undefined => {
    const rule = new RegExp(`\\.task-pair-chip--${status} \\{([^}]*)\\}`).exec(css)?.[1];
    return /--task-pair-status-text:\s*([^;]+);/.exec(rule ?? '')?.[1]?.trim();
  };

  it('gives every pair status its own class and its own colour', () => {
    for (const status of TASK_PAIR_STATUSES) {
      const { container } = render(<TaskPairEventChip eventId={`e-${status}`} payload={{ taskId: 'T1', writer: 'w', verb: 'WORKING', toStatus: status }} />);
      const chip = container.querySelector('.task-pair-chip')!;
      expect(chip.classList.contains(`task-pair-chip--${status}`), status).toBe(true);
      expect(chip.getAttribute('data-task-status')).toBe(status);
      cleanup();
    }
    const tokens = TASK_PAIR_STATUSES.map((status) => statusTextToken(status));
    expect(tokens.every(Boolean), JSON.stringify(tokens)).toBe(true);
    expect(new Set(tokens).size).toBe(TASK_PAIR_STATUSES.length);
  });

  it('shows PASS and REWORK in the shared verdict colours, not the same one', () => {
    expect(statusTextToken('passed')).toBe('var(--status-pass-text)');
    expect(statusTextToken('rework')).toBe('var(--status-rework-text)');
    // The same tokens drive the peer-audit verdict pill, so one verdict has one colour.
    expect(css).toContain('.peer-audit-result-outcome--pass { border-color: var(--status-pass-border); color: var(--status-pass-text); }');
    expect(css).toContain('.peer-audit-result-outcome--rework { border-color: var(--status-rework-border); color: var(--status-rework-text); }');
  });

  it('adds no status class to an event that changed no status', () => {
    const { container } = render(<TaskPairEventChip eventId="e-none" payload={{ taskId: '-', writer: 'w', verb: 'BOGUS' }} />);
    const chip = container.querySelector('.task-pair-chip')!;
    expect([...chip.classList].some((name) => /^task-pair-chip--(?!held|unusual)/.test(name))).toBe(false);
  });
});

describe('TaskPairSettingsSection', () => {
  afterEach(() => cleanup());

  it('edits engine, limit and allowlist starting from the defaults', () => {
    let value: TaskPairSettingsValue = {};
    const onChange = vi.fn((next: TaskPairSettingsValue) => { value = next; });
    const view = render(<TaskPairSettingsSection value={value} onChange={onChange} />);
    expect((screen.getByTestId('task-pair-engine') as HTMLSelectElement).value).toBe('pairs');
    expect((screen.getByTestId('task-pair-max-concurrency') as HTMLInputElement).value).toBe('5');
    expect(screen.getAllByTestId(/task-pair-allowlist-row-/)).toHaveLength(TASK_PAIR_DEFAULT_ALLOWLIST.length);

    const engine = screen.getByTestId('task-pair-engine') as HTMLSelectElement;
    engine.value = 'legacy';
    fireEvent.input(engine);
    fireEvent.change(engine);
    expect(value.pairEngine).toBe('legacy');
    fireEvent.input(screen.getByTestId('task-pair-max-concurrency'), { target: { value: '8' } });
    expect(value.pairMaxConcurrency).toBe(8);

    view.rerender(<TaskPairSettingsSection value={value} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('task-pair-allowlist-add'));
    expect(value.pairAllowlist).toHaveLength(TASK_PAIR_DEFAULT_ALLOWLIST.length + 1);
    expect(value.pairAllowlist?.at(-1)).toEqual({ role: 'both', agentType: '', modelPattern: '' });
  });
});
