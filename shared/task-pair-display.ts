import { TASK_PAIR_ID_CHAR_CLASS, TASK_PAIR_SESSION_ID_PREFIX } from './task-pair.js';
import { isUsableTaskPairTitle } from './supervision-task-identity.js';

/** Display only; never change a task's protocol identity or persisted title. */
export function taskPairDisplayTitle(title: unknown, taskId: string): string | undefined {
  return isUsableTaskPairTitle(title, taskId) ? title.trim() : undefined;
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
