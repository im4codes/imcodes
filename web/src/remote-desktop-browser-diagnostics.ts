export const REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT = {
  TRACK: 'track',
  TRACK_MUTE: 'track_mute',
  TRACK_UNMUTE: 'track_unmute',
  TRACK_ENDED: 'track_ended',
  PEER_CONNECTION_STATE: 'peer_connection_state',
  PEER_ICE_STATE: 'peer_ice_state',
  PEER_SIGNALING_STATE: 'peer_signaling_state',
  INBOUND_STATS: 'inbound_stats',
  VIDEO_FRAME: 'video_frame',
  VIDEO_WAITING: 'video_waiting',
  VIDEO_STALLED: 'video_stalled',
  VIDEO_EMPTIED: 'video_emptied',
  VIDEO_PLAYING: 'video_playing',
  VIDEO_LOADED_DATA: 'video_loaded_data',
  VIDEO_FALLBACK_SHOWN: 'video_fallback_shown',
  VIDEO_FALLBACK_HIDDEN: 'video_fallback_hidden',
  VIDEO_FALLBACK_CLEARED: 'video_fallback_cleared',
} as const;

export type RemoteDesktopBrowserDiagnosticEvent =
  typeof REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT[keyof typeof REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT];

export interface RemoteDesktopBrowserDiagnostic {
  at: number;
  type: RemoteDesktopBrowserDiagnosticEvent;
  sequence?: number;
  connectionState?: RTCPeerConnectionState;
  iceConnectionState?: RTCIceConnectionState;
  signalingState?: RTCSignalingState;
  trackMuted?: boolean;
  trackReadyState?: MediaStreamTrackState;
  bytesReceived?: number;
  packetsReceived?: number;
  framesReceived?: number;
  framesDecoded?: number;
  keyFramesDecoded?: number;
  framesDropped?: number;
  freezeCount?: number;
  totalFreezesDurationMs?: number;
  jitterBufferDelayMs?: number;
  jitterBufferEmittedCount?: number;
  videoReadyState?: number;
  videoNetworkState?: number;
  videoCurrentTimeMs?: number;
  videoWidth?: number;
  videoHeight?: number;
  callbackNowMs?: number;
  mediaTimeMs?: number;
  presentedFrames?: number;
  documentVisible?: boolean;
}

export type RemoteDesktopBrowserDiagnosticInput = Omit<RemoteDesktopBrowserDiagnostic, 'at'>;

const MAX_REMOTE_DESKTOP_BROWSER_DIAGNOSTICS = 256;
const REMOTE_DESKTOP_BROWSER_DIAGNOSTICS_STORAGE_PREFIX =
  'imcodes.remote-desktop.browser-diagnostics.v1:';
const rings = new Map<string, RemoteDesktopBrowserDiagnostic[]>();

function storageKey(serverId: string): string {
  return `${REMOTE_DESKTOP_BROWSER_DIAGNOSTICS_STORAGE_PREFIX}${serverId}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function load(serverId: string): RemoteDesktopBrowserDiagnostic[] {
  const existing = rings.get(serverId);
  if (existing) return existing;
  let loaded: RemoteDesktopBrowserDiagnostic[] = [];
  try {
    const parsed = JSON.parse(browserStorage()?.getItem(storageKey(serverId)) ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      loaded = parsed.slice(-MAX_REMOTE_DESKTOP_BROWSER_DIAGNOSTICS)
        .filter((event): event is RemoteDesktopBrowserDiagnostic => (
          typeof event === 'object' && event !== null
          && typeof (event as { at?: unknown }).at === 'number'
          && typeof (event as { type?: unknown }).type === 'string'
        ));
    }
  } catch {
    loaded = [];
  }
  rings.set(serverId, loaded);
  return loaded;
}

function persist(serverId: string, events: readonly RemoteDesktopBrowserDiagnostic[]): void {
  try {
    browserStorage()?.setItem(storageKey(serverId), JSON.stringify(events));
  } catch {
    // Diagnostics must never affect media or input authority.
  }
}

/**
 * Store only the allowlisted counters and browser states in a bounded,
 * session-scoped ring. SDP, ICE candidates, capabilities, ids and pixels have
 * no fields here, so a caller cannot accidentally turn diagnostics into a
 * second signaling or screen-recording channel.
 */
export function recordRemoteDesktopBrowserDiagnostic(
  serverId: string,
  event: RemoteDesktopBrowserDiagnosticInput,
): void {
  const events = load(serverId);
  events.push({ at: Date.now(), ...event });
  if (events.length > MAX_REMOTE_DESKTOP_BROWSER_DIAGNOSTICS) {
    events.splice(0, events.length - MAX_REMOTE_DESKTOP_BROWSER_DIAGNOSTICS);
  }
  persist(serverId, events);
}

export function readRemoteDesktopBrowserDiagnostics(
  serverId: string,
): RemoteDesktopBrowserDiagnostic[] {
  return load(serverId).map((event) => ({ ...event }));
}

export function clearRemoteDesktopBrowserDiagnostics(serverId: string): void {
  rings.delete(serverId);
  try {
    browserStorage()?.removeItem(storageKey(serverId));
  } catch {
    // Cleanup is best effort and can never block session teardown.
  }
}
