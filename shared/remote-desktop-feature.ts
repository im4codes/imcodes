export const REMOTE_DESKTOP_FEATURE_ENV = 'IMCODES_REMOTE_DESKTOP_ENABLED' as const;

/**
 * Remote desktop is enabled by default once the daemon has a verified native
 * worker to advertise. An explicit "0" remains the operator kill switch.
 * Keep the nodeEnv parameter for call-site/API stability while older daemons
 * and servers roll through a mixed-version fleet.
 */
export function isRemoteDesktopFeatureEnabled(
  rawValue: unknown,
  _nodeEnv: unknown,
): boolean {
  if (rawValue === undefined) return true;
  if (rawValue === '1') return true;
  if (rawValue === '0') return false;
  // A present but malformed operator setting is configuration drift, not an
  // opt-in. Fail closed while keeping the absent/default configuration on.
  return false;
}
