import { type TaskPairStore } from '../../src/daemon/task-pairs/store.js';

/** Deliberately replace test setup, using the current row rather than a stale writer.
 * Tests of concurrent/full-state writers must call savePair with their captured revision instead.
 */
export function putTaskPairFixture(
  store: TaskPairStore,
  project: string,
  state: Parameters<TaskPairStore['savePair']>[1],
  options: Parameters<TaskPairStore['savePair']>[2] = {},
): ReturnType<TaskPairStore['savePair']> {
  return store.savePair(project, state, { ...options, expectedRevision: store.getPair(project, state.taskId)?.revision });
}
