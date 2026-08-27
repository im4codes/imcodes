/**
 * Delegation target availability, and how a provider limit spreads.
 *
 * WHY THIS EXISTS
 *
 * An orchestrator that hands a task to a rate-limited agent gets silence, not a
 * refusal. It then waits, retries, or -- worse -- hands the next task to a
 * SIBLING on the same provider account and gets silence again. The limit is a
 * property of the account, not of the session that happened to hit it, so
 * knowing "this one is limited" is only useful if it also answers "and who else
 * shares its quota".
 *
 * THE AUTHORITY IS THE PROVIDER RUNTIME, NEVER PROSE
 *
 * Every limit recorded here must come from a machine-readable provider signal:
 * an error code, an HTTP 429, a quota-reset timestamp. An assistant SAYING it is
 * rate limited is not evidence -- models say that while quoting an error they
 * read in a log, while explaining what 429 means, or while being wrong. A
 * pipeline that believed prose could be talked into disabling a healthy agent by
 * anything that could get text into a transcript.
 *
 * A LIMIT MUST EXPIRE
 *
 * State that only ever gets set is state that permanently poisons an agent. Two
 * clearing conditions, both explicit:
 *
 *   * a healthy signal from the same provider clears it immediately, and
 *   * once `retryAt` has passed (or the bounded fallback TTL has elapsed for a
 *     provider that gave no reset time) the target returns to `unknown` so it is
 *     RE-PROBED rather than assumed well.
 *
 * `unknown` rather than `ready` is deliberate: the expiry proves the wait is
 * over, not that the quota came back.
 */

import { CLAUDE_CODE_FAMILY, CODEX_FAMILY } from './agent-types.js';
import { MCP_ERROR_REASONS } from './memory-mcp-errors.js';

/**
 * What an orchestrator may conclude about a target.
 *
 * `busy` and `limited` are different answers to different questions: busy is
 * "occupied, ask later"; limited is "the account is out, asking later on THIS
 * family will not help". Collapsing them would make an orchestrator retry into
 * a wall.
 */
export const DELEGATION_AVAILABILITY = Object.freeze({
  READY: 'ready',
  BUSY: 'busy',
  LIMITED: 'limited',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
} as const);

export type DelegationAvailability =
  typeof DELEGATION_AVAILABILITY[keyof typeof DELEGATION_AVAILABILITY];

/** Why a target is limited. Closed set: a reason is branched on, not read. */
export const DELEGATION_LIMIT_REASONS = Object.freeze({
  /** The provider returned a rate-limit code for THIS session. */
  PROVIDER_RATE_LIMITED: 'provider_rate_limited',
  /** The provider reported the quota window exhausted for THIS session. */
  PROVIDER_QUOTA_EXHAUSTED: 'provider_quota_exhausted',
  /**
   * This session is fine; a SIBLING sharing its provider account is limited.
   *
   * Distinct from the two above on purpose: it says the evidence is second
   * hand, so an operator reading a report can tell which session actually met
   * the provider.
   */
  FAMILY_LIMITED: 'family_limited',
} as const);

export type DelegationLimitReason =
  typeof DELEGATION_LIMIT_REASONS[keyof typeof DELEGATION_LIMIT_REASONS];

/**
 * `send_message` refusal when the target, or its family, is limited.
 *
 * Aliases the MCP reason rather than restating the literal: the tool result and
 * this protocol must never be able to drift into two spellings of one refusal.
 */
export const DELEGATION_TARGET_LIMITED = MCP_ERROR_REASONS.TARGET_LIMITED;

/**
 * Fallback window for a provider that reports a limit with no reset time.
 *
 * Bounded so a provider that never says "you may retry" cannot leave an agent
 * disabled for the life of the daemon.
 */
export const DELEGATION_LIMIT_FALLBACK_TTL_MS = 15 * 60_000;

/**
 * Versioned runtime notification telling an orchestrator that a delegation's
 * target became limited.
 *
 * A MARKER, not free text. The orchestrator must be able to tell a runtime fact
 * from something a model wrote, and only a fixed token it does not author can
 * do that.
 */
export const DELEGATION_TARGET_LIMITED_NOTIFICATION_MARKER =
  '<imcodes-delegation-target-limited-v1>' as const;

/**
 * How a limit was learned. Ordered by how much it can be trusted.
 *
 * Recorded on every signal so a consumer can weigh it, and so an operator can
 * tell a verdict the provider stated from one we inferred.
 */
export const PROVIDER_LIMIT_EVIDENCE_KINDS = Object.freeze({
  /** A field the provider defines: a status enum, a reset time, a 429 header. */
  PROVIDER_STRUCTURED: 'provider_structured',
  /** A typed error envelope from the provider SDK. */
  PROVIDER_ERROR_ENVELOPE: 'provider_error_envelope',
  /**
   * Vendor limit wording parsed out of a TRANSPORT ERROR ENVELOPE.
   *
   * Permitted ONLY where the provider exposes no structured field at all, and
   * only inside that provider's own adapter. It is never applied to an
   * assistant's ordinary reply: a model discussing a 429, quoting a log, or
   * simply being wrong must not be able to take an agent out of service.
   *
   * A signal of this kind carries a confidence and its raw text is neither
   * persisted nor placed in any prompt.
   */
  PROVIDER_ERROR_TEXT: 'provider_error_text',
} as const);

export type ProviderLimitEvidenceKind =
  typeof PROVIDER_LIMIT_EVIDENCE_KINDS[keyof typeof PROVIDER_LIMIT_EVIDENCE_KINDS];

/** Canonical limit state as every adapter must report it. */
export const PROVIDER_LIMIT_STATES = Object.freeze({
  LIMITED: 'limited',
  WARNING: 'warning',
  RECOVERED: 'recovered',
  UNKNOWN: 'unknown',
} as const);

export type ProviderLimitSignalState =
  typeof PROVIDER_LIMIT_STATES[keyof typeof PROVIDER_LIMIT_STATES];

/**
 * The ONE shape every provider adapter maps its vendor response into.
 *
 * The orchestration layer reads only this. Adapters own the vendor specifics --
 * there is deliberately no global pattern table, because one regex that has to
 * understand every vendor at once is a regex that will mis-read one of them.
 */
export interface ProviderLimitSignal {
  providerId: string;
  limitGroup: DelegationLimitGroup;
  state: ProviderLimitSignalState;
  /** Epoch MILLISECONDS the adapter observed this. */
  observedAt: number;
  /** Epoch MILLISECONDS the window resets, when the vendor said so. */
  retryAt?: number;
  /** Vendor-native window/scope identifier, e.g. `five_hour`. Opaque here. */
  scope?: string;
  evidenceKind: ProviderLimitEvidenceKind;
  /** Vendor-native code or status value, when there was one. */
  sourceCode?: string;
  /**
   * 0..1, and REQUIRED for `provider_error_text`.
   *
   * A parsed verdict is not the same fact as a stated one, and a consumer that
   * could not tell them apart would treat a guess as authority.
   */
  confidence?: number;
}

/**
 * What an observation means for stored state.
 *
 * `noEvidence` is a distinct outcome from `healthy`, and the distinction is
 * load-bearing: an unrecognised state must neither set a limit nor CLEAR one.
 * Folding it into `healthy` would let a provider that started emitting a new
 * value silently un-limit an agent that is still being refused.
 */
export type ProviderLimitObservation =
  | { kind: 'limited'; state: DelegationLimitState }
  | { kind: 'healthy' }
  | { kind: 'noEvidence' };

/** Minimum confidence a parsed-text signal needs before it may limit anything. */
export const PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE = 0.9;

/**
 * Bounded horizons.
 *
 * Without an upper bound a hostile or buggy frame can pin an agent out of
 * rotation forever: `retryAt: Number.MAX_VALUE` is finite and greater than now,
 * so it satisfied every earlier check. Both bounds are named so the ceiling is
 * auditable rather than implied.
 */
export const PROVIDER_LIMIT_MAX_RETRY_HORIZON_MS = 24 * 60 * 60_000;
export const PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS = 24 * 60 * 60_000;

const PROVIDER_LIMIT_STATE_VALUES: ReadonlySet<string> =
  new Set(Object.values(PROVIDER_LIMIT_STATES));
const PROVIDER_LIMIT_EVIDENCE_VALUES: ReadonlySet<string> =
  new Set(Object.values(PROVIDER_LIMIT_EVIDENCE_KINDS));

export function isProviderLimitState(value: unknown): value is ProviderLimitSignalState {
  return typeof value === 'string' && PROVIDER_LIMIT_STATE_VALUES.has(value);
}

export function isProviderLimitEvidenceKind(value: unknown): value is ProviderLimitEvidenceKind {
  return typeof value === 'string' && PROVIDER_LIMIT_EVIDENCE_VALUES.has(value);
}

/** Confidence must be a real probability: finite and within [0,1]. */
export function isProviderLimitConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A timestamp is usable only inside a named window around now. */
export function isWithinProviderLimitHorizon(
  value: unknown, nowMs: number, aheadMs: number, behindMs: number,
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return value <= nowMs + aheadMs && value >= nowMs - behindMs;
}

/**
 * Turns a canonical signal into stored state.
 *
 * Deliberately total and deliberately narrow: only `limited` produces a limit,
 * and a parsed-text signal must additionally clear the confidence bar.
 */
export function observeProviderLimitSignal(
  signal: ProviderLimitSignal | null | undefined,
  nowMs: number,
): ProviderLimitObservation {
  if (!signal || typeof signal.providerId !== 'string' || signal.providerId.length === 0) {
    return { kind: 'noEvidence' };
  }
  if (!Number.isFinite(nowMs)) return { kind: 'noEvidence' };
  // Closed sets, checked before anything is believed. An unrecognised state or
  // evidence kind is not "some other case" -- it is not evidence at all.
  if (!isProviderLimitState(signal.state)) return { kind: 'noEvidence' };
  if (!isProviderLimitEvidenceKind(signal.evidenceKind)) return { kind: 'noEvidence' };
  // Confidence, when present, must be a real probability regardless of kind.
  // `Infinity` and `Number.MAX_VALUE` both satisfied `>= 0.9` before this.
  if (signal.confidence !== undefined && !isProviderLimitConfidence(signal.confidence)) {
    return { kind: 'noEvidence' };
  }
  // ONLY an explicit recovery clears. `allowed`/`recovered` is the provider
  // stating it is serving us again; nothing weaker may erase a refusal it
  // never contradicted.
  if (signal.state === PROVIDER_LIMIT_STATES.RECOVERED) {
    // Clearing is the dangerous direction, so it needs evidence of the same
    // quality required to set: a parsed-text recovery below the confidence bar
    // cannot erase a refusal the provider never contradicted.
    if (signal.evidenceKind === PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT
      && !(isProviderLimitConfidence(signal.confidence) && signal.confidence >= PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE)) {
      return { kind: 'noEvidence' };
    }
    // The observed stamp is validated BEFORE clearing, not only on the limiting
    // path. Bounding observedAt only for `limited` left the dangerous direction
    // unguarded: a recovered frame stamped Infinity, MAX_VALUE, far-future or
    // far-past still erased a live limit, and clearing is exactly where a bad
    // timestamp does damage.
    if (!isWithinProviderLimitHorizon(
      signal.observedAt, nowMs, PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS, PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS,
    )) {
      return { kind: 'noEvidence' };
    }
    return { kind: 'healthy' };
  }
  // A WARNING neither sets nor clears.
  //
  // It says "you are approaching the cap", which is not a refusal -- so it must
  // not limit. But it is emphatically not a statement that an earlier refusal
  // is over either, and treating it as healthy was a live data-loss bug:
  // Claude emits `allowed_warning` routinely as usage climbs, so the FIRST
  // warning after a real `rejected` would wipe the limit and put the account
  // straight back into rotation while it was still being refused. The mistake
  // would have been constant rather than rare.
  if (signal.state === PROVIDER_LIMIT_STATES.WARNING) return { kind: 'noEvidence' };
  if (signal.state !== PROVIDER_LIMIT_STATES.LIMITED) return { kind: 'noEvidence' };

  if (signal.evidenceKind === PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT) {
    // A parsed verdict only counts when the adapter was sure. Below the bar it
    // is not downgraded to "healthy" -- it is simply not evidence, so it can
    // neither limit an agent nor clear an existing limit.
    if (!isProviderLimitConfidence(signal.confidence)
      || !(signal.confidence >= PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE)) return { kind: 'noEvidence' };
  }

  // retryAt must be in the future AND inside the named horizon. Anything beyond
  // it falls back to undefined, which lets the bounded fallback TTL apply
  // instead of pinning the agent out of rotation indefinitely.
  const retryAt = signal.retryAt !== undefined
    && isWithinProviderLimitHorizon(signal.retryAt, nowMs, PROVIDER_LIMIT_MAX_RETRY_HORIZON_MS, 0)
    && signal.retryAt > nowMs
    ? signal.retryAt
    : undefined;
  // observedAt likewise: a wildly skewed stamp would make the limit look
  // arbitrarily old or young to every downstream expiry calculation.
  const limitedAt = isWithinProviderLimitHorizon(
    signal.observedAt, nowMs, PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS, PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS,
  ) ? signal.observedAt : nowMs;
  return {
    kind: 'limited',
    state: {
      limitedAt,
      ...(retryAt === undefined ? {} : { retryAt }),
      reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
      agentType: signal.providerId,
      evidenceKind: signal.evidenceKind,
      ...(signal.sourceCode === undefined ? {} : { source: signal.sourceCode }),
      ...(signal.scope === undefined ? {} : { window: signal.scope }),
    },
  };
}

/** Persisted limit evidence for one session. */
export interface DelegationLimitState {
  /** Epoch ms the provider signal was observed. */
  limitedAt: number;
  /** Epoch ms the provider said the window resets, when it said so. */
  retryAt?: number;
  reason: DelegationLimitReason;
  /**
   * The agent type that met the provider.
   *
   * Kept so a family-wide conclusion can name its first-hand source rather than
   * asserting itself.
   */
  agentType: string;
  /**
   * The provider-native field the verdict came from.
   *
   * Recorded so a limit is auditable after the fact: an operator can tell a
   * limit that came from Claude's `rate_limit_event.status` apart from one that
   * came from somewhere it should not have.
   */
  source?: string;
  /** Provider-native window identifier, when the provider named one. */
  window?: string;
  /** How this limit was learned. Carried so a consumer can weigh it. */
  evidenceKind?: ProviderLimitEvidenceKind;
}

/**
 * Provider accounts that share a quota.
 *
 * Claude and Codex each have an SDK and a process form driving ONE upstream
 * account, so a limit on either applies to both -- that is the whole point of
 * the group.
 *
 * Everything else is its own group. That is not laziness: grouping two agent
 * types that do NOT share an account would take a healthy agent out of service
 * on someone else's limit, which is a worse failure than not grouping at all.
 * `opencode` in particular is multi-provider, so its SDK and process forms are
 * deliberately NOT grouped.
 */
export const DELEGATION_LIMIT_GROUPS = Object.freeze({
  CLAUDE: 'claude',
  CODEX: 'codex',
} as const);

export type DelegationLimitGroup = string;

/**
 * The quota group an agent type belongs to.
 *
 * Derived from the family constants rather than restating their members, so a
 * type added to `CLAUDE_CODE_FAMILY` is grouped without touching this file.
 */
export function delegationLimitGroup(agentType: string): DelegationLimitGroup {
  if ((CLAUDE_CODE_FAMILY as readonly string[]).includes(agentType)) {
    return DELEGATION_LIMIT_GROUPS.CLAUDE;
  }
  if ((CODEX_FAMILY as readonly string[]).includes(agentType)) {
    return DELEGATION_LIMIT_GROUPS.CODEX;
  }
  // Its own group. Stable, and never shared with an account it does not have.
  return agentType;
}

/**
 * Whether a recorded limit still applies at `nowMs`.
 *
 * Expiry is the ONLY thing this decides. A healthy provider signal clears the
 * state at the source instead of being reasoned about here, because "we have
 * not heard anything bad lately" is not evidence of recovery.
 */
/**
 * When a limit actually stops applying, in absolute time.
 *
 * THE ONE EXPIRY FUNCTION. Everything that asks "is this still in force" or
 * "which of these lasts longer" must call this: two places computing a deadline
 * their own way is how a target gets reported limited by one code path and
 * usable by another at the very same instant, and the caller then believes
 * whichever answer lets it proceed.
 *
 * The bounded fallback is a FLOOR, not merely a default for a missing value.
 * A provider advertising `retryAt` one second out would otherwise erase the
 * back-off entirely and turn a refusal into a hot retry loop, so a provider's
 * own reset time can only ever EXTEND the window, never shorten it.
 *
 * Returns `null` when there is no usable limit to expire.
 */
export function delegationLimitDeadline(
  state: DelegationLimitState | null | undefined,
): number | null {
  if (!state || !Number.isFinite(state.limitedAt)) return null;
  const fallbackEnd = state.limitedAt + DELEGATION_LIMIT_FALLBACK_TTL_MS;
  const retryAt = state.retryAt;
  if (typeof retryAt !== 'number' || !Number.isFinite(retryAt)) return fallbackEnd;
  return Math.max(retryAt, fallbackEnd);
}

export function isDelegationLimitActive(
  state: DelegationLimitState | null | undefined,
  nowMs: number,
): boolean {
  const deadline = delegationLimitDeadline(state);
  return deadline !== null && nowMs < deadline;
}

/** What a target looks like to an orchestrator, on both the list and send paths. */
export interface DelegationTargetAvailability {
  availability: DelegationAvailability;
  limitGroup: DelegationLimitGroup;
  limitedAt?: number;
  retryAt?: number;
  reason?: DelegationLimitReason;
}

/**
 * The ONE decision both `send_list_targets` and `send_message` must use.
 *
 * Shared rather than implemented twice: a list that says a target is selectable
 * and a send that refuses it -- or the reverse -- is worse than either answer
 * alone, because the orchestrator cannot tell which one to believe.
 */
export function resolveDelegationTargetAvailability(input: {
  agentType: string;
  /** The session's own runtime state, already normalised by the caller. */
  sessionState: 'ready' | 'busy' | 'offline' | 'unknown';
  /** This session's own recorded limit, if any. */
  ownLimit?: DelegationLimitState | null;
  /**
   * The strongest ACTIVE limit currently recorded anywhere in this session's
   * quota group, including its own.
   */
  groupLimit?: DelegationLimitState | null;
  nowMs: number;
}): DelegationTargetAvailability {
  const limitGroup = delegationLimitGroup(input.agentType);

  // First-hand evidence wins: this session met the provider itself.
  if (isDelegationLimitActive(input.ownLimit, input.nowMs)) {
    const own = input.ownLimit as DelegationLimitState;
    return {
      availability: DELEGATION_AVAILABILITY.LIMITED,
      limitGroup,
      limitedAt: own.limitedAt,
      // The EFFECTIVE deadline, not the raw provider field. Reporting the raw
      // value would tell a caller to retry at a moment this same module still
      // considers the target limited, so it would come back and be refused.
      retryAt: delegationLimitDeadline(own) ?? undefined,
      reason: own.reason,
    };
  }

  // Second hand: a sibling on the same account is limited, so this one will be
  // too. Reported as FAMILY_LIMITED so the report says where the evidence came
  // from rather than claiming this session saw it.
  if (isDelegationLimitActive(input.groupLimit, input.nowMs)) {
    const group = input.groupLimit as DelegationLimitState;
    return {
      availability: DELEGATION_AVAILABILITY.LIMITED,
      limitGroup,
      limitedAt: group.limitedAt,
      retryAt: delegationLimitDeadline(group) ?? undefined,
      reason: DELEGATION_LIMIT_REASONS.FAMILY_LIMITED,
    };
  }

  // An EXPIRED limit does not mean recovered. The wait is over; whether the
  // quota came back is unproven until the provider says so, so the target is
  // offered as `unknown` rather than `ready`.
  const expired = input.ownLimit ?? input.groupLimit ?? null;
  if (expired && Number.isFinite(expired.limitedAt)
    && input.sessionState === 'ready') {
    return { availability: DELEGATION_AVAILABILITY.UNKNOWN, limitGroup };
  }

  switch (input.sessionState) {
    case 'ready':
      return { availability: DELEGATION_AVAILABILITY.READY, limitGroup };
    case 'busy':
      return { availability: DELEGATION_AVAILABILITY.BUSY, limitGroup };
    case 'offline':
      return { availability: DELEGATION_AVAILABILITY.OFFLINE, limitGroup };
    default:
      return { availability: DELEGATION_AVAILABILITY.UNKNOWN, limitGroup };
  }
}

/** A target an orchestrator may use instead of a limited one. */
export interface DelegationAlternative {
  target: string;
  agentType: string;
  limitGroup: DelegationLimitGroup;
  availability: DelegationAvailability;
}

/**
 * Picks alternatives from a DIFFERENT quota group.
 *
 * Same-group targets are excluded even when they look healthy: they share the
 * account that just refused, so offering one is offering the same wall.
 */
export function selectDelegationAlternatives(
  limitedGroup: DelegationLimitGroup,
  candidates: readonly DelegationAlternative[],
  limit = 5,
): DelegationAlternative[] {
  return candidates
    .filter((candidate) => candidate.limitGroup !== limitedGroup)
    .filter((candidate) => candidate.availability === DELEGATION_AVAILABILITY.READY
      || candidate.availability === DELEGATION_AVAILABILITY.UNKNOWN)
    .slice(0, Math.max(0, limit));
}

/** One session as the availability resolver needs to see it. */
export interface DelegationTargetInput {
  /** Stable key the caller uses to read the answer back out. */
  key: string;
  agentType: string;
  sessionState: 'ready' | 'busy' | 'offline' | 'unknown';
  /** This session's own persisted limit, if any. */
  ownLimit?: DelegationLimitState | null;
}

/**
 * Resolve availability for a WHOLE candidate set at once.
 *
 * THE SINGLE DECISION SOURCE. `send_list_targets` and `send_message` must call
 * this same function: a list that offers a target which the very next send then
 * refuses is worse than either answer alone, because the orchestrator has no
 * way to tell which one to believe and will usually retry the one that lies.
 *
 * Group evidence is aggregated across EVERY input, which is why this takes the
 * whole set rather than resolving one target at a time. A limit lives on the
 * session that happened to meet the provider, so asking only about the target
 * would miss the sibling holding the evidence -- and any caller that filtered
 * or paginated first would silently report a limited family as healthy.
 */
export function resolveDelegationTargets(
  inputs: readonly DelegationTargetInput[],
  nowMs: number,
): Map<string, DelegationTargetAvailability> {
  // Strongest ACTIVE limit per quota group. "Strongest" is the one that stays
  // active LONGEST, not the most recent: a newer limit with a short window must
  // not hide an older one that runs past it, or the family would be reported
  // usable while still refused.
  const groupLimits = new Map<DelegationLimitGroup, DelegationLimitState>();
  for (const input of inputs) {
    const limit = input.ownLimit;
    if (!isDelegationLimitActive(limit, nowMs)) continue;
    const active = limit as DelegationLimitState;
    const group = delegationLimitGroup(input.agentType);
    const incumbent = groupLimits.get(group);
    if (!incumbent || (delegationLimitDeadline(active) ?? 0) > (delegationLimitDeadline(incumbent) ?? 0)) {
      groupLimits.set(group, active);
    }
  }

  const resolved = new Map<string, DelegationTargetAvailability>();
  for (const input of inputs) {
    resolved.set(input.key, resolveDelegationTargetAvailability({
      agentType: input.agentType,
      sessionState: input.sessionState,
      ownLimit: input.ownLimit ?? null,
      groupLimit: groupLimits.get(delegationLimitGroup(input.agentType)) ?? null,
      nowMs,
    }));
  }
  return resolved;
}
