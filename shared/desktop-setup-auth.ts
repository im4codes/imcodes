/**
 * Shared constants and validators for Desktop Phase 2B unbound first-run setup
 * and browser login loopback callback handoff.
 */

export const DESKTOP_SETUP_DEFAULT_RELAY_URL = 'https://app.im.codes' as const;
export const DESKTOP_SETUP_CALLBACK_PATH = '/setup/callback' as const;
export const DESKTOP_SETUP_CALLBACK_QUERY_PARAM = 'desktop_callback' as const;
export const DESKTOP_SETUP_TOKEN_EXCHANGE_PATH = '/api/auth/token-exchange' as const;
export const DESKTOP_SETUP_AUTH_NONCE_PATH = '/api/auth/desktop/nonce' as const;

export const DESKTOP_SETUP_CSRF_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const DESKTOP_SETUP_STEP = Object.freeze({
  IDLE: 'idle',
  AWAITING_BROWSER: 'awaiting_browser',
  EXCHANGING_NONCE: 'exchanging_nonce',
  BINDING_DAEMON: 'binding_daemon',
  ENROLLING_NODE: 'enrolling_node',
  STARTING_RUNTIME: 'starting_runtime',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const);

export const DESKTOP_SETUP_STEPS = [
  DESKTOP_SETUP_STEP.IDLE,
  DESKTOP_SETUP_STEP.AWAITING_BROWSER,
  DESKTOP_SETUP_STEP.EXCHANGING_NONCE,
  DESKTOP_SETUP_STEP.BINDING_DAEMON,
  DESKTOP_SETUP_STEP.ENROLLING_NODE,
  DESKTOP_SETUP_STEP.STARTING_RUNTIME,
  DESKTOP_SETUP_STEP.COMPLETED,
  DESKTOP_SETUP_STEP.FAILED,
] as const;

export type DesktopSetupStep = (typeof DESKTOP_SETUP_STEPS)[number];

export const DESKTOP_SETUP_LOCAL_ACTION = Object.freeze({
  START_BROWSER_AUTH: 'setupStartBrowserAuth',
  CANCEL_BROWSER_AUTH: 'setupCancelBrowserAuth',
  BIND_MANUAL: 'setupBindManual',
} as const);

export type DesktopSetupLocalAction =
  typeof DESKTOP_SETUP_LOCAL_ACTION[keyof typeof DESKTOP_SETUP_LOCAL_ACTION];

export interface RemoteDesktopLocalSetupStatus {
  setupRequired: boolean;
  step: DesktopSetupStep;
  prefilledRelayUrl: string;
  relayUrl?: string | null;
  existingDaemonBound?: boolean;
  existingDaemonRelayUrl?: string | null;
  browserAuthPending?: boolean;
  error?: string | null;
}

export interface ParsedDesktopSetupCallback {
  origin: string;
  port: number;
  state: string;
  href: string;
}

export function isValidDesktopSetupState(value: unknown): value is string {
  return typeof value === 'string' && DESKTOP_SETUP_CSRF_STATE_PATTERN.test(value);
}

/**
 * Strict loopback desktop OAuth/login callback validator.
 * Accepts ONLY `http://127.0.0.1:<port>/setup/callback?state=<csrf-state>`.
 * Rejects non-127.0.0.1 hosts (including `localhost`, `[::1]`, 0.0.0.0, external domains),
 * non-http protocols, credentials, missing/invalid port, unexpected paths,
 * fragments, missing/invalid `state`, or extra query parameters.
 */
export function parseDesktopSetupCallbackUrl(raw: unknown): ParsedDesktopSetupCallback | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.hostname !== '127.0.0.1') return null;
  if (url.username || url.password || url.hash) return null;
  if (!/^[0-9]{1,5}$/.test(url.port)) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (url.pathname !== DESKTOP_SETUP_CALLBACK_PATH) return null;
  const keys = Array.from(url.searchParams.keys());
  if (keys.length !== 1 || keys[0] !== 'state') return null;
  const state = url.searchParams.get('state');
  if (!isValidDesktopSetupState(state)) return null;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    state,
    href: `${origin}${DESKTOP_SETUP_CALLBACK_PATH}?state=${encodeURIComponent(state)}`,
  };
}

/** Build the final browser redirect URL from validated loopback components + single-use nonce. */
export function buildDesktopSetupCallbackRedirectUrl(
  validated: ParsedDesktopSetupCallback,
  nonce: string,
): string {
  return `${validated.origin}${DESKTOP_SETUP_CALLBACK_PATH}?nonce=${encodeURIComponent(nonce)}&state=${encodeURIComponent(validated.state)}`;
}

/** Build the relay login URL opened in the user's system browser during desktop setup. */
export function buildDesktopSetupLoginUrl(relayOrigin: string, callbackUrl: string): string {
  return `${relayOrigin.replace(/\/+$/, '')}/?${DESKTOP_SETUP_CALLBACK_QUERY_PARAM}=${encodeURIComponent(callbackUrl)}`;
}

const DESKTOP_SETUP_STEP_SET = new Set<string>(DESKTOP_SETUP_STEPS);

export function sanitizeRemoteDesktopLocalSetupStatus(
  value: unknown,
  sanitizeUrl: (raw: unknown) => string | undefined = defaultRelayDisplayOrigin,
): RemoteDesktopLocalSetupStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.setupRequired !== 'boolean') return undefined;
  const step: DesktopSetupStep =
    typeof raw.step === 'string' && DESKTOP_SETUP_STEP_SET.has(raw.step)
      ? (raw.step as DesktopSetupStep)
      : 'idle';
  const prefilledRelayUrl = sanitizeUrl(raw.prefilledRelayUrl) ?? DESKTOP_SETUP_DEFAULT_RELAY_URL;
  const relayUrl = raw.relayUrl === null ? null : (sanitizeUrl(raw.relayUrl) ?? null);
  const existingDaemonRelayUrl =
    raw.existingDaemonRelayUrl === null ? null : (sanitizeUrl(raw.existingDaemonRelayUrl) ?? null);
  const error =
    typeof raw.error === 'string' && raw.error.length > 0
      ? raw.error.slice(0, 240)
      : null;
  return {
    setupRequired: raw.setupRequired,
    step,
    prefilledRelayUrl,
    ...(relayUrl ? { relayUrl } : {}),
    ...(typeof raw.existingDaemonBound === 'boolean' ? { existingDaemonBound: raw.existingDaemonBound } : {}),
    ...(existingDaemonRelayUrl ? { existingDaemonRelayUrl } : {}),
    ...(typeof raw.browserAuthPending === 'boolean' ? { browserAuthPending: raw.browserAuthPending } : {}),
    ...(error ? { error } : {}),
  };
}

function defaultRelayDisplayOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    if (u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}
