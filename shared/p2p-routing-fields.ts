/**
 * Every top-level field on a `session.send` payload that can steer the turn at
 * something other than the session it was addressed to.
 *
 * One list, two consumers that must not drift:
 *
 *  - the daemon rejects delegation payloads carrying any of these
 *    (`DELEGATION_MIXED_P2P_FIELDS`);
 *  - the share layer scopes them, so a share recipient cannot fan work out to
 *    sessions their share does not cover.
 *
 * They drifted before. The share checker read four of these fields while the
 * daemon honoured all of them, so `p2pWorkflowLaunchEnvelope` — which carries
 * `participants[].sessionName` — reached the daemon without ever being scoped.
 * Adding a routing field to only one side is the failure mode this file exists
 * to prevent: add it HERE, and both sides pick it up.
 */
export const P2P_ROUTING_FIELDS = [
  'p2pAtTargets',
  'directTargetSession',
  'directTargetMode',
  'p2pMode',
  'p2pSessionConfig',
  'p2pWorkflowLaunchEnvelope',
  'workflowLaunchEnvelope',
  'p2pRounds',
  'p2pExtraPrompt',
  'p2pLocale',
  'p2pHopTimeoutMs',
  'p2pAdvancedPresetKey',
  'p2pAdvancedRounds',
  'p2pAdvancedRunTimeoutMinutes',
  'p2pContextReducer',
  'dedicatedExecutionRouting',
] as const;

export type P2pRoutingField = typeof P2P_ROUTING_FIELDS[number];

/**
 * Object keys whose string value names a session. Used to sweep the routing
 * fields above for targets regardless of how deeply a payload nests them.
 */
const SESSION_NAME_KEYS = new Set(['sessionname', 'session', 'targetsession', 'templatesessionname']);

/** Routing fields whose own string value is a session name rather than a mode, locale or preset key. */
const DIRECT_SESSION_NAME_FIELDS = new Set<string>(['directTargetSession']);

/**
 * The fan-out sentinel is not a session. It is already handled as unbounded
 * expansion by the caller; collecting it here would look like a routed target
 * that no share can cover and would deny bounded `__all__` sends outright.
 */
const FANOUT_SENTINEL = '__all__';

function isRoutableSessionName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== FANOUT_SENTINEL;
}

/** Depth cap: routing payloads are shallow; this only bounds hostile input. */
const MAX_SWEEP_DEPTH = 8;

/**
 * Collect every session name reachable inside a routing field's value.
 *
 * Deliberately key-driven rather than shape-driven: a new envelope shape that
 * still calls its target `sessionName` is caught without this code changing.
 */
export function collectRoutedSessionNames(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > MAX_SWEEP_DEPTH || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectRoutedSessionNames(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      if (SESSION_NAME_KEYS.has(key.toLowerCase()) && isRoutableSessionName(entry)) out.add(entry.trim());
      continue;
    }
    collectRoutedSessionNames(entry, out, depth + 1);
  }
  return out;
}

/**
 * Legacy in-text routing control tokens, kept byte-identical to the daemon's
 * own regexes in `command-handler.ts` (`DISCUSS_TOKEN_RE` / `ALL_TOKEN_RE`).
 *
 * `session.send` routing does not only live in structured fields: the daemon
 * still parses `@@discuss(<session>, <mode>)` and `@@all(<mode>)` straight out
 * of the message text and fans the turn out accordingly. The share scope check
 * inspected structured fields only, so a participant sharing a single tab
 * could name any session in the store — or every session in the domain — in
 * plain text and have it run. Both forms must be scoped here.
 */
const DISCUSS_TOKEN_RE = /@@discuss\(([^,]+),\s*([^)]+)\)/g;
// Non-global on purpose: `.test()` on a /g/ regex advances lastIndex and would
// return alternating answers across calls for the same input.
const ALL_TOKEN_RE = /@@all\(([^)]+)\)/;

export interface InTextRoutingTargets {
  /** Sessions named by `@@discuss(...)`. */
  sessions: string[];
  /** True when `@@all(...)` appears — an unbounded fan-out across the domain. */
  expandsAll: boolean;
}

/**
 * Extract routing targets from a message's text.
 *
 * Deliberately does not validate modes or session existence: this is an
 * authorization input, so anything that *looks* like a target must be treated
 * as one. The daemon drops tokens naming unknown sessions; a share check that
 * did the same would let an attacker probe which sessions exist.
 */
export function extractInTextRoutingTargets(text: unknown): InTextRoutingTargets {
  if (typeof text !== 'string' || !text) return { sessions: [], expandsAll: false };
  const sessions = new Set<string>();
  for (const match of text.matchAll(DISCUSS_TOKEN_RE)) {
    const session = (match[1] ?? '').trim();
    if (isRoutableSessionName(session)) sessions.add(session);
  }
  return { sessions: [...sessions], expandsAll: ALL_TOKEN_RE.test(text) };
}

/**
 * Session names a payload routes to, swept out of the routing fields only.
 *
 * Scoped to those fields on purpose: sweeping the whole payload would pick up
 * context like `parentSession` on an ordinary send and deny it for naming a
 * session the share does not cover, which is not a routing decision at all.
 */
export function collectP2pRoutedSessionNames(msg: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of P2P_ROUTING_FIELDS) {
    const value = msg[field];
    if (value == null) continue;
    if (typeof value === 'string') {
      // Only fields that ARE a session name contribute their bare value. Most
      // routing fields hold something else entirely — `p2pMode: 'debate'`,
      // `p2pLocale`, preset keys — and treating those as session names denied
      // ordinary sends for naming a "session" that never existed.
      if (DIRECT_SESSION_NAME_FIELDS.has(field) && isRoutableSessionName(value)) names.add(value.trim());
      continue;
    }
    collectRoutedSessionNames(value, names);
  }
  return [...names];
}
