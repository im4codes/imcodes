export const DAEMON_COMMAND_TYPES = {
  DAEMON_UPGRADE: 'daemon.upgrade',
  SERVER_DELETE: 'server.delete',
  SESSION_CANCEL: 'session.cancel',
  SESSION_EXECUTION_CLONES: 'session.execution_clones',
  SESSION_UPDATE_TRANSPORT_CONFIG: 'session.update_transport_config',
  SUBSESSION_UPDATE_TRANSPORT_CONFIG: 'subsession.update_transport_config',
  /** Server → controlled node: run a one-shot command locally (RemoteExecRequest). */
  MACHINE_EXEC: 'machine.exec',
  /** Server → controlled node: invoke one typed Computer Use tool locally. */
  COMPUTER_USE: 'computer.use',
  // ── Lightweight peer-supervision-audit control plane ──────────────────────
  /** Web → daemon: request the authoritative peer-audit candidate list. */
  PEER_AUDIT_LIST_CANDIDATES: 'peer_audit.list_candidates',
  /** Web → daemon: start a one-shot Quick peer audit against a chosen target. */
  PEER_AUDIT_QUICK_START: 'peer_audit.quick_start',
  /** Web → daemon: cancel the audited session's active peer-audit attempt. */
  PEER_AUDIT_CANCEL: 'peer_audit.cancel',
  /** Auditor → daemon (daemon-only, no terminal-key fallback): submit the one structured reply. */
  PEER_AUDIT_REPLY: 'peer_audit.reply',
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
