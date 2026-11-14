import { TASK_PAIR_ID_CHAR_CLASS, TASK_PAIR_SESSION_ID_PREFIX } from './task-pair.js';
import { deriveSupervisionTaskTitleFromBrief, isUsableTaskPairTitle } from './supervision-task-identity.js';

/** Display only; never change a task's protocol identity or persisted title. */
export function taskPairDisplayTitle(title: unknown, taskId: string, brief?: unknown): string | undefined {
  if (isUsableTaskPairTitle(title, taskId)) return (title as string).trim();
  if (brief) {
    const derived = deriveSupervisionTaskTitleFromBrief(brief);
    if (derived && isUsableTaskPairTitle(derived, taskId)) return derived.trim();
  }
  return undefined;
}

export type TaskPairTitleLookup =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string | undefined>>;

function readLookupTitle(lookup: TaskPairTitleLookup | undefined, taskId: string): unknown {
  if (!lookup || !taskId) return undefined;
  if (typeof (lookup as ReadonlyMap<string, string>).get === 'function') {
    return (lookup as ReadonlyMap<string, string>).get(taskId);
  }
  return Object.prototype.hasOwnProperty.call(lookup, taskId)
    ? (lookup as Readonly<Record<string, string | undefined>>)[taskId]
    : undefined;
}

/** Collect usable display titles across task rows/events without storing raw-ID placeholders. */
export function collectTaskPairTitles(
  entries: Iterable<{ taskId?: unknown; title?: unknown; brief?: unknown; pair?: { brief?: unknown } }>,
  target = new Map<string, string>(),
): Map<string, string> {
  for (const entry of entries) {
    if (typeof entry.taskId !== 'string' || !entry.taskId) continue;
    const display = taskPairDisplayTitle(entry.title, entry.taskId, entry.brief ?? entry.pair?.brief);
    if (display) target.set(entry.taskId, display);
  }
  return target;
}

/** Collect usable display titles from a window `__imcodesTaskPairSnapshot` payload. */
export function collectTaskPairTitlesFromSnapshot(
  snapshot: {
    authoritative?: unknown;
    scopeReset?: unknown;
    authorityUnavailable?: unknown;
    taskTitles?: Readonly<Record<string, string | undefined>>;
    tasks?: readonly { taskId?: unknown; title?: unknown; brief?: unknown; pair?: { brief?: unknown } }[];
  } | null | undefined,
  target = new Map<string, string>(),
): Map<string, string> {
  if (!snapshot || snapshot.authoritative === false || snapshot.scopeReset || snapshot.authorityUnavailable) return target;
  if (snapshot.taskTitles && typeof snapshot.taskTitles === 'object') {
    for (const [taskId, rawTitle] of Object.entries(snapshot.taskTitles)) {
      const display = taskPairDisplayTitle(rawTitle, taskId);
      if (display) target.set(taskId, display);
    }
  }
  if (Array.isArray(snapshot.tasks)) {
    collectTaskPairTitles(snapshot.tasks, target);
  }
  return target;
}

/** Build a dependencyId -> displayTitle record for wire envelopes such as scheduling details. */
export function buildDependencyTitleRecord(
  dependsOn: readonly string[] | undefined,
  lookup: (taskId: string) => { title?: unknown; brief?: unknown } | undefined,
): Record<string, string> | undefined {
  if (!dependsOn?.length) return undefined;
  const titles: Record<string, string> = {};
  for (const id of dependsOn) {
    const target = lookup(id);
    if (!target) continue;
    const display = taskPairDisplayTitle(target.title, id, target.brief);
    if (display) titles[id] = display;
  }
  return Object.keys(titles).length > 0 ? titles : undefined;
}

/** Resolve one dependency task id to its display title, falling back gracefully to raw taskId. */
export function resolveTaskPairDependencyTitle(
  taskId: string,
  taskTitles?: TaskPairTitleLookup,
  fallbackTitles?: Readonly<Record<string, string | undefined>>,
): string {
  const fromPrimary = taskPairDisplayTitle(readLookupTitle(taskTitles, taskId), taskId);
  if (fromPrimary) return fromPrimary;
  const fromFallback = fallbackTitles && Object.prototype.hasOwnProperty.call(fallbackTitles, taskId)
    ? taskPairDisplayTitle(fallbackTitles[taskId], taskId)
    : undefined;
  return fromFallback ?? taskId;
}

/** Format a comma-separated list of dependency task titles with raw-ID fallback. */
export function formatTaskPairDependencyTasks(
  dependsOn: readonly string[],
  taskTitles?: TaskPairTitleLookup,
  fallbackTitles?: Readonly<Record<string, string | undefined>>,
): string {
  return dependsOn
    .map((id) => resolveTaskPairDependencyTitle(id, taskTitles, fallbackTitles))
    .join(', ');
}

export function taskPairSessionLabel(role: 'executor' | 'auditor'): string {
  return `Pair ${role}`;
}

const LEGACY_PAIR_LABEL_RE = new RegExp(
  String.raw`^Pair [${TASK_PAIR_ID_CHAR_CLASS}]+ (executor|auditor)(?:: ([^\r\n]{1,40}))?$`,
);

/** Legacy projection is deliberately narrow: the reserved generated namespace,
 * a complete old producer label (including its 40 UTF-16-unit title bound),
 * and a task identifier. Ordinary/custom Pair-style labels stay untouched.
 * The role belongs to the original name, not the current assignment: reuse or
 * reassignment must not rename the session. No default-user data is rewritten. */
export function taskPairDisplaySessionLabel(id: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const label = value.trim();
  const suffix = id.slice(`deck_sub_${TASK_PAIR_SESSION_ID_PREFIX}`.length);
  if (id.startsWith(`deck_sub_${TASK_PAIR_SESSION_ID_PREFIX}`) && /^[a-f0-9]{16}$/.test(suffix)) {
    const legacy = LEGACY_PAIR_LABEL_RE.exec(value);
    if (legacy && (!legacy[2] || legacy[2].trim() === legacy[2])) return taskPairSessionLabel(legacy[1] as 'executor' | 'auditor');
  }
  return label;
}

/** Live explicit clears are authoritative; absent fields on old peers are not.
 * Cached watch labels are only a fallback after the explicit task payload. */
export function taskPairResolveDisplaySessionLabel(
  id: string,
  payloadLabel: unknown,
  liveSession?: { label?: string | null },
  fallbackLabel?: unknown,
): string | undefined {
  if (liveSession && liveSession.label !== undefined && Object.prototype.hasOwnProperty.call(liveSession, 'label')) {
    return taskPairDisplaySessionLabel(id, liveSession.label);
  }
  return taskPairDisplaySessionLabel(id, payloadLabel) ?? taskPairDisplaySessionLabel(id, fallbackLabel);
}
