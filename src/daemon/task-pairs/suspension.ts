import { isTerminalTaskPairStatus } from '../../../shared/task-pair.js';
import { TASK_PAIR_DEPENDENCY_GRAPH_LIMIT, TASK_PAIR_MAX_DEPENDENCIES, type TaskPairScheduling } from '../../../shared/task-pair-suspension.js';
import { getTaskPairStore } from './store.js';

/** IDs resolve only inside the caller's existing project; no session-name or cross-owner inference. */
export function validatePairDependencies(project: string, taskId: string, input: unknown): string[] {
  if (!Array.isArray(input) || input.length > TASK_PAIR_MAX_DEPENDENCIES || input.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('dependsOn must be an array of at most 32 task ids');
  const ids = [...new Set(input.map((id: string) => id.trim()))];
  const store = getTaskPairStore();
  const visited = new Set<string>(), visiting = new Set<string>();
  const stack = ids.map((id) => ({ id, exit: false }));
  while (stack.length) {
    const { id, exit } = stack.pop()!;
    if (exit) { visiting.delete(id); visited.add(id); continue; }
    if (id === taskId || visiting.has(id)) throw new Error('self/cyclic task dependency');
    if (visited.has(id)) continue;
    if (visited.size + visiting.size >= TASK_PAIR_DEPENDENCY_GRAPH_LIMIT) throw new Error('dependency graph is too large');
    const pair = store.getPair(project, id);
    if (!pair) throw new Error('dependency is unavailable in this project');
    visiting.add(id); stack.push({ id, exit: true });
    for (const next of pair.state.scheduling?.dependsOn ?? []) stack.push({ id: next, exit: false });
  }
  return ids;
}
export function initialPairWait(writer: string, dependsOn: string[], now = Date.now()): TaskPairScheduling {
  return { epoch: 1, manual: false, dependsOn, since: now, writer };
}
export function pausePair(project: string, taskId: string, writer: string, mode: 'manual' | 'dependencies', dependsOn: unknown = undefined, note?: string) {
  const store = getTaskPairStore();
  const pair = store.getPair(project, taskId);
  if (!pair || pair.state.brain !== writer || isTerminalTaskPairStatus(pair.state.status)) throw new Error('only the current Brain may pause an open pair');
  const deps = mode === 'dependencies' ? validatePairDependencies(project, taskId, dependsOn) : pair.state.scheduling?.dependsOn ?? [];
  const prev = pair.state.scheduling;
  const manual = mode === 'manual' || prev?.manual === true;
  if (prev && prev.manual === manual && JSON.stringify(prev.dependsOn) === JSON.stringify(deps) && prev.note === note && !prev.resumePending) return pair;
  const next: TaskPairScheduling = { epoch: (prev?.epoch ?? 0) + 1, manual, dependsOn: deps, resumePending: !manual && deps.length === 0, since: Date.now(), writer, ...(note ? { note } : {}) };
  const saved = store.patchScheduling(project, taskId, prev, next, Date.now());
  if (!saved) throw new Error('pair changed; retry pause');
  return saved;
}
export function resumePair(project: string, taskId: string, writer: string) {
  const store = getTaskPairStore();
  const pair = store.getPair(project, taskId);
  if (!pair || pair.state.brain !== writer || isTerminalTaskPairStatus(pair.state.status)) throw new Error('only the current Brain may resume an open pair');
  const prev = pair.state.scheduling;
  if (!prev || !prev.manual) return pair;
  const next = { ...prev, epoch: prev.epoch + 1, manual: false, resumePending: prev.dependsOn.length === 0, admitted: false, since: Date.now() };
  const saved = store.patchScheduling(project, taskId, prev, next, Date.now());
  if (!saved) throw new Error('pair changed; retry resume');
  return saved;
}
