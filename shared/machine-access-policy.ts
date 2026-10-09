/**
 * Who may do what on a controlled device -- the ONE rule table (server admission, daemon tool gate, web hints and tests all read it).
 *
 * "Operate" used to be "execute": anyone who could see a device (the owner, an explicit share participant, and automatically EVERY
 * member of ANY group containing the machine) could run commands on it as SYSTEM/root. Operating is now split from executing:
 *
 *   EXECUTE-class action  = anything that can run code on the device, write to it, or read files off it as the node's account.
 *   VIEW-class action     = list the machine, or look without touching (list_apps, get_app_state, browser_snapshot).
 *
 *   EXECUTE-class needs ALL of:  the node's exec switch is ON  AND  the actor is the device OWNER, or an explicit per-device share row
 *   with role `participant` AND exec_granted (set by the owner only; a group never grants it, a viewer never has it)
 *   AND the turn was not started by a share participant (the owner's agent must not be a confused deputy for a request somebody
 *   else typed, even when that somebody holds a grant of their own).
 *
 * Reading files is EXECUTE-class on purpose: the node's account can read credentials, keys and browser profiles, so "read any path"
 * is a privilege escalation for whoever holds it. Loosen it here, in one place, if the owner decides otherwise.
 */
import { COMPUTER_USE_TOOLS, isReadOnlyComputerUseTool, type ComputerUseToolName } from './computer-use.js';

export const MACHINE_ACTION = {
  /** list_machines: discovery. */
  LIST: 'list',
  /** computer_use read-only tools (list_apps, get_app_state, browser_snapshot). */
  VIEW: 'view',
  /** exec_remote: a one-shot command as the node's account. */
  EXEC: 'exec',
  /** computer_use shell_session1: a command in the signed-in user's session. */
  SHELL_SESSION: 'shell_session',
  /** computer_use click / type / press / set_value / drag / browser_* that acts: GUI input can launch anything. */
  GUI_INPUT: 'gui_input',
  /** send_file_to_machine and the machine upload endpoints: writes a file. */
  FILE_SEND: 'file_send',
  /** fetch_file_from_machine and the machine fetch/handle endpoints: reads a file as the node's account. */
  FILE_FETCH: 'file_fetch',
  /** Directory browsing on the node: reconnaissance of the same files. */
  FILE_LIST: 'file_list',
} as const;
export type MachineAction = typeof MACHINE_ACTION[keyof typeof MACHINE_ACTION];

const EXECUTE_CLASS_ACTIONS: ReadonlySet<MachineAction> = new Set([
  MACHINE_ACTION.EXEC,
  MACHINE_ACTION.SHELL_SESSION,
  MACHINE_ACTION.GUI_INPUT,
  MACHINE_ACTION.FILE_SEND,
  MACHINE_ACTION.FILE_FETCH,
  MACHINE_ACTION.FILE_LIST,
]);

export function machineActionRequiresExecute(action: MachineAction): boolean {
  return EXECUTE_CLASS_ACTIONS.has(action);
}

/** computer_use is one MCP tool with many verbs: the verb decides. An unknown verb acts (allowlist of read-only ones). */
export function machineActionForComputerUseTool(tool: ComputerUseToolName | string): MachineAction {
  if ((COMPUTER_USE_TOOLS as readonly string[]).includes(tool) && isReadOnlyComputerUseTool(tool as ComputerUseToolName)) return MACHINE_ACTION.VIEW;
  if (tool === 'shell_session1') return MACHINE_ACTION.SHELL_SESSION;
  return MACHINE_ACTION.GUI_INPUT;
}

/** The audit's `source_server_id` for an action taken from the signed-in user's own browser (no source daemon). */
export const MACHINE_INTERACTIVE_SOURCE = 'interactive' as const;

/** Where the actor's access to the device comes from. */
export const MACHINE_ACCESS_SOURCE = { OWNER: 'owner', SHARE: 'share', GROUP: 'group' } as const;
export type MachineAccessSource = typeof MACHINE_ACCESS_SOURCE[keyof typeof MACHINE_ACCESS_SOURCE];

/** Why a machine action was refused. Stored in the audit; the wire keeps the existing `target_forbidden` / `exec_disabled` reasons. */
export const MACHINE_DENIAL_REASON = {
  /** No access to this device at all (or a viewer, or the node is gone). */
  NO_ACCESS: 'no_access',
  /** The node's exec switch is off. */
  EXEC_DISABLED: 'exec_disabled',
  /** The actor can operate the device but holds no execute grant (group member, share participant without the grant). */
  EXECUTE_NOT_GRANTED: 'execute_not_granted',
  /** The turn was started by a share participant: never executes, whatever the participant holds. */
  PARTICIPANT_TURN: 'participant_turn',
  /** The action is unknown to this table. */
  UNKNOWN_ACTION: 'unknown_action',
} as const;
export type MachineDenialReason = typeof MACHINE_DENIAL_REASON[keyof typeof MACHINE_DENIAL_REASON];

export interface MachineAccessSubject {
  /** null = the actor has no operate access (not the owner / participant share / group member). */
  accessRole: 'owner' | 'participant' | 'viewer' | null;
  accessSource: MachineAccessSource | null;
  /** The share row's exec_granted flag (false when there is no share row; a missing column reads false). */
  execGranted: boolean;
  /** The node's exec switch. */
  execEnabled: boolean;
  /** The request carries a share participant's turn authority (the turn was started by someone other than the owner). */
  participantTurn: boolean;
}

export type MachineActionDecision = { allowed: true } | { allowed: false; reason: MachineDenialReason };

/** The rule. Pure: callers fetch the subject from the database on EVERY action. */
export function evaluateMachineAction(subject: MachineAccessSubject, action: MachineAction): MachineActionDecision {
  if (!KNOWN_ACTIONS.has(action)) return { allowed: false, reason: MACHINE_DENIAL_REASON.UNKNOWN_ACTION };
  if (subject.accessRole !== 'owner' && subject.accessRole !== 'participant') {
    return { allowed: false, reason: MACHINE_DENIAL_REASON.NO_ACCESS };
  }
  // list_machines does not need the exec switch (a device can be listed while its exec is off).
  if (action === MACHINE_ACTION.LIST) return { allowed: true };
  if (!subject.execEnabled) return { allowed: false, reason: MACHINE_DENIAL_REASON.EXEC_DISABLED };
  if (!machineActionRequiresExecute(action)) return { allowed: true };
  if (subject.participantTurn) return { allowed: false, reason: MACHINE_DENIAL_REASON.PARTICIPANT_TURN };
  if (subject.accessSource === MACHINE_ACCESS_SOURCE.OWNER && subject.accessRole === 'owner') return { allowed: true };
  if (subject.accessSource === MACHINE_ACCESS_SOURCE.SHARE && subject.accessRole === 'participant' && subject.execGranted === true) {
    return { allowed: true };
  }
  return { allowed: false, reason: MACHINE_DENIAL_REASON.EXECUTE_NOT_GRANTED };
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(Object.values(MACHINE_ACTION));

/**
 * Rate limits for machine actions (per target device, and per actor on a device). Owners are limited too: a runaway agent loop is a
 * runaway SYSTEM command loop. Generous enough for interactive and scripted use, tight enough to stop a brute-force probe.
 */
export const MACHINE_ACTION_RATE_LIMIT = {
  WINDOW_MS: 60_000,
  PER_DEVICE: 240,
  PER_ACTOR_PER_DEVICE: 120,
  /** Denied attempts that are audited per actor+device in one window (the refusal itself is never rate limited away). */
  DENIED_AUDITS_PER_ACTOR_PER_DEVICE: 30,
} as const;
