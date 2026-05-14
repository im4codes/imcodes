import { P2P_REQUEST_ID_ASCII_PATTERN } from './p2p-workflow-constants.js';
import type { P2pWorkflowDiagnosticCode } from './p2p-workflow-diagnostics.js';
import { P2P_CONFIG_MSG, type P2pConfigMsgType } from './p2p-config-events.js';

export const P2P_WORKFLOW_MSG = {
  STATUS: 'p2p.status',
  STATUS_RESPONSE: 'p2p.status_response',
  LIST_DISCUSSIONS: 'p2p.list_discussions',
  LIST_DISCUSSIONS_RESPONSE: 'p2p.list_discussions_response',
  READ_DISCUSSION: 'p2p.read_discussion',
  READ_DISCUSSION_RESPONSE: 'p2p.read_discussion_response',
  RUN_START: 'p2p.run_start',
  RUN_STARTED: 'p2p.run_started',
  RUN_UPDATE: 'p2p.run_update',
  RUN_SAVE: 'p2p.run_save',
  RUN_COMPLETE: 'p2p.run_complete',
  RUN_ERROR: 'p2p.run_error',
  CANCEL: 'p2p.cancel',
  CANCEL_RESPONSE: 'p2p.cancel_response',
  CONFLICT: 'p2p.conflict',
  DAEMON_HELLO: 'daemon.hello',
} as const;

/**
 * Category of a P2P protocol message.
 * - `'workflow'`: messages that drive the smart-p2p-rounds workflow protocol
 *   (status, list/read discussions, run start/update/complete/error/cancel,
 *   conflicts, daemon hello capability handshake).
 * - `'config'`: persisted P2P participant config CRUD between web and daemon
 *   (`p2p.config.save` / `p2p.config.save_response`). Distinct protocol family
 *   from workflow but shares the bridge route policy (registry-driven default-
 *   deny, request-scoped singlecast). Workflow-only consumers may filter by
 *   `category === 'workflow'` if needed.
 */
export type P2pProtocolCategory = 'workflow' | 'config';

/**
 * Union of all P2P protocol message types registered in
 * `P2P_WORKFLOW_MESSAGE_REGISTRY`. The historical name retains "Workflow" for
 * back-compat with existing imports; the registry covers both workflow and
 * config categories so the bridge default-deny excludes registered config
 * messages and unknown `p2p.*` still drop.
 */
export type P2pWorkflowMessageType =
  | (typeof P2P_WORKFLOW_MSG)[keyof typeof P2P_WORKFLOW_MSG]
  | P2pConfigMsgType;

export interface P2pWorkflowMessageDescriptor {
  type: P2pWorkflowMessageType;
  category: P2pProtocolCategory;
  direction: 'browser_to_server' | 'server_to_browser' | 'daemon_to_server' | 'server_to_daemon' | 'bidirectional';
  allowedIngress: readonly P2pWorkflowIngressPeer[];
  serverHandling: P2pWorkflowServerHandling;
  browserDelivery: P2pWorkflowBrowserDelivery;
  responseTo?: P2pWorkflowMessageType;
  expectedResponseType?: P2pWorkflowMessageType;
  requestScoped: boolean;
  response: boolean;
  broadcastAllowed: boolean;
}

export type P2pWorkflowIngressPeer = 'browser' | 'daemon';
export type P2pWorkflowServerHandling =
  | 'forward_to_daemon'
  | 'singlecast_response'
  | 'broadcast_to_browsers'
  | 'persist_run_and_broadcast'
  | 'cache_daemon_capabilities';
export type P2pWorkflowBrowserDelivery = 'none' | 'singlecast' | 'broadcast';

export const P2P_WORKFLOW_MESSAGE_REGISTRY: Record<P2pWorkflowMessageType, P2pWorkflowMessageDescriptor> = {
  [P2P_WORKFLOW_MSG.STATUS]: {
    type: P2P_WORKFLOW_MSG.STATUS,
    category: 'workflow',
    direction: 'browser_to_server',
    allowedIngress: ['browser'],
    serverHandling: 'forward_to_daemon',
    browserDelivery: 'none',
    expectedResponseType: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
    requestScoped: true,
    response: false,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.STATUS_RESPONSE]: {
    type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
    category: 'workflow',
    direction: 'server_to_browser',
    allowedIngress: ['daemon'],
    serverHandling: 'singlecast_response',
    browserDelivery: 'singlecast',
    responseTo: P2P_WORKFLOW_MSG.STATUS,
    requestScoped: true,
    response: true,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.LIST_DISCUSSIONS]: {
    type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
    category: 'workflow',
    direction: 'browser_to_server',
    allowedIngress: ['browser'],
    serverHandling: 'forward_to_daemon',
    browserDelivery: 'none',
    expectedResponseType: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
    requestScoped: true,
    response: false,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE]: {
    type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
    category: 'workflow',
    direction: 'server_to_browser',
    allowedIngress: ['daemon'],
    serverHandling: 'singlecast_response',
    browserDelivery: 'singlecast',
    responseTo: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS,
    requestScoped: true,
    response: true,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.READ_DISCUSSION]: {
    type: P2P_WORKFLOW_MSG.READ_DISCUSSION,
    category: 'workflow',
    direction: 'browser_to_server',
    allowedIngress: ['browser'],
    serverHandling: 'forward_to_daemon',
    browserDelivery: 'none',
    expectedResponseType: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
    requestScoped: true,
    response: false,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE]: {
    type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
    category: 'workflow',
    direction: 'server_to_browser',
    allowedIngress: ['daemon'],
    serverHandling: 'singlecast_response',
    browserDelivery: 'singlecast',
    responseTo: P2P_WORKFLOW_MSG.READ_DISCUSSION,
    requestScoped: true,
    response: true,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.RUN_START]: {
    type: P2P_WORKFLOW_MSG.RUN_START,
    category: 'workflow',
    direction: 'browser_to_server',
    allowedIngress: ['browser'],
    serverHandling: 'forward_to_daemon',
    browserDelivery: 'none',
    requestScoped: false,
    response: false,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.RUN_STARTED]: {
    type: P2P_WORKFLOW_MSG.RUN_STARTED,
    category: 'workflow',
    direction: 'server_to_browser',
    allowedIngress: ['daemon'],
    serverHandling: 'broadcast_to_browsers',
    browserDelivery: 'broadcast',
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.RUN_UPDATE]: {
    type: P2P_WORKFLOW_MSG.RUN_UPDATE,
    category: 'workflow',
    direction: 'daemon_to_server',
    allowedIngress: ['daemon'],
    serverHandling: 'persist_run_and_broadcast',
    browserDelivery: 'broadcast',
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.RUN_SAVE]: {
    type: P2P_WORKFLOW_MSG.RUN_SAVE,
    category: 'workflow',
    direction: 'daemon_to_server',
    allowedIngress: ['daemon'],
    serverHandling: 'persist_run_and_broadcast',
    browserDelivery: 'broadcast',
    expectedResponseType: P2P_WORKFLOW_MSG.RUN_UPDATE,
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.RUN_COMPLETE]: {
    type: P2P_WORKFLOW_MSG.RUN_COMPLETE,
    category: 'workflow',
    direction: 'daemon_to_server',
    allowedIngress: ['daemon'],
    serverHandling: 'persist_run_and_broadcast',
    browserDelivery: 'broadcast',
    expectedResponseType: P2P_WORKFLOW_MSG.RUN_UPDATE,
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.RUN_ERROR]: {
    type: P2P_WORKFLOW_MSG.RUN_ERROR,
    category: 'workflow',
    direction: 'daemon_to_server',
    allowedIngress: ['daemon'],
    serverHandling: 'persist_run_and_broadcast',
    browserDelivery: 'broadcast',
    expectedResponseType: P2P_WORKFLOW_MSG.RUN_UPDATE,
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.CANCEL]: {
    type: P2P_WORKFLOW_MSG.CANCEL,
    category: 'workflow',
    direction: 'browser_to_server',
    allowedIngress: ['browser'],
    serverHandling: 'forward_to_daemon',
    browserDelivery: 'none',
    requestScoped: false,
    response: false,
    broadcastAllowed: false,
  },
  [P2P_WORKFLOW_MSG.CANCEL_RESPONSE]: {
    type: P2P_WORKFLOW_MSG.CANCEL_RESPONSE,
    category: 'workflow',
    direction: 'server_to_browser',
    allowedIngress: ['daemon'],
    serverHandling: 'broadcast_to_browsers',
    browserDelivery: 'broadcast',
    responseTo: P2P_WORKFLOW_MSG.CANCEL,
    requestScoped: false,
    response: true,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.CONFLICT]: {
    type: P2P_WORKFLOW_MSG.CONFLICT,
    category: 'workflow',
    direction: 'daemon_to_server',
    allowedIngress: ['daemon'],
    serverHandling: 'broadcast_to_browsers',
    browserDelivery: 'broadcast',
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  [P2P_WORKFLOW_MSG.DAEMON_HELLO]: {
    type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
    category: 'workflow',
    direction: 'daemon_to_server',
    allowedIngress: ['daemon'],
    serverHandling: 'cache_daemon_capabilities',
    // Broadcast (daemonId, capabilities, helloEpoch, sentAt) to browsers
    // connected to this daemon's serverId so the web capability gate can
    // disable advanced launch on missing/stale/downgraded capabilities.
    // The fields advertised here are not secrets — capabilities are public
    // policy advertisement and helloEpoch/sentAt are required for the
    // freshness TTL check (`P2P_CAPABILITY_FRESHNESS_TTL_MS`).
    browserDelivery: 'broadcast',
    requestScoped: false,
    response: false,
    broadcastAllowed: true,
  },
  // ── Config category ────────────────────────────────────────────────────────
  // P2P participant config CRUD between web and daemon. Distinct protocol
  // family from workflow but shares the bridge route policy: registered =>
  // pass via generic forward_to_daemon / singlecast_response handlers,
  // unregistered `p2p.*` => default-deny drop.
  [P2P_CONFIG_MSG.SAVE]: {
    type: P2P_CONFIG_MSG.SAVE,
    category: 'config',
    direction: 'browser_to_server',
    allowedIngress: ['browser'],
    serverHandling: 'forward_to_daemon',
    browserDelivery: 'none',
    expectedResponseType: P2P_CONFIG_MSG.SAVE_RESPONSE,
    requestScoped: true,
    response: false,
    broadcastAllowed: false,
  },
  [P2P_CONFIG_MSG.SAVE_RESPONSE]: {
    type: P2P_CONFIG_MSG.SAVE_RESPONSE,
    category: 'config',
    direction: 'server_to_browser',
    allowedIngress: ['daemon'],
    serverHandling: 'singlecast_response',
    browserDelivery: 'singlecast',
    responseTo: P2P_CONFIG_MSG.SAVE,
    requestScoped: true,
    response: true,
    broadcastAllowed: false,
  },
};

export type P2pWorkflowMessageParseResult =
  | { kind: 'known'; descriptor: P2pWorkflowMessageDescriptor }
  | { kind: 'drop'; diagnosticCode: P2pWorkflowDiagnosticCode; reason: 'unknown_p2p_message' | 'not_p2p_message' };

export function parseP2pWorkflowMessageType(type: unknown): P2pWorkflowMessageParseResult {
  if (typeof type !== 'string') return { kind: 'drop', diagnosticCode: 'unknown_p2p_message', reason: 'not_p2p_message' };
  const descriptor = P2P_WORKFLOW_MESSAGE_REGISTRY[type as P2pWorkflowMessageType];
  if (descriptor) return { kind: 'known', descriptor };
  if (type.startsWith('p2p.')) {
    return { kind: 'drop', diagnosticCode: 'unknown_p2p_message', reason: 'unknown_p2p_message' };
  }
  return { kind: 'drop', diagnosticCode: 'unknown_p2p_message', reason: 'not_p2p_message' };
}

export function isP2pWorkflowRequestId(value: unknown): value is string {
  return typeof value === 'string' && P2P_REQUEST_ID_ASCII_PATTERN.test(value) && value.length <= 128;
}

export function requiresP2pWorkflowRequestId(type: P2pWorkflowMessageType): boolean {
  return P2P_WORKFLOW_MESSAGE_REGISTRY[type].requestScoped;
}
