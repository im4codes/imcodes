import {
  TASK_PAIR_BRAIN_NOTICE_EVENT,
  TASK_PAIR_CHECKLIST_AUTO_TICK_VERB,
  TASK_PAIR_MATERIAL_EVENT_VERB,
  TASK_PAIR_MATERIAL_HELD_EFFECT,
  TASK_PAIR_MCP_DELIVERY_EVENT,
  TASK_PAIR_MCP_DISPATCH_EVENT,
  TASK_PAIR_NOTICE_VERB,
  TASK_PAIR_RECORDED_EVENT_VERBS,
  TASK_PAIR_TITLE_EVENT_VERB,
  TASK_PAIR_VERBS,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  type TaskPairEventPayload,
} from '@shared/task-pair.js';

type Translate = (key: string, options?: Record<string, unknown>) => string;
const knownVerbs = new Set<string>([
  ...TASK_PAIR_VERBS, ...TASK_PAIR_RECORDED_EVENT_VERBS, TASK_PAIR_NOTICE_VERB,
  TASK_PAIR_CHECKLIST_AUTO_TICK_VERB, TASK_PAIR_TITLE_EVENT_VERB,
]);
const workspaceEffects = new Set<string>(Object.values(TASK_PAIR_WORKSPACE_EFFECTS));

export function normalizeTaskPairEventVerb(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase() : undefined;
}

/** Display-only action. Unknown input has no label, never a guessed status.
 * DECISION_REQUEST also carries feedback: without trusted kind metadata its
 * label must remain neutral. Safe raw payload remains the diagnostic source. */
export function taskPairEventAction(t: Translate, event: Partial<TaskPairEventPayload>): { label: string; detail?: string } | undefined {
  const verb = normalizeTaskPairEventVerb(event.verb);
  if (verb === TASK_PAIR_WORKSPACE_EVENT_VERB) {
    const effect = typeof event.effect === 'string' ? event.effect.trim().toLowerCase() : '';
    if (!workspaceEffects.has(effect)) return undefined;
    if (effect === TASK_PAIR_WORKSPACE_EFFECTS.KEPT) return { label: t('taskPair.workspace_kept') };
    if (effect === TASK_PAIR_WORKSPACE_EFFECTS.REMOVED) return { label: t('taskPair.workspace_removed') };
    const label = t(`taskPair.action.${effect}`);
    if (effect === TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED) return { label, detail: t('taskPair.output_saved', { path: event.outputPath ?? '' }) };
    if (effect === TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED) return { label, detail: t('taskPair.output_failed', { reason: event.outputError ?? '' }) };
    return { label };
  }
  if (verb === TASK_PAIR_MATERIAL_EVENT_VERB) return { label: t(event.effect === TASK_PAIR_MATERIAL_HELD_EFFECT ? 'taskPair.action.material_held' : 'taskPair.verb.material') };
  if (verb === TASK_PAIR_MCP_DISPATCH_EVENT) return { label: t('taskPair.action.dispatch_updated') };
  if (verb === TASK_PAIR_MCP_DELIVERY_EVENT) return { label: t('taskPair.action.delivery_updated') };
  if (verb === TASK_PAIR_BRAIN_NOTICE_EVENT) return { label: t('taskPair.action.brain_notice_updated') };
  return verb && knownVerbs.has(verb) ? { label: t(`taskPair.verb.${verb.toLowerCase()}`) } : undefined;
}
