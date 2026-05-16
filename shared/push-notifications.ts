export const TIMELINE_SUPPRESS_PUSH_FIELD = 'suppressPush';
export const PUSH_TIMELINE_EVENT_MAX_AGE_MS = 2 * 60 * 1000;

// ── Device platform values stored in push_tokens.platform ──────────────────
// Each value identifies BOTH the device OS and the push transport channel,
// because Android in China can't reliably reach FCM and must go through a
// third-party aggregator (极光推送 JPush) that fans out to vendor channels
// (Xiaomi / Huawei / OPPO / vivo / Honor / Meizu).
//
// - 'ios'           — Apple devices, dispatched via APNs HTTP/2
// - 'android'       — Android devices reachable via Firebase FCM (海外 Play Store builds)
// - 'android-jpush' — Android devices registered through JPush SDK (国内 builds);
//                     token is the JPush registration_id, dispatch via JPush v3 REST API

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
