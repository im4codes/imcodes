export const DAEMON_COMMAND_TYPES = {
  DAEMON_UPGRADE: 'daemon.upgrade',
  SERVER_DELETE: 'server.delete',
  SESSION_CANCEL: 'session.cancel',
  SESSION_EXECUTION_CLONES: 'session.execution_clones',
  SESSION_UPDATE_TRANSPORT_CONFIG: 'session.update_transport_config',
  /** Browser/server → daemon: fetch online identity profiles and refresh live runtimes. */
  SESSION_IDENTITY_REFRESH: 'session.identity.refresh',
  SUBSESSION_UPDATE_TRANSPORT_CONFIG: 'subsession.update_transport_config',
  /** Server → controlled node: run a one-shot command locally (RemoteExecRequest). */
  MACHINE_EXEC: 'machine.exec',
  /** Server → controlled node: invoke one typed Computer Use tool locally. */
  COMPUTER_USE: 'computer.use',
  /**
   * Server → controlled node: store or clear the node's sign-in secret. The
   * secret only ever travels in this direction and is never read back.
   */
  CONTROLLED_NODE_AUTO_UNLOCK: 'controlled_node.auto_unlock',
  // ── Lightweight peer-supervision-audit control plane ──────────────────────
  /** Web → daemon: request the authoritative peer-audit candidate list. */
  PEER_AUDIT_LIST_CANDIDATES: 'peer_audit.list_candidates',
  /** Web → daemon: start a one-shot Quick peer audit against a chosen target. */
  PEER_AUDIT_QUICK_START: 'peer_audit.quick_start',
  /** Web → daemon: cancel the audited session's active peer-audit attempt. */
  PEER_AUDIT_CANCEL: 'peer_audit.cancel',
  /** Auditor → daemon (daemon-only, no terminal-key fallback): submit the one structured reply. */
  PEER_AUDIT_REPLY: 'peer_audit.reply',
  /**
   * Server → daemon: the account-level supervisor defaults (backend/model,
   * timeout, execution pools, ...) were just saved in PostgreSQL. Refresh the
   * in-memory/disk cache now rather than waiting for the next periodic poll.
   */
  SUPERVISOR_DEFAULTS_CHANGED: 'supervisor_defaults.changed',
  /** Web → daemon: read a Brain's effective pair concurrency limit and whether a fixed setting overrides it. */
  TASK_PAIR_GET_MAX_CONCURRENCY: 'task_pair.get_max_concurrency',
  /** Web → daemon: set a Brain's dynamic pair concurrency limit (rejected while a fixed setting overrides it). */
  TASK_PAIR_SET_MAX_CONCURRENCY: 'task_pair.set_max_concurrency',
} as const;

export type DaemonCommandType =
  typeof DAEMON_COMMAND_TYPES[keyof typeof DAEMON_COMMAND_TYPES];

export interface PeerAuditDaemonCommandPayloads {
  [DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES]: PeerAuditListCandidatesCommand;
  [DAEMON_COMMAND_TYPES.PEER_AUDIT_QUICK_START]: PeerAuditQuickStartCommand;
  [DAEMON_COMMAND_TYPES.PEER_AUDIT_CANCEL]: PeerAuditCancelCommand;
  [DAEMON_COMMAND_TYPES.PEER_AUDIT_REPLY]: PeerAuditReplyEnvelope;
}
import type {
  PeerAuditCancelCommand,
  PeerAuditListCandidatesCommand,
  PeerAuditQuickStartCommand,
  PeerAuditReplyEnvelope,
} from './peer-audit.js';
