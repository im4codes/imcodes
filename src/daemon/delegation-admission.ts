/**
 * Delegation admission: the ONE place that decides whether work may be handed
 * to a session.
 *
 * WHY IT IS A SERVICE AND NOT A CHECK INSIDE `send-tool`
 *
 * The gate first lived inside `dispatchSendMessage`, which made it look
 * complete: `send_message`, `/send` hooks and cron all routed through there.
 * But the P2P orchestrator calls `createExecutionClone` DIRECTLY -- it never
 * touches the send tool -- so the single busiest producer of delegated work
 * walked straight past the gate. A rule enforced at one caller is not a rule;
 * it is a habit that the next caller does not inherit.
 *
 * So the decision lives here, every producer imports it, and there is
 * deliberately no second implementation to drift.
 *
 * TWO REFUSALS, NOT ONE
 *
 * A quota limit and a dead session both mean "not this target", but they mean
 * opposite things about WHEN to come back. A limit has a reset time, so waiting
 * is right. An unavailable session has no such clock, so waiting on a quota
 * schedule either hammers something that crashed or parks real work behind a
 * reset that was never going to help. They are reported as distinct machine
 * reasons for that reason alone.
 */

import {
  DELEGATION_AVAILABILITY,
  resolveDelegationTargets,
  selectDelegationAlternatives,
  type DelegationAlternative,
  type DelegationTargetAvailability,
  type DelegationTargetInput,
} from '../../shared/delegation-availability.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  isDiscoverableInterAgentSession,
  resolveEffectiveProjectName,
  resolveRuntimeScope,
} from '../../shared/session-scope.js';
import { isExecutionClone } from './execution-clone.js';
import type { SessionRecord } from '../store/session-store.js';

/** Minimal caller identity the authorized-candidate resolver needs. */
export interface DelegationCallerScope {
  userId: string;
  sessionName: string | null;
  projectName: string | null;
  projectRoot: string | null;
}

/**
 * The sessions a caller is actually permitted to be told about.
 *
 * THE ONE authorized-candidate resolver. It lives here rather than inside the
 * send tool because the P2P orchestrator needs the identical answer, and when
 * it had to approximate one for itself it filtered on project name alone --
 * so a refusal handed the orchestrator its OWN session and a deliberately
 * hidden execution clone as things to try instead.
 *
 * Each clause removes something a caller must not be handed:
 *   * `stopped` -- cannot take work at all;
 *   * the caller itself -- suggesting you delegate to yourself is a loop;
 *   * execution clones -- ephemeral internals, never addressable;
 *   * non-discoverable sessions -- deliberately hidden from inter-agent view;
 *   * a different effective project -- outside the caller's scope entirely.
 *
 * Quota EVIDENCE stays account-wide and crosses all of these boundaries; only
 * the SUGGESTION list is constrained.
 */
export function authorizedDelegationCandidates(
  caller: DelegationCallerScope,
  allSessions: readonly SessionRecord[],
): SessionRecord[] {
  const callerProjectName = resolveRuntimeScope(caller, allSessions as SessionRecord[]).projectName;
  return allSessions.filter((s) => (
    s.state !== 'stopped'
    && s.name !== caller.sessionName
    && !isExecutionClone(s)
    && isDiscoverableInterAgentSession(s)
    && resolveEffectiveProjectName(s, allSessions as SessionRecord[]) === callerProjectName
  ));
}

/** Machine reasons this service may refuse with. */
export const DELEGATION_ADMISSION_REASONS = Object.freeze({
  TARGET_LIMITED: MCP_ERROR_REASONS.TARGET_LIMITED,
  TARGET_UNAVAILABLE: MCP_ERROR_REASONS.TARGET_UNAVAILABLE,
} as const);

export type DelegationAdmissionReason =
  typeof DELEGATION_ADMISSION_REASONS[keyof typeof DELEGATION_ADMISSION_REASONS];

export interface DelegationBlockedTarget {
  target: string;
  reason: DelegationAdmissionReason;
  limitGroup: string;
  limitedAt?: number;
  retryAt?: number;
  limitReason?: DelegationTargetAvailability['reason'];
  /** Runtime availability that produced the refusal, for reporting. */
  availability: DelegationTargetAvailability['availability'];
}

export interface DelegationRefusal {
  /** Coarsest single reason: limited wins, because it carries a retry clock. */
  reason: DelegationAdmissionReason;
  targets: DelegationBlockedTarget[];
  /** Targets the CALLER may actually use, outside every refused quota group. */
  alternatives: DelegationAlternative[];
}

export interface DelegationAdmission {
  availability: Map<string, DelegationTargetAvailability>;
  blocked: DelegationBlockedTarget[];
  dispatchable: SessionRecord[];
}

export interface DelegationAdmissionOptions {
  /**
   * This dispatch SPAWNS work rather than continuing a conversation.
   *
   * Widens the refusal to unhealthy and unresolvable targets. Messaging a
   * struggling session is often how it gets woken, so an ordinary send must
   * still be allowed to queue; a scheduler or a clone bootstrap firing into one
   * only grows a backlog nobody is draining.
   */
  newWorkload?: boolean;
}

const MAX_ALTERNATIVES = 5;

/**
 * Build the resolver's input from EVERY known session.
 *
 * Deliberately not scoped. A provider limit belongs to the upstream ACCOUNT,
 * and one account backs sessions across every project on this daemon, so
 * evidence gathered from a single project would report a limited family as
 * healthy. Scoping governs which targets may be OFFERED -- never which evidence
 * is believed.
 */
export function delegationTargetInputs(
  sessions: readonly SessionRecord[],
): DelegationTargetInput[] {
  return sessions.map((s) => ({
    key: s.name,
    agentType: s.agentType,
    sessionState: sessionDelegationState(s),
    ownLimit: s.providerLimit ?? null,
  }));
}

/**
 * Normalise a session's runtime state for the availability resolver.
 *
 * `error` maps to offline rather than unknown: a session in error cannot take
 * work, and reporting it as unknown would invite an orchestrator to try it.
 */
export function sessionDelegationState(s: SessionRecord): DelegationTargetInput['sessionState'] {
  switch (s.state) {
    case 'idle': return 'ready';
    case 'running': return 'busy';
    case 'stopped':
    case 'error': return 'offline';
    default: return 'unknown';
  }
}

/**
 * Decide which of `targets` may receive work.
 *
 * `evidenceSessions` is the full session set (account-wide quota evidence);
 * `targets` is what the caller actually wants to dispatch to.
 */
export function evaluateDelegationAdmission(
  evidenceSessions: readonly SessionRecord[],
  targets: readonly SessionRecord[],
  nowMs: number,
  options: DelegationAdmissionOptions = {},
): DelegationAdmission {
  const availability = resolveDelegationTargets(delegationTargetInputs(evidenceSessions), nowMs);
  const newWorkload = options.newWorkload === true;
  const blocked: DelegationBlockedTarget[] = [];
  const dispatchable: SessionRecord[] = [];

  for (const target of targets) {
    const resolved = availability.get(target.name);
    if (!resolved) {
      // Unresolvable is not "fine". For a new workload we hold no evidence at
      // all, and guessing healthy is the failure this feature exists to stop.
      if (newWorkload) {
        blocked.push({
          target: target.name,
          reason: DELEGATION_ADMISSION_REASONS.TARGET_UNAVAILABLE,
          limitGroup: target.agentType,
          availability: DELEGATION_AVAILABILITY.UNKNOWN,
        });
      } else {
        dispatchable.push(target);
      }
      continue;
    }
    if (resolved.availability === DELEGATION_AVAILABILITY.LIMITED) {
      blocked.push({
        target: target.name,
        reason: DELEGATION_ADMISSION_REASONS.TARGET_LIMITED,
        limitGroup: resolved.limitGroup,
        availability: resolved.availability,
        ...(resolved.limitedAt === undefined ? {} : { limitedAt: resolved.limitedAt }),
        ...(resolved.retryAt === undefined ? {} : { retryAt: resolved.retryAt }),
        ...(resolved.reason === undefined ? {} : { limitReason: resolved.reason }),
      });
      continue;
    }
    if (newWorkload && resolved.availability === DELEGATION_AVAILABILITY.OFFLINE) {
      // NOT reported as limited. An offline session has no reset time, and
      // labelling it a quota refusal would tell the caller to wait for a clock
      // that does not exist -- and would read, to an operator, as an exhausted
      // account rather than a crashed agent.
      blocked.push({
        target: target.name,
        reason: DELEGATION_ADMISSION_REASONS.TARGET_UNAVAILABLE,
        limitGroup: resolved.limitGroup,
        availability: resolved.availability,
      });
      continue;
    }
    dispatchable.push(target);
  }

  return { availability, blocked, dispatchable };
}

/**
 * Describe a refusal so the caller can re-route without parsing prose.
 *
 * `authorizedCandidates` MUST be the caller's own scoped, discoverable,
 * non-clone set. Alternatives are the one part of this payload the caller is
 * invited to act on, so sourcing them from every session on the daemon would
 * leak the existence of other projects' sessions and of hidden execution clones
 * -- and would hand back a "try this instead" the caller is not permitted to
 * address anyway. Quota EVIDENCE is account-wide; the suggestion list is not.
 */
export function buildDelegationRefusal(
  blocked: readonly DelegationBlockedTarget[],
  authorizedCandidates: readonly SessionRecord[],
  availability: Map<string, DelegationTargetAvailability>,
): DelegationRefusal {
  // ONLY a quota refusal excludes a whole family.
  //
  // `target_limited` is a property of the upstream ACCOUNT, so every sibling
  // sharing it is equally refused. `target_unavailable` is a property of ONE
  // session -- it crashed, or it is gone. Excluding its group would take a
  // perfectly healthy sibling out of the running because its neighbour fell
  // over, which is the opposite of what an alternatives list is for. The
  // unavailable target itself is already dropped, because the availability
  // filter below keeps only ready/unknown candidates.
  const blockedGroups = new Set(
    blocked
      .filter((t) => t.reason === DELEGATION_ADMISSION_REASONS.TARGET_LIMITED)
      .map((t) => t.limitGroup),
  );
  const pool: DelegationAlternative[] = authorizedCandidates
    .filter((s) => availability.has(s.name))
    .map((s) => ({
      target: s.name,
      agentType: s.agentType,
      limitGroup: availability.get(s.name)!.limitGroup,
      availability: availability.get(s.name)!.availability,
    }));
  // Excluded once per refused group, so a second limited family cannot be
  // offered as the escape from the first.
  const alternatives = [...blockedGroups]
    .reduce((acc, group) => selectDelegationAlternatives(group, acc, acc.length), pool)
    .slice(0, MAX_ALTERNATIVES);
  // `limited` wins the summary reason: it is the one that carries a retry
  // clock, so collapsing it into `unavailable` would discard the schedule.
  const reason = blocked.some((t) => t.reason === DELEGATION_ADMISSION_REASONS.TARGET_LIMITED)
    ? DELEGATION_ADMISSION_REASONS.TARGET_LIMITED
    : DELEGATION_ADMISSION_REASONS.TARGET_UNAVAILABLE;
  return { reason, targets: [...blocked], alternatives };
}

/** Thrown by producers that cannot return a structured result (orchestrators). */
export class DelegationAdmissionError extends Error {
  constructor(
    readonly reason: DelegationAdmissionReason,
    readonly refusal: DelegationRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationAdmissionError';
  }
}

/**
 * Admission for a producer that spawns work and has no structured error channel.
 *
 * Throws rather than returning, because the alternative -- proceeding and
 * reporting per-task failures -- would already have created the clone.
 */
export function assertDelegationAdmission(
  evidenceSessions: readonly SessionRecord[],
  targets: readonly SessionRecord[],
  authorizedCandidates: readonly SessionRecord[],
  nowMs: number,
  options: DelegationAdmissionOptions = {},
): void {
  const admission = evaluateDelegationAdmission(evidenceSessions, targets, nowMs, options);
  if (admission.blocked.length === 0) return;
  const refusal = buildDelegationRefusal(
    admission.blocked, authorizedCandidates, admission.availability,
  );
  const first = admission.blocked[0]!;
  throw new DelegationAdmissionError(
    refusal.reason,
    refusal,
    `${first.target}: ${first.reason}`
      + (first.retryAt === undefined ? '' : ` (retry after ${new Date(first.retryAt).toISOString()})`),
  );
}
