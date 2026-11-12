export const TIMELINE_SUPPRESS_PUSH_FIELD = 'suppressPush';
export const PUSH_TIMELINE_EVENT_MAX_AGE_MS = 2 * 60 * 1000;

// ── Device platform values stored in push_tokens.platform ──────────────────
// Each value identifies BOTH the device OS and the push transport channel,
// because Android in Mainland China can't reliably reach FCM and must go
// through a third-party aggregator (JPush 极光推送) that fans out to the
// on-device vendor channels (Xiaomi / Huawei / OPPO / vivo / Honor / Meizu).
//
// - 'ios'           — Apple devices, dispatched via APNs HTTP/2
// - 'android'       — Android devices reachable via Firebase FCM
//                     (International edition APK)
// - 'android-jpush' — Android devices registered through the JPush SDK
//                     (Mainland China edition APK); token is the JPush
//                     registration_id, dispatch via JPush v3 REST API

export const PUSH_PLATFORM_IOS = 'ios';
export const PUSH_PLATFORM_ANDROID_FCM = 'android';
export const PUSH_PLATFORM_ANDROID_JPUSH = 'android-jpush';

export type PushPlatform =
  | typeof PUSH_PLATFORM_IOS
  | typeof PUSH_PLATFORM_ANDROID_FCM
  | typeof PUSH_PLATFORM_ANDROID_JPUSH;

export const PUSH_PLATFORMS: readonly PushPlatform[] = [
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_FCM,
  PUSH_PLATFORM_ANDROID_JPUSH,
] as const;

export function isPushPlatform(value: unknown): value is PushPlatform {
  return typeof value === 'string' && (PUSH_PLATFORMS as readonly string[]).includes(value);
}

// ── Push notification types and user preferences ─────────────────────────────
export const PUSH_NOTIFICATION_TYPE_TASK_COMPLETE = 'task_complete';
export const PUSH_NOTIFICATION_TYPE_WAITING_INPUT = 'waiting_input';
export const PUSH_NOTIFICATION_TYPE_SESSION_ERROR = 'session_error';
export const PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE = 'task_pair_done';
export const PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED = 'task_pair_paused';
export const PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT = 'task_pair_audit';
export const PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP = 'remote_desktop';

export type PushNotificationType =
  | typeof PUSH_NOTIFICATION_TYPE_TASK_COMPLETE
  | typeof PUSH_NOTIFICATION_TYPE_WAITING_INPUT
  | typeof PUSH_NOTIFICATION_TYPE_SESSION_ERROR
  | typeof PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE
  | typeof PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED
  | typeof PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT
  | typeof PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP;

export const PUSH_NOTIFICATION_TYPES: readonly PushNotificationType[] = [
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_WAITING_INPUT,
  PUSH_NOTIFICATION_TYPE_SESSION_ERROR,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
] as const;

export function isPushNotificationType(value: unknown): value is PushNotificationType {
  return typeof value === 'string' && (PUSH_NOTIFICATION_TYPES as readonly string[]).includes(value as PushNotificationType);
}

/**
 * Default enabled notification types:
 * - Basic: task_complete, waiting_input, session_error
 * - Task Lifecycle: task_pair_done (DONE), task_pair_paused (PAUSED)
 * - Security: remote_desktop (Highest Security Alert)
 *
 * NOTE: task_pair_audit (intermediate audit/rework steps) is DISABLED by default.
 */
export const DEFAULT_PUSH_NOTIFICATION_TYPES: readonly PushNotificationType[] = [
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_WAITING_INPUT,
  PUSH_NOTIFICATION_TYPE_SESSION_ERROR,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
] as const;

export const REMOTE_DESKTOP_ALERT_PREFIX = '🚨 [最高安全警示] ';

export interface TaskPairNotificationContext {
  verb?: string | null;
  toStatus?: string | null;
  fromStatus?: string | null;
  effect?: string | null;
  unusual?: boolean;
  scheduling?: {
    manual?: boolean;
    epoch?: number;
    dependsOn?: string[];
  } | null;
}

/** Classify a task pair marker/state event into a fine-grained push notification type. */
export function classifyTaskPairNotificationType(
  ctxOrVerb?: TaskPairNotificationContext | string | null,
  legacyToStatus?: string | null,
): PushNotificationType | null {
  let verb: string | null = null;
  let toStatus: string | null = null;
  let fromStatus: string | null = null;
  let effect: string | null = null;
  let unusual = false;
  let scheduling: { manual?: boolean; epoch?: number; dependsOn?: string[] } | null = null;

  if (typeof ctxOrVerb === 'string' || ctxOrVerb === null || ctxOrVerb === undefined) {
    verb = ctxOrVerb ?? null;
    toStatus = legacyToStatus ?? null;
  } else {
    verb = ctxOrVerb.verb ?? null;
    toStatus = ctxOrVerb.toStatus ?? null;
    fromStatus = ctxOrVerb.fromStatus ?? null;
    effect = ctxOrVerb.effect ?? null;
    unusual = Boolean(ctxOrVerb.unusual);
    scheduling = ctxOrVerb.scheduling ?? null;
  }

  // Never push for unusual, rejected, or invalid markers (e.g. premature DONE)
  if (unusual) return null;

  // Never push for no-op or duplicate effects
  if (effect === 'duplicate_ready' || effect === 'in_audit_guarded' || effect === 'none' || effect === 'recorded') {
    return null;
  }

  const v = (verb ?? '').toUpperCase();
  const s = (toStatus ?? '').toLowerCase();
  const fs = (fromStatus ?? '').toLowerCase();

  // Task done: must transition to 'done' and not be a repeat/metadata event while already done
  if (s === 'done' || (v === 'DONE' && effect !== 'rejected' && effect !== 'none')) {
    if (fs === 'done') {
      return null;
    }
    return PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE;
  }

  // Task paused / awaiting decision:
  if (v === 'PAUSE' || scheduling?.manual === true) {
    return PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED;
  }
  if (s === 'awaiting_brain_decision' && fs !== 'awaiting_brain_decision') {
    return PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED;
  }
  if (v === 'NEEDS_DECISION') {
    return PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED;
  }

  // Task audit & intermediate steps:
  if (
    v === 'READY_FOR_AUDIT' ||
    s === 'in_audit' ||
    v === 'PASS' ||
    s === 'passed' ||
    v === 'REWORK' ||
    s === 'rework'
  ) {
    if (s && fs && s === fs) return null;
    return PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT;
  }

  return null;
}
