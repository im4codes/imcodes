import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONTROLLED_NODE_ENDPOINTS,
  CONTROLLED_NODE_ENDPOINTS_FILE,
  CONTROLLED_NODE_ENDPOINTS_FILE_VERSION,
  normalizeControlledNodeEndpointList,
  normalizeControlledNodeEndpointOrigin,
  type NormalizeEndpointOptions,
} from '../../shared/controlled-node-endpoints.js';

/**
 * A controlled node's server addresses (see shared/controlled-node-endpoints.ts for where an address may come from and why).
 *
 * `server-endpoints.json` sits beside the executable. It holds NO secret, so it is world-readable (0644) and kept apart from the
 * credential: a damaged or hand-edited file can never damage the credential, and an invalid file simply means "no alternates".
 */

export interface ControlledNodeEndpointState {
  version: typeof CONTROLLED_NODE_ENDPOINTS_FILE_VERSION;
  /** Set by the machine's root user (`imcodes-node set-server-url`). */
  pinned: string[];
  /** Set from the authenticated heartbeat ack. */
  advertised: string[];
  /** The last origin that authenticated; the next start begins there. */
  lastGood?: string;
  /** Origins whose server answered as another server / rejected this node's credential, with the time until which they are left alone. */
  dropped: Record<string, number>;
}

export function emptyEndpointState(): ControlledNodeEndpointState {
  return { version: CONTROLLED_NODE_ENDPOINTS_FILE_VERSION, pinned: [], advertised: [], dropped: {} };
}

export function controlledNodeEndpointsPath(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_ENDPOINTS_FILE);
}

/** Validate untrusted file content into a state; anything that does not fit is dropped, never trusted. */
export function parseEndpointState(value: unknown, options: NormalizeEndpointOptions = {}): ControlledNodeEndpointState {
  const state = emptyEndpointState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  const record = value as Record<string, unknown>;
  if (record.version !== CONTROLLED_NODE_ENDPOINTS_FILE_VERSION) return state;
  state.pinned = normalizeControlledNodeEndpointList(record.pinned, options);
  state.advertised = normalizeControlledNodeEndpointList(record.advertised, options);
  const lastGood = normalizeControlledNodeEndpointOrigin(record.lastGood, options);
  if (lastGood) state.lastGood = lastGood;
  if (record.dropped && typeof record.dropped === 'object' && !Array.isArray(record.dropped)) {
    for (const [origin, until] of Object.entries(record.dropped as Record<string, unknown>)) {
      const normalized = normalizeControlledNodeEndpointOrigin(origin, options);
      if (normalized && typeof until === 'number' && Number.isSafeInteger(until) && until > 0) state.dropped[normalized] = until;
      if (Object.keys(state.dropped).length >= CONTROLLED_NODE_ENDPOINTS.MAX_ALTERNATES * 2) break;
    }
  }
  return state;
}

/** Missing, oversized, unparseable or invalid: an empty state (the node then uses its credential's origin alone). */
export async function readEndpointState(path: string, options: NormalizeEndpointOptions = {}): Promise<ControlledNodeEndpointState> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > CONTROLLED_NODE_ENDPOINTS.FILE_MAX_BYTES) return emptyEndpointState();
    return parseEndpointState(JSON.parse(await readFile(path, 'utf8')), options);
  } catch {
    return emptyEndpointState();
  }
}

/** Atomic replace (temp file + rename), 0644: a reader never sees a torn file. */
export async function writeEndpointState(path: string, state: ControlledNodeEndpointState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export interface EndpointSelectorDeps {
  now?: () => number;
  /** Called when the persistent part of the state changed; failures are the caller's to report. */
  persist?: (state: ControlledNodeEndpointState) => void | Promise<void>;
  /** Re-reads the file so a root edit (the CLI) made while the node runs is picked up. */
  reload?: () => Promise<ControlledNodeEndpointState>;
  onRotate?: (event: { from: string; to: string; reason: string }) => void;
}

interface OriginRuntime {
  failures: number;
  rounds: number;
  cooldownUntil: number;
}

/**
 * Chooses which origin the node dials. Policy:
 *  - the candidates are the credential's origin first, then the root-pinned ones, then the server-advertised ones;
 *  - the node starts on the origin that last authenticated, and STAYS on a working origin (no flapping back to the primary);
 *  - FAILURES_BEFORE_ROTATE connection failures in a row on one origin put it on a cooldown (5 s doubling to 5 min) and move on to the
 *    next origin that is not cooling down or dropped;
 *  - an origin whose server rejected the credential (not the primary) is dropped for 24 h.
 * All time comes from the injected clock.
 */
export class ControlledNodeEndpointSelector {
  private state: ControlledNodeEndpointState;
  private readonly runtime = new Map<string, OriginRuntime>();
  private currentOrigin: string;
  private readonly now: () => number;
  private reloadedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly primary: string,
    initial: ControlledNodeEndpointState,
    private readonly deps: EndpointSelectorDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.state = initial;
    const candidates = this.candidates();
    this.currentOrigin = initial.lastGood && candidates.includes(initial.lastGood) ? initial.lastGood : primary;
  }

  /** Every origin in trial order, minus the ones currently dropped. The primary is always a candidate. */
  candidates(): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const origin of [this.primary, ...this.state.pinned, ...this.state.advertised]) {
      if (out.includes(origin)) continue;
      const until = this.state.dropped[origin];
      if (origin !== this.primary && until !== undefined && until > now) continue;
      out.push(origin);
    }
    return out;
  }

  current(): string {
    return this.currentOrigin;
  }

  private runtimeOf(origin: string): OriginRuntime {
    let entry = this.runtime.get(origin);
    if (!entry) {
      entry = { failures: 0, rounds: 0, cooldownUntil: 0 };
      this.runtime.set(origin, entry);
    }
    return entry;
  }

  /** A connection attempt on the current origin failed before the server answered. Returns the origin to use next. */
  recordFailure(reason: string): string {
    const entry = this.runtimeOf(this.currentOrigin);
    entry.failures += 1;
    if (entry.failures < CONTROLLED_NODE_ENDPOINTS.FAILURES_BEFORE_ROTATE) return this.currentOrigin;
    entry.failures = 0;
    entry.rounds += 1;
    const cooldown = Math.min(
      CONTROLLED_NODE_ENDPOINTS.COOLDOWN_BASE_MS * 2 ** (entry.rounds - 1),
      CONTROLLED_NODE_ENDPOINTS.COOLDOWN_MAX_MS,
    );
    entry.cooldownUntil = this.now() + cooldown;
    this.rotateFrom(reason);
    return this.currentOrigin;
  }

  private rotateFrom(reason: string): void {
    const candidates = this.candidates();
    if (candidates.length < 2) return;
    const now = this.now();
    const start = candidates.indexOf(this.currentOrigin);
    // The next origin in order that is not cooling down; if every one is, the one whose cooldown ends first.
    let best: string | null = null;
    let bestUntil = Number.POSITIVE_INFINITY;
    for (let step = 1; step <= candidates.length; step += 1) {
      const origin = candidates[(start + step) % candidates.length]!;
      const until = this.runtimeOf(origin).cooldownUntil;
      if (until <= now) { best = origin; break; }
      if (until < bestUntil) { best = origin; bestUntil = until; }
    }
    if (best && best !== this.currentOrigin) {
      const from = this.currentOrigin;
      this.currentOrigin = best;
      this.deps.onRotate?.({ from, to: best, reason });
    }
  }

  /** The server answered with an authenticated ack on the current origin. */
  recordSuccess(): void {
    const entry = this.runtimeOf(this.currentOrigin);
    entry.failures = 0;
    entry.rounds = 0;
    entry.cooldownUntil = 0;
    if (this.state.lastGood !== this.currentOrigin || this.state.dropped[this.currentOrigin] !== undefined) {
      this.state = { ...this.state, lastGood: this.currentOrigin, dropped: withoutKey(this.state.dropped, this.currentOrigin) };
      this.persist();
    }
  }

  /** The current origin's server rejected this node's credential or answered as another server: leave it alone for a day (never the primary). */
  recordRejected(reason: string): string {
    if (this.currentOrigin === this.primary) return this.currentOrigin;
    this.state = {
      ...this.state,
      dropped: { ...this.state.dropped, [this.currentOrigin]: this.now() + CONTROLLED_NODE_ENDPOINTS.MISMATCH_DROP_MS },
    };
    if (this.state.lastGood === this.currentOrigin) {
      this.state = { ...this.state, lastGood: undefined };
      delete this.state.lastGood;
    }
    this.persist();
    const from = this.currentOrigin;
    this.currentOrigin = this.primary;
    this.deps.onRotate?.({ from, to: this.primary, reason });
    return this.currentOrigin;
  }

  /** The origins the authenticated server advertises (already-trusted source). */
  setAdvertised(origins: readonly string[]): void {
    const next = normalizeControlledNodeEndpointList(origins);
    if (sameList(next, this.state.advertised)) return;
    this.state = { ...this.state, advertised: next };
    this.persist();
  }

  /** Picks up the root-pinned list from disk at most every 30 s (a CLI edit while the node runs). */
  async refreshPinned(): Promise<void> {
    const now = this.now();
    if (!this.deps.reload || now - this.reloadedAt < 30_000) return;
    this.reloadedAt = now;
    try {
      const fresh = await this.deps.reload();
      if (!sameList(fresh.pinned, this.state.pinned)) this.state = { ...this.state, pinned: fresh.pinned };
    } catch {
      // keep the list we have
    }
  }

  snapshot(): ControlledNodeEndpointState {
    return this.state;
  }

  private persist(): void {
    try {
      void Promise.resolve(this.deps.persist?.(this.state)).catch(() => {});
    } catch {
      // a failed write must never affect the connection
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function withoutKey(record: Record<string, number>, key: string): Record<string, number> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/**
 * Add (or remove) a root-pinned origin in the file. Used by `imcodes-node set-server-url`; the origin must pass the same validation
 * as an enrollment address. Returns the resulting pinned list.
 */
export async function updatePinnedEndpoints(
  path: string,
  change: { add?: string; remove?: string; clear?: boolean },
  options: NormalizeEndpointOptions = {},
): Promise<string[]> {
  const state = await readEndpointState(path, options);
  let pinned = state.pinned;
  if (change.clear) pinned = [];
  if (change.add !== undefined) {
    const origin = normalizeControlledNodeEndpointOrigin(change.add, options);
    if (!origin) throw new Error('server_url_must_be_an_https_origin');
    if (!pinned.includes(origin)) pinned = [...pinned, origin].slice(0, CONTROLLED_NODE_ENDPOINTS.MAX_ALTERNATES);
  }
  if (change.remove !== undefined) {
    const origin = normalizeControlledNodeEndpointOrigin(change.remove, options);
    pinned = pinned.filter((entry) => entry !== origin);
  }
  await writeEndpointState(path, { ...state, pinned });
  return pinned;
}
