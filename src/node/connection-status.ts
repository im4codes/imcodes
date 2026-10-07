import {
  CONTROLLED_NODE_ACK_SERVER_URLS_FIELD,
  CONTROLLED_NODE_FAILURE_CLASS,
  type ControlledNodeFailureClass,
} from '../../shared/controlled-node-endpoints.js';
import { CONTROLLED_NODE_ACK_SERVER_ID_FIELD } from '../../shared/controlled-node-identity.js';
import type { AuthenticatedWebSocketDiagnostic, AuthenticatedWebSocketLossReason } from '../transport/authenticated-websocket.js';
import type { ControlledNodeEndpointSelector } from './server-endpoints.js';

/**
 * Where a controlled node stands with its server, as the node itself can tell: which origin it dials, and why the last attempts
 * failed. It carries no secret (an origin is a host name and a port) and drives three things: the choice of the next origin
 * (server-endpoints.ts), the log line after a long outage, and the line in the node's local panel.
 */
export { CONTROLLED_NODE_FAILURE_CLASS, type ControlledNodeFailureClass };

export interface ControlledNodeConnectionStatus {
  state: 'connected' | 'connecting' | 'unreachable';
  /** host[:port] of the origin being dialled. */
  target: string;
  failureClass?: ControlledNodeFailureClass;
  /** Wall time of the first failure of the current outage. */
  since?: number;
  consecutiveFailures: number;
}

/** Losses that mean the server could not be reached (as opposed to a server that answered and said no). */
const NETWORK_LOSSES: ReadonlySet<AuthenticatedWebSocketLossReason> = new Set([
  'connect_timeout', 'socket_error', 'socket_create_error',
]);
/** Losses of an open socket that count as unreachable only when no ack ever arrived on it. */
const UNANSWERED_LOSSES: ReadonlySet<AuthenticatedWebSocketLossReason> = new Set(['socket_close', 'inbound_silence']);
const REJECTED_LOSSES: ReadonlySet<AuthenticatedWebSocketLossReason> = new Set(['authentication_failed', 'credential_revoked']);

export function classifyConnectionFailure(reason: AuthenticatedWebSocketLossReason, errorCode?: string): ControlledNodeFailureClass {
  const { TCP_TIMEOUT, REFUSED, DNS, TLS, RESET, REJECTED, OTHER } = CONTROLLED_NODE_FAILURE_CLASS;
  if (REJECTED_LOSSES.has(reason)) return REJECTED;
  if (reason === 'connect_timeout') return TCP_TIMEOUT;
  if (errorCode) {
    if (errorCode === 'ETIMEDOUT' || errorCode === 'ESOCKETTIMEDOUT') return TCP_TIMEOUT;
    if (errorCode === 'ECONNREFUSED') return REFUSED;
    if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN' || errorCode === 'EAI_FAIL') return DNS;
    if (errorCode === 'ECONNRESET' || errorCode === 'EPIPE') return RESET;
    if (/^(CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(errorCode)) return TLS;
  }
  return OTHER;
}

function targetOf(origin: string): string {
  try {
    const url = new URL(origin);
    return url.host;
  } catch {
    return 'unknown';
  }
}

export interface ControlledNodeConnectionTrackerDeps {
  /** The origin the node was enrolled with. */
  primary: string;
  /** The server ID of this node's credential: an ack that names another server ID is not this server. */
  serverId?: string;
  selector?: ControlledNodeEndpointSelector | null;
  now?: () => number;
  log?: { info(context: object, message: string): void; warn(context: object, message: string): void };
}

/** Joins the connection client's diagnostics to the endpoint selector and to a status the node can show. */
export class ControlledNodeConnectionTracker {
  private readonly now: () => number;
  private authenticatedOnThisSocket = false;
  private failures = 0;
  private since: number | undefined;
  private failureClass: ControlledNodeFailureClass | undefined;
  private connected = false;

  constructor(private readonly deps: ControlledNodeConnectionTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The origin for the next connection attempt. */
  currentOrigin(): string {
    return this.deps.selector?.current() ?? this.deps.primary;
  }

  onDiagnostic(event: AuthenticatedWebSocketDiagnostic): void {
    if (event.type === 'socket_opened') {
      this.authenticatedOnThisSocket = false;
      return;
    }
    if (event.type === 'reconnect_scheduled') {
      void this.deps.selector?.refreshPinned();
      return;
    }
    const authenticated = this.authenticatedOnThisSocket;
    this.authenticatedOnThisSocket = false;
    this.connected = false;
    const rejected = REJECTED_LOSSES.has(event.reason);
    const network = NETWORK_LOSSES.has(event.reason) || (UNANSWERED_LOSSES.has(event.reason) && !authenticated);
    if (!rejected && !network) return; // a deliberate reconnect, a resume, a drop of an authenticated connection
    this.failures += 1;
    this.since ??= this.now();
    this.failureClass = classifyConnectionFailure(event.reason, event.errorCode);
    if (rejected) {
      this.deps.selector?.recordRejected(event.reason);
      return;
    }
    this.deps.selector?.recordFailure(event.reason);
  }

  /** The server acknowledged this node (an authenticated heartbeat ack). */
  onAuthenticatedAck(message: Record<string, unknown>): void {
    // The ack names the server ID it is for (controlled nodes with a public ID). Another ID means this address belongs to a
    // different deployment: it is not used again for a day (never the enrolled address), and the ack counts for nothing.
    const ackedServerId = message[CONTROLLED_NODE_ACK_SERVER_ID_FIELD];
    if (this.deps.serverId && typeof ackedServerId === 'string' && ackedServerId !== this.deps.serverId) {
      this.authenticatedOnThisSocket = false;
      this.connected = false;
      this.failures += 1;
      this.since ??= this.now();
      this.failureClass = CONTROLLED_NODE_FAILURE_CLASS.REJECTED;
      this.deps.selector?.recordRejected('server_id_mismatch');
      return;
    }
    this.authenticatedOnThisSocket = true;
    this.connected = true;
    if (this.failures > 0) {
      this.deps.log?.info({ target: targetOf(this.currentOrigin()), failures: this.failures }, 'controlled node reached its server again');
    }
    this.failures = 0;
    this.since = undefined;
    this.failureClass = undefined;
    this.deps.selector?.recordSuccess();
    const advertised = message[CONTROLLED_NODE_ACK_SERVER_URLS_FIELD];
    if (Array.isArray(advertised)) this.deps.selector?.setAdvertised(advertised as string[]);
  }

  status(): ControlledNodeConnectionStatus {
    const target = targetOf(this.currentOrigin());
    if (this.connected) return { state: 'connected', target, consecutiveFailures: 0 };
    if (this.failures === 0) return { state: 'connecting', target, consecutiveFailures: 0 };
    return {
      state: 'unreachable',
      target,
      ...(this.failureClass ? { failureClass: this.failureClass } : {}),
      ...(this.since !== undefined ? { since: this.since } : {}),
      consecutiveFailures: this.failures,
    };
  }
}
