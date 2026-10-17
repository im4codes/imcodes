/**
 * Owner requirement: "合同里一定注明 非必要 不要创建 worktree". A worktree is created only when the task changes tracked files that will
 * be merged; everything else uses workspace=dir or workspace=none. The sentence lives in ONE constant
 * (shared/task-pair-workspace.ts) and every text a Brain, executor or auditor reads about workspaces is built from it. This test
 * fails when any of those texts loses it, or when someone writes a second copy instead of importing the constant.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import {
  TASK_PAIR_BRIEF_STRUCTURE_RULE,
  TASK_PAIR_WORKSPACE_RULES,
  buildTaskPairMarkerContract,
  type TaskPairState,
} from '../../shared/task-pair.js';
import {
  TASK_PAIR_WORKSPACE_AUTO_NOTE,
  TASK_PAIR_WORKSPACE_PARAMETER_DESCRIPTION,
  TASK_PAIR_WORKSPACE_PICK_GUIDANCE,
  TASK_PAIR_WORKSPACE_VALUES_GUIDE,
  TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY,
  TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY_TOKEN,
  taskPairWorkspaceCreateNote,
} from '../../shared/task-pair-workspace.js';
import { BRAIN_PAIRS_SUPERVISED_WORK } from '../../src/daemon/supervision-prompts.js';
import { buildExecutorHandoffMessage, buildExecutorPairBrief } from '../../src/daemon/task-pairs/messages.js';

const pair = (overrides: Partial<TaskPairState> = {}): TaskPairState => ({
  taskId: 'tsk_rule', brain: 'deck_p_brain', executor: 'deck_sub_x', auditor: 'deck_sub_a', status: 'working', flags: [], flagSides: {},
  round: 0, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1, createdAt: 1, updatedAt: 1, ...overrides,
});

describe('the "worktree only when necessary" owner rule', () => {
  it('says what the owner asked, in plain words', () => {
    expect(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY).toBe(
      'A worktree is created only when the task changes the project\'s tracked files and the result will be merged. '
      + 'Research, measurements, tests on other machines, reports, audits and any read-only work must use workspace=dir (a small task directory) '
      + 'or workspace=none; do not ask for a worktree "just in case".',
    );
    expect(TASK_PAIR_WORKSPACE_PICK_GUIDANCE).toBe('Pick workspace=dir or none unless this task edits tracked files that you will merge.');
    expect(TASK_PAIR_WORKSPACE_AUTO_NOTE).toContain('worktree for a code task');
    expect(TASK_PAIR_WORKSPACE_AUTO_NOTE).toContain('prefer an explicit dir or none for everything else');
    for (const value of ['workspace=worktree', 'workspace=dir', 'workspace=none']) expect(TASK_PAIR_WORKSPACE_VALUES_GUIDE).toContain(value);
  });

  it('opens the workspace paragraph of the contract that every Brain, executor and auditor session gets', () => {
    expect(TASK_PAIR_WORKSPACE_RULES.startsWith(`Workspace: ${TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY}`)).toBe(true);
    const contract = buildTaskPairMarkerContract();
    expect(contract).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    expect(contract).toContain(TASK_PAIR_WORKSPACE_AUTO_NOTE);
    expect(contract).toContain(TASK_PAIR_WORKSPACE_VALUES_GUIDE);
    expect(contract.indexOf(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY)).toBeLessThan(contract.indexOf('A code task in a git project'));
  });

  it('is in the pair_create tool description and its workspace parameter description', () => {
    const contract = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE];
    expect(contract.description).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    expect(contract.description).toContain(TASK_PAIR_WORKSPACE_PICK_GUIDANCE);
    const parameter = (contract.inputSchema as { properties: Record<string, { description?: string; enum?: string[] }> }).properties.workspace!;
    expect(parameter.description).toBe(TASK_PAIR_WORKSPACE_PARAMETER_DESCRIPTION);
    expect(parameter.description).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    expect(parameter.description).toContain(TASK_PAIR_WORKSPACE_VALUES_GUIDE);
    expect(parameter.description).toContain(TASK_PAIR_WORKSPACE_AUTO_NOTE);
    expect(parameter.enum).toEqual(['auto', 'worktree', 'dir', 'none']);
  });

  it('is in the Brain guidance for creating a pair (brief structure rule, the pair_create result, the Brain duty table)', () => {
    expect(TASK_PAIR_BRIEF_STRUCTURE_RULE).toContain(TASK_PAIR_WORKSPACE_PICK_GUIDANCE);
    expect(TASK_PAIR_BRIEF_STRUCTURE_RULE).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    expect(taskPairWorkspaceCreateNote('auto')).toContain(TASK_PAIR_WORKSPACE_PICK_GUIDANCE);
    expect(taskPairWorkspaceCreateNote('auto')).toContain(TASK_PAIR_WORKSPACE_AUTO_NOTE);
    expect(taskPairWorkspaceCreateNote('worktree')).toContain(TASK_PAIR_WORKSPACE_PICK_GUIDANCE);
    expect(taskPairWorkspaceCreateNote('dir')).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    expect(taskPairWorkspaceCreateNote('none')).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    expect(BRAIN_PAIRS_SUPERVISED_WORK.workspace).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY_TOKEN);
  });

  it('reaches the executor brief and the executor handoff, whatever the workspace kind', () => {
    for (const overrides of [{}, { workspaceKind: 'none' as const }, { workspaceKind: 'dir' as const }]) {
      expect(buildExecutorPairBrief(pair(overrides))).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
      expect(buildExecutorHandoffMessage(pair(overrides), 'deck_sub_old', 'limit')).toContain(TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY);
    }
  });

  it('has exactly one definition: no other source file spells the sentence out', () => {
    const roots = ['shared', 'src', 'web/src', 'server/src'];
    const repo = join(__dirname, '..', '..');
    const home = join(repo, 'shared', 'task-pair-workspace.ts');
    const fragments = ['created only when the task changes', 'Pick workspace=dir or none unless', 'do not ask for a worktree'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx|json)$/.test(name) || path === home) continue;
        if (name === 'memory-mcp-bootstrap-catalog.json') continue; // generated from the contracts above (checked by its own parity test)
        const text = readFileSync(path, 'utf8');
        if (fragments.some((fragment) => text.includes(fragment))) offenders.push(relative(repo, path).split(sep).join('/'));
      }
    };
    for (const root of roots) { try { walk(join(repo, root)); } catch { /* a project without that directory */ } }
    expect(offenders).toEqual([]);
  });
});
